import 'server-only'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, asc, desc, eq, inArray, like, notExists, or, sql } from 'drizzle-orm'
import { getDatabase } from '@/backstage/db/database'
import { entries, entryTags, entryTaxonomy, importIdMap, monsterEntries, tags } from '@/backstage/db/schema'
import { attachEntryTagsByName, findOrCreateTag, tagsForEntries } from './tag.service'
import { listDesignAxes, listDesignSpaces } from './space.service'
import { ENTRY_STATUSES, isDomainCode, type DomainCode, type EntryDetail, type EntryStatus, type EntrySummary, type ImageSource, type MonsterExtension, type TagOrigin, type TaxonomyDimensionKey } from '@/types/atlas'

const MAX_NAME = 120
const MAX_URL = 2000
/** 观察与判断都要能写长 —— 但仍然有上限，防止误粘整篇文章进来。 */
const MAX_TEXT = 8000

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function mapEntry(
  row: typeof entries.$inferSelect,
  tagList: EntrySummary['tags'],
  taxonomy: EntrySummary['taxonomy'],
): EntrySummary {
  return {
    ...row,
    domain: row.domain as DomainCode,
    status: row.status as EntryStatus,
    imageSource: row.imageSource as ImageSource,
    // ⚠️ `notes` 是已废弃的别名。读的时候 observed 优先，为空才回退到 notes ——
    // 这样即使有行是补列之前写的、observed 还是空，界面也不会突然空掉。
    observed: row.observed || row.notes || '',
    tags: tagList,
    taxonomy,
  }
}

function assertStatus(value: unknown): EntryStatus {
  if (typeof value === 'string' && (ENTRY_STATUSES as string[]).includes(value)) return value as EntryStatus
  throw new Error(`状态只能是 ${ENTRY_STATUSES.join(' / ')}`)
}

function assertDomain(value: unknown): DomainCode {
  const code = String(value ?? '').trim()
  if (!isDomainCode(code)) throw new Error(`未知的采集类型：${code || '空'}`)
  return code
}

/** 来源必须只给 http/https —— 这个字段是强制的，所以要在写入口就挡住非法值。 */
function assertSourceUrl(value: unknown): string {
  const url = String(value ?? '').trim()
  if (!url) throw new Error('必须填一个来源链接 —— 没有出处的东西不进 Atlas')
  if (url.length > MAX_URL) throw new Error(`来源链接超过 ${MAX_URL} 字符`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('来源链接不是合法的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('来源链接只能是 http 或 https')
  return url
}

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

/**
 * 校验 imagePath 是「media 根下的相对路径」。
 *
 * ⚠️ 这条检查必须在**写入时**做，不能只靠读取时的 resolveMediaPath。
 * 读路径抛错只是让坏条目显示不出图；写路径放过，坏字符串就永久留在 db 里，
 * 之后每次读都报错，且用户不知道自己存了什么。
 * 判据：不允许绝对路径、不允许盘符、不允许任何 `..` 段。
 *
 * ⚠️ v0.2 起允许为空 —— 通用化后必然有不以图为中心的采集类型，
 * 强制图片会挡住它们。
 */
function assertImagePath(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (raw.length > 400) throw new Error('图片路径过长')
  if (path.isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\')) throw new Error('图片路径必须是 media 下的相对路径，不能是绝对路径')
  if (/^[a-zA-Z]:/.test(raw)) throw new Error('图片路径不能带盘符')
  const segments = raw.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) throw new Error('图片路径不能包含 ..')
  if (segments.some((segment) => segment === '')) throw new Error('图片路径格式不对')
  return raw
}

function clipList(value: unknown, maxItems = 12): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? parseList(value) : []
  return [...new Set(list.map((item) => clip(item, 40)).filter(Boolean))].slice(0, maxItems)
}

export type CreateEntryInput = {
  domain: DomainCode
  name?: string
  sourceUrl: string
  sourceTitle?: string
  sourceGame?: string
  /** 相对 media 根的路径。可空。 */
  imagePath?: string
  imageSource?: ImageSource
  originalName?: string
  /** 我看到了什么（客观）。 */
  observed?: string
  /** 我认为它为什么成立（主观）。 */
  read?: string
  /** 我为什么留着它。 */
  worthwhileBecause?: string
  /** @deprecated 合并到 observed。仅保留供旧调用方与导入包兼容。 */
  notes?: string
  status?: EntryStatus
  tagNames?: string[]
  /** 部分 Record，只写打过的维度。没给的维度不入库。 */
  taxonomy?: Partial<Record<string, number>>
  /** ⭐ 坐标写到哪个空间。默认「我的」。 */
  taxonomySpaceId?: string
  /** monster 专属结构化字段。 */
  extension?: Partial<Omit<MonsterExtension, 'entryId'>>
}

export type UpdateEntryInput = Partial<Omit<CreateEntryInput, 'imagePath' | 'domain'>> & {
  imagePath?: string
  /**
   * ⚠️ 改 domain 是**换库**不是改字段 —— 扩展表会跟着换，taxonomy 维度集合
   * 也会换。所以它不在 UpdateEntryInput 里，要单独调changeDomain。
   */
}

/**
 * 批量读坐标。**按空间分组** —— 一个 entry 在每个空间下各有一组独立坐标，
 * 所以返回值是 `{ entryId → { spaceId → { 维度key → score } } }`。
 *
 * ⚠️ 以前是一维的（entryId → {key → score}），那时只有一个空间。现在必须分层：
 * 不分层的话「原作的移动性」和「我的移动性」会互相覆盖 —— 那正是
 * designSpaces 的注释里要避免的那个歧义。
 *
 * ⚠️ **默认只读「我的」空间**给卡片用（`readSpaceId`），而不是把两个空间的
 * 坐标混在一起返回 —— 卡片上那个小圆点是「我评过几条轴」，把原作的分数算
 * 进去会让「我到底评没评过」变得不可答。
 */
async function taxonomyForEntries(
  ids: string[],
  readSpaceId?: string,
): Promise<Map<string, Partial<Record<TaxonomyDimensionKey, number>>>> {
  const map = new Map<string, Partial<Record<TaxonomyDimensionKey, number>>>()
  if (ids.length === 0) return map
  const db = await getDatabase()
  // ⚠️ 传了 readSpaceId 就只取那个空间；没传就**全部取回并合并** ——
  // 合并只在调用方明确要「跨空间总览」时才对，列表页走的是带 spaceId 的路径。
  const rows = readSpaceId
    ? await db
        .select({
          entryId: entryTaxonomy.entryId,
          spaceId: entryTaxonomy.spaceId,
          dimensionKey: entryTaxonomy.dimensionKey,
          score: entryTaxonomy.score,
        })
        .from(entryTaxonomy)
        .where(and(inArray(entryTaxonomy.entryId, ids), eq(entryTaxonomy.spaceId, readSpaceId)))
    : await db
        .select({
          entryId: entryTaxonomy.entryId,
          spaceId: entryTaxonomy.spaceId,
          dimensionKey: entryTaxonomy.dimensionKey,
          score: entryTaxonomy.score,
        })
        .from(entryTaxonomy)
        .where(inArray(entryTaxonomy.entryId, ids))
  for (const row of rows) {
    const bucket = map.get(row.entryId) ?? {}
    bucket[row.dimensionKey as TaxonomyDimensionKey] = row.score
    map.set(row.entryId, bucket)
  }
  return map
}

/**
 * 某条记录在**全部空间**下的坐标。导出用。
 *
 * ⚠️ **key 用空间的 `code` 而不是 id** —— id 是本地数据（另一台机器上不同），
 * 而导出包要能跨机器搬。导出流程里直接拿这个结果写进 manifest，中间不转换：
 * 多一次转换就多一处可能把 id 漏进去的地方，而那种错误在导入时才显形，
 * 症状是「导入了但坐标全丢」。
 */
export async function allScoresOf(entryId: string): Promise<Record<string, Record<string, number>>> {
  const db = await getDatabase()
  const [rows, spaces] = await Promise.all([
    db
      .select({ spaceId: entryTaxonomy.spaceId, dimensionKey: entryTaxonomy.dimensionKey, score: entryTaxonomy.score })
      .from(entryTaxonomy)
      .where(eq(entryTaxonomy.entryId, entryId)),
    listDesignSpaces(),
  ])
  const codeOf = new Map(spaces.map((space) => [space.id, space.code]))
  const result: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    // ⚠️ 认不出的 spaceId 直接跳过。留着会造出一个「没有对应空间定义」的
    // 坐标分组，导入端会把它当垃圾空间处理 —— 而那不如现在就不导出。
    const code = codeOf.get(row.spaceId)
    if (!code) continue
    const bucket = result[code] ?? {}
    bucket[row.dimensionKey] = row.score
    result[code] = bucket
  }
  return result
}

/** 某个 entry 在指定空间下的全部坐标。详情页切空间时用它。 */
export async function taxonomyOfSpace(entryId: string, spaceId: string): Promise<Partial<Record<string, number>>> {
  const db = await getDatabase()
  const rows = await db
    .select({ dimensionKey: entryTaxonomy.dimensionKey, score: entryTaxonomy.score })
    .from(entryTaxonomy)
    .where(and(eq(entryTaxonomy.entryId, entryId), eq(entryTaxonomy.spaceId, spaceId)))
  const result: Record<string, number> = {}
  for (const row of rows) result[row.dimensionKey] = row.score
  return result
}

export async function getEntryDetail(id: string, spaceId = 'space-mine'): Promise<EntryDetail> {
  const db = await getDatabase()
  const [row] = await db.select().from(entries).where(eq(entries.id, id)).limit(1)
  if (!row) throw new Error('条目不存在')

  const [tagMap, taxonomyMap] = await Promise.all([tagsForEntries([id]), taxonomyForEntries([id], spaceId)])

  /**
   * domain 扩展行。2026-10-06 起 monster 域的扩展表**只剩 entryId**
   * （四个行为字段已砍，见 db/schema.ts 的说明），所以这里只判断「这条
   * 属于 monster 库」，不再拼任何结构化内容。
   *
   * ⚠️ 保留这一层的意义是**分流标记**：将来 monster 真的需要某个
   * 「taxonomy 与自由文本都表达不了」的字段时，扩展行就是它的落点。
   */
  let extension: MonsterExtension | null = null
  if (row.domain === 'monster') {
    const [ext] = await db.select().from(monsterEntries).where(eq(monsterEntries.entryId, id)).limit(1)
    extension = ext ? { entryId: ext.entryId } : null
  }

  return {
    ...mapEntry(row, tagMap.get(id) ?? [], taxonomyMap.get(id) ?? {}),
    extension,
  }
}

/** 兼容旧调用点：拿详情但只要摘要字段。 */
export async function getEntry(id: string): Promise<EntrySummary> {
  const { extension: _extension, ...summary } = await getEntryDetail(id)
  return summary
}

export type ListFilter = {
  domain?: DomainCode
  status?: EntryStatus
  /** 同时命中所有 tag 才算 —— 「flying + small」用这个。 */
  tagNames?: string[]
  /** 命中任意 tag 就算。 */
  anyTagNames?: string[]
  /** 只看 origin 为指定值的tag。系统 tag 可按 ruleId 整批查。 */
  origin?: TagOrigin
  ruleId?: string
  /** 只看没有任何标签的条目（tags 不强制，靠这个视图补欠账）。 */
  untagged?: boolean
  /** 搜 name 与 notes。 */
  q?: string
  /**
   * ⭐ 读哪个空间的坐标（2026-10-06）。默认「我的」。
   * ⚠️ 不是「读全部」—— 那会把不同空间的同名维度混成一份，
   * 而卡片/列表要回答的是「我评过几条轴」。
   */
  spaceId?: string
  limit?: number
  offset?: number
}

/**
 * 列表查询。
 *
 * ⚠️ 全部只查 entries 一张表 —— Catalog 跨 domain 不需要 join 扩展表。
 * 卡片上要显示的 taxonomy 走单独一次 inArray 批量读，那也是通用表的查询。
 *
 * ⚠️ tag筛选走子查询而不是 join 后group —— join 后去重会把不带 tag 的条目
 * 一起吞掉（INNER JOIN 的经典坑）。AND 语义用 `IN (子查询)` 表达，
 * 一行就能保证「同时命中所有指定 tag」。
 */
export async function listEntries(filter: ListFilter = {}): Promise<EntrySummary[]> {
  const db = await getDatabase()
  const conditions = []

  if (filter.domain) conditions.push(eq(entries.domain, filter.domain))
  if (filter.status) conditions.push(eq(entries.status, filter.status))

  // ⚠️ 未打标用 `NOT EXISTS` 而不是 `NOT IN`—— `id NOT IN (子查询)` 在子查询
  // 结果含 NULL 时会整体返回空集，永远查不出东西。`NOT EXISTS` 按行判断，
  // 天然没有这个坑。
  if (filter.untagged) {
    conditions.push(notExists(db.select({ entryId: entryTags.entryId }).from(entryTags).where(eq(entryTags.entryId, entries.id))))
  }

  if (filter.tagNames && filter.tagNames.length > 0) {
    // 选了「未打标」又选了具体 tag，逻辑上互斥 —— 明确说清，别静默返回空集。
    if (filter.untagged) throw new Error('不能同时选「未打标」和具体标签')
    for (const name of filter.tagNames) {
      const trimmed = name.trim()
      if (!trimmed) continue
      const sub = db
        .select({ entryId: entryTags.entryId })
        .from(entryTags)
        .innerJoin(tags, eq(tags.id, entryTags.tagId))
        .where(eq(tags.name, trimmed))
      conditions.push(inArray(entries.id, sub))
    }
  }

  if (filter.anyTagNames && filter.anyTagNames.length > 0) {
    const names = filter.anyTagNames.map((item) => item.trim()).filter(Boolean)
    if (names.length > 0) {
      const sub = db
        .select({ entryId: entryTags.entryId })
        .from(entryTags)
        .innerJoin(tags, eq(tags.id, entryTags.tagId))
        .where(inArray(tags.name, names))
      conditions.push(inArray(entries.id, sub))
    }
  }

  if (filter.origin) {
    const sub = db
      .select({ entryId: entryTags.entryId })
      .from(entryTags)
      .where(filter.ruleId ? and(eq(entryTags.origin, filter.origin), eq(entryTags.ruleId, filter.ruleId)) : eq(entryTags.origin, filter.origin))
    conditions.push(inArray(entries.id, sub))
  }

  if (filter.q?.trim()) {
    const needle = `%${filter.q.trim()}%`
    // ⚠️ 搜 observed / read / worthwhileBecause 三个字段，不搜 notes ——
    // notes 是已退休的别名，搜它等于让旧内容以「搜索命中」的形式复活，
    // 而用户以为搜的是新字段。
    conditions.push(
      or(
        like(entries.name, needle),
        like(entries.observed, needle),
        like(entries.read, needle),
        like(entries.worthwhileBecause, needle),
        like(entries.sourceGame, needle),
      ),
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined
  const limit = Math.min(Math.max(filter.limit ?? 60, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)

  const rows = await db
    .select()
    .from(entries)
    .where(where)
    .orderBy(desc(entries.createdAt))
    .limit(limit)
    .offset(offset)

  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  // ⚠️ 列表只读「我的」空间的坐标。卡片上那个小圆点是「我评过几条轴」，
  // 混进原作的分数会让「我到底评过没有」变得不可答。
  const [tagMap, taxonomyMap] = await Promise.all([
    tagsForEntries(ids),
    taxonomyForEntries(ids, filter.spaceId ?? 'space-mine'),
  ])
  return rows.map((row) => mapEntry(row, tagMap.get(row.id) ?? [], taxonomyMap.get(row.id) ?? {}))
}

export async function countEntries(filter: ListFilter = {}): Promise<number> {
  const rows = await listEntries({ ...filter, limit: 500, offset: 0 })
  // v0 的量级（几百条）下这个近似是准的；上千条之后再换 count 查询。
  return rows.length
}

/**
 * 采集入口。
 *
 * ⚠️ 强制字段只剩一项：sourceUrl。imagePath 从 v0.2 起可空 —— 通用化后
 * 必然有不以图为中心的采集类型。tags 与 taxonomy **都不强制**。
 *
 * 这是 2026-10-06 的裁定：tag 强制会把「先存下来、标签回头补」变成
 * 「先想好再存」—— 那正是 v0 要消除的摩擦。
 *
 * 代价是会出现没标签的孤儿条目，配套是「未打标」筛选（`untagged: true`）：
 * 不靠入口拦住，而靠一个专门的视图把欠账摊开让人补。
 * 入口拦 = 每次采集都摩擦；事后可查 = 摩擦集中在真正该补的时候。
 */
export async function createEntry(input: CreateEntryInput): Promise<EntrySummary> {
  const domain = assertDomain(input.domain)
  const sourceUrl = assertSourceUrl(input.sourceUrl)
  const imagePath = assertImagePath(input.imagePath)

  const db = await getDatabase()
  const now = new Date().toISOString()
  // id 前缀带 domain 短码 —— 目录名还是这个 id，肉眼扫 media/ 能看出是哪一类的。
  const id = `${domain.slice(0, 2)}-${nanoid(10)}`
  // tags 可空 —— attachEntryTagsByName 传空数组会直接返回，不写关系行。
  const tagNames = (input.tagNames ?? []).map((item) => clip(item, 40)).filter(Boolean)

  await db.insert(entries).values({
    id,
    domain,
    name: clip(input.name, MAX_NAME),
    sourceUrl,
    sourceTitle: clip(input.sourceTitle, MAX_NAME),
    sourceGame: clip(input.sourceGame, MAX_NAME),
    imagePath,
    imageSource: input.imageSource === 'paste' ? 'paste' : 'file',
    originalName: clip(input.originalName, MAX_NAME),
    // ⚠️ observed 同时接受 notes 是为了兼容旧调用方（导入包、脚本）。
    // observed 优先 —— 两者都给时以 observed 为准，不做合并。
    observed: clip(input.observed ?? input.notes, MAX_TEXT),
    read: clip(input.read, MAX_TEXT),
    worthwhileBecause: clip(input.worthwhileBecause, MAX_TEXT),
    status: input.status ? assertStatus(input.status) : 'inbox',
    createdAt: now,
    updatedAt: now,
  })

  if (domain === 'monster') {
    await db.insert(monsterEntries).values({ entryId: id })
  }

  // attachEntryTagsByName 是「只加不删」的合并语义 —— 它内部调
  // setEntryTags 时只替换 user 那一批，系统 tag 原样保留。
  await attachEntryTagsByName(id, tagNames)
  await setTaxonomy(id, input.taxonomy ?? {}, input.taxonomySpaceId ?? 'space-mine')
  return getEntry(id)
}

export async function updateEntry(id: string, input: UpdateEntryInput): Promise<EntrySummary> {
  const current = await getEntryDetail(id)
  const db = await getDatabase()
  const updates: Partial<typeof entries.$inferInsert> = { updatedAt: new Date().toISOString() }

  if (input.name !== undefined) updates.name = clip(input.name, MAX_NAME)
  if (input.sourceUrl !== undefined) updates.sourceUrl = assertSourceUrl(input.sourceUrl)
  if (input.sourceTitle !== undefined) updates.sourceTitle = clip(input.sourceTitle, MAX_NAME)
  if (input.sourceGame !== undefined) updates.sourceGame = clip(input.sourceGame, MAX_NAME)
  if (input.imagePath !== undefined) updates.imagePath = assertImagePath(input.imagePath)
  if (input.imageSource !== undefined) updates.imageSource = input.imageSource === 'paste' ? 'paste' : 'file'
  if (input.originalName !== undefined) updates.originalName = clip(input.originalName, MAX_NAME)
  // ⚠️ 改 observed 时同步清掉 notes —— 那个别名留着旧值会导致下次读时
  // 出现「我明明改了却没变」的错觉（读的是 observed，但界面对比的是 notes）。
  if (input.observed !== undefined) {
    updates.observed = clip(input.observed, MAX_TEXT)
    updates.notes = ''
  } else if (input.notes !== undefined) {
    // 旧调用方（导入包）传notes：走 observed，让别名自然退休。
    updates.observed = clip(input.notes, MAX_TEXT)
    updates.notes = ''
  }
  if (input.read !== undefined) updates.read = clip(input.read, MAX_TEXT)
  if (input.worthwhileBecause !== undefined) updates.worthwhileBecause = clip(input.worthwhileBecause, MAX_TEXT)
  if (input.status !== undefined) updates.status = assertStatus(input.status)

  await db.update(entries).set(updates).where(eq(entries.id, id))

  if (input.tagNames !== undefined) {
    // ⚠️ 这里必须是**替换**语义，不能用 attachEntryTagsByName。
    // attach 是「只加不删」，传空数组等于空操作 —— 摘不掉标签，
    // 「清空标签」会静默失效（2026-10-06 验证脚本抓到的真 bug）。
    // 而 tag 是先解析后删关系：findOrCreateTag 自己也会写库，
    // 放进同一个事务里与 delete 交错容易出死锁。
    //
    // ⚠️⚠️ **这里替换的是「用户那一批 tag」，不是全部** —— 系统 tag（origin='system'）
    // 必须原样保留，否则用户改一次标签就把「这条属于哪个项目」的标记抹了。
    // 那正是 origin 存在的全部理由（验证脚本第 13 项抓到的真bug）。
    const names = [...new Set(input.tagNames.map((item) => clip(item, 40)).filter(Boolean))]
    // ⚠️ **不能写names.map(findOrCreateTag)** —— findOrCreateTag 第二个参数
    // 是 group，而 map 会把数组下标当第二个参数传进去，于是第一个 tag 拿到
    // group=0、第二个 1……。类型检查会拦住（index 不是 TagGroup），
    // 但一旦 findOrCreateTag 的签名变了（比如多一个参数）就会静默复发。
    // 显式包一层箭头函数，语义与签名解耦。
    const resolved = await Promise.all(names.map((name) => findOrCreateTag(name)))
    const now = new Date().toISOString()
    const existing = await db
      .select({ tagId: entryTags.tagId, origin: entryTags.origin, ruleId: entryTags.ruleId })
      .from(entryTags)
      .where(eq(entryTags.entryId, id))
    const preserved = new Map(existing.map((row) => [row.tagId, { origin: row.origin as TagOrigin, ruleId: row.ruleId }]))
    db.transaction((trx) => {
      trx.delete(entryTags).where(and(eq(entryTags.entryId, id), eq(entryTags.origin, 'user'))).run()
      for (const tag of resolved) {
        const prior = preserved.get(tag.id)
        trx
          .insert(entryTags)
          .values({ entryId: id, tagId: tag.id, origin: prior?.origin ?? 'user', ruleId: prior?.ruleId ?? '', createdAt: now })
          .run()
      }
    })
  }

  if (input.taxonomy !== undefined) await setTaxonomy(id, input.taxonomy, input.taxonomySpaceId ?? 'space-mine')

  // ⚠️ **extension 现在不承载任何数据**（2026-10-06 域收窄后monster 扩展表
  // 只剩 entryId，见 db/schema.ts）。行为与动作观察写进 observed 自由文本。
  // 这个分支留着的唯一理由是：将来真有「taxonomy 与自由文本都表达不了」的
  // 字段时，扩展行就是它的落点 —— 而那时不需要重新加一层分流机制。

  return getEntry(id)
}

/**
 * ⭐ 写 taxonomy。
 *
 * ⚠️ **维度必须属于该 domain 的定义集** —— 写进去之前挡住，别等读取时才发现
 * 有一个这个 domain 不认识的维度混在数据里。这是「维度定义进代码」带来的
 * 唯一好处：合法性在写入侧就能判。
 *
 * ⚠️ **没给的维度不动** —— 不是清零。taxonomy 是 sparse 的：只打过分的维度
 * 才有行。整份替换会毁掉用户没碰过的部分。
 */
export async function setTaxonomy(
  id: string,
  taxonomy: Partial<Record<string, number>>,
  spaceId = 'space-mine',
): Promise<void> {
  await getEntry(id)
  // ⚠️ **合法性按空间校验**，不再按 domain —— 维度定义在 `design_axes` 里，
  // 一个空间有哪些轴与 domain 无关（「原作」空间是空的，任何 entry 都能往里写，
  // 但不能往里写一个它没有的维度）。
  const axes = await listDesignAxes(spaceId)
  if (axes.length === 0) throw new Error('这个设计空间还没有维度 —— 先给它加几条轴')
  const allowed = new Map(axes.map((axis) => [axis.key, axis]))
  const db = await getDatabase()
  const now = new Date().toISOString()

  const rows = Object.entries(taxonomy).filter(([key, value]) => {
    if (!allowed.has(key)) throw new Error(`这个空间没有「${key}」这个维度`)
    return typeof value === 'number' && !Number.isNaN(value)
  }) as Array<[string, number]>
  if (rows.length === 0) return

  db.transaction((trx) => {
    for (const [key, value] of rows) {
      const score = Math.min(1, Math.max(0, Math.round(value * 100) / 100))
      trx
        .insert(entryTaxonomy)
        .values({ entryId: id, spaceId, dimensionKey: key, score, setAt: now, updatedAt: now })
        // ⚠️ onConflict 的 target 必须是**新的三列主键**，否则 upsert 会按老的
        // 二列主键去匹配 —— 结果是「原作的移动性」被当成「我的移动性」覆盖掉。
        // 少写一个列的后果不是报错，而是数据静默丢失。
        // setAt 也更新：改分意味着「我对这条的判断变了」，时间戳要跟着走。
        .onConflictDoUpdate({
          target: [entryTaxonomy.entryId, entryTaxonomy.spaceId, entryTaxonomy.dimensionKey],
          set: { score, setAt: now, updatedAt: now },
        })
        .run()
    }
  })
}

/** 清除某个空间下的某个维度 ——「这条我没打分」和「这条打了 0 分」是两件事。 */
export async function clearTaxonomyDimension(id: string, dimensionKey: string, spaceId = 'space-mine'): Promise<void> {
  const db = await getDatabase()
  await db
    .delete(entryTaxonomy)
    .where(and(eq(entryTaxonomy.entryId, id), eq(entryTaxonomy.dimensionKey, dimensionKey), eq(entryTaxonomy.spaceId, spaceId)))
}

/**
 * 改状态是 v0 唯一的「工作流」动作 —— 就是把条目从 Inbox 推进 Catalog。
 *
 * ⚠️ 不做成 navi AAA 那样的状态机（带 transition 白名单）。采集系统的状态
 * 只有一个用途：标记「这条我看过没有」。任何需要审批的流转都会变成录入摩擦。
 */
export async function setEntryStatus(id: string, status: EntryStatus): Promise<EntrySummary> {
  const next = assertStatus(status)
  const db = await getDatabase()
  await db.update(entries).set({ status: next, updatedAt: new Date().toISOString() }).where(eq(entries.id, id))
  return getEntry(id)
}

/**
 * 换 domain —— 这是「移库」动作，不是改字段。
 *
 * ⚠️ 换 domain 意味着换扩展表。旧扩展表行删掉。
 *
 * ⚠️ **但坐标一个都不动**（2026-10-06 起）。维度归**设计空间**管，与 domain
 * 无关 —— 「我的设计空间」里有 mobility 与 size 这条轴，跟这条记录属于怪物库
 * 还是场景库毫无关系。以前这里要按 domain 重新过滤一遍打分，纯粹是因为那时
 * 维度定义挂在 domain 上；那条耦合现在解开了。
 */
export async function changeDomain(id: string, nextDomain: DomainCode): Promise<EntrySummary> {
  const target = assertDomain(nextDomain)
  const current = await getEntryDetail(id)
  if (current.domain === target) return getEntry(id)

  const db = await getDatabase()
  const now = new Date().toISOString()

  db.transaction((trx) => {
    trx.update(entries).set({ domain: target, updatedAt: now }).where(eq(entries.id, id)).run()
    trx.delete(monsterEntries).where(eq(monsterEntries.entryId, id)).run()
    if (target === 'monster') {
      trx.insert(monsterEntries).values({ entryId: id }).run()
    }
  })

  return getEntry(id)
}

/**
 * 删除条目连带它的 tag 关系与打分。
 *
 * ⚠️ 不删图片文件。图片是本地唯一的原始参考，误删的代价远大于留一个孤儿文件；
 * 清理孤儿图片是维护命令的事（`npm run gc-media`），不该在用户点删除时顺手做。
 */
export async function deleteEntry(id: string): Promise<void> {
  await getEntry(id)
  const db = await getDatabase()
  db.transaction((trx) => {
    trx.delete(entryTags).where(eq(entryTags.entryId, id)).run()
    trx.delete(entryTaxonomy).where(eq(entryTaxonomy.entryId, id)).run()
    trx.delete(monsterEntries).where(eq(monsterEntries.entryId, id)).run()
    trx.delete(entries).where(eq(entries.id, id)).run()
  })
}

/** 各状态的数量 —— 侧栏显示 Inbox 计数用。 */
export async function statusCounts(domain?: DomainCode): Promise<Record<EntryStatus, number>> {
  const db = await getDatabase()
  const rows = await db
    .select({ status: entries.status, count: sql<number>`count(*)` })
    .from(entries)
    .where(domain ? eq(entries.domain, domain) : undefined)
    .groupBy(entries.status)
  const counts: Record<EntryStatus, number> = { inbox: 0, reviewed: 0, reference: 0 }
  for (const row of rows) {
    if ((ENTRY_STATUSES as string[]).includes(row.status)) counts[row.status as EntryStatus] = row.count
  }
  return counts
}

/**
 * 未打标的条目数 —— 侧栏「未打标」那一项的计数。
 *
 * tags 既然不强制了，这个数就是**欠账**。它得是真数，不能靠前端数当前
 * 加载的那几十条 —— 那样只会在库很小时碰巧正确。
 */
export async function untaggedCount(domain?: DomainCode): Promise<number> {
  const db = await getDatabase()
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(entries)
    .where(
      domain
        ? and(eq(entries.domain, domain), notExists(db.select({ entryId: entryTags.entryId }).from(entryTags).where(eq(entryTags.entryId, entries.id))))
        : notExists(db.select({ entryId: entryTags.entryId }).from(entryTags).where(eq(entryTags.entryId, entries.id))),
    )
  return row?.count ?? 0
}

/**
 * 导入时按外部 id 查本地 id。
 *
 * 导出包里的 id 可能是另一台机器生成的，直接搬会撞主键。这张映射表让同一个
 * 导出包导入两次得到同一条目，而不是产生两份。
 */
export async function resolveImportedId(externalId: string): Promise<string | null> {
  const db = await getDatabase()
  const [row] = await db.select().from(importIdMap).where(eq(importIdMap.externalId, externalId)).limit(1)
  return row?.localId ?? null
}

export async function rememberImportedId(externalId: string, localId: string): Promise<void> {
  const db = await getDatabase()
  await db.insert(importIdMap).values({ externalId, localId, importedAt: new Date().toISOString() })
}

/** 全部条目 —— 导出用。按 id 排序，保证多次导出的包顺序稳定可 diff。 */
export async function entriesOrderedById(domain?: DomainCode): Promise<EntryDetail[]> {
  const db = await getDatabase()
  const rows = await db
    .select()
    .from(entries)
    .where(domain ? eq(entries.domain, domain) : undefined)
    .orderBy(asc(entries.createdAt), asc(entries.id))
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const [tagMap, taxonomyMap] = await Promise.all([tagsForEntries(ids), taxonomyForEntries(ids)])
  const monsterIds = rows.filter((row) => row.domain === 'monster').map((row) => row.id)

  const extensionMap = new Map<string, MonsterExtension>()
  if (monsterIds.length > 0) {
    const extRows = await db.select().from(monsterEntries).where(inArray(monsterEntries.entryId, monsterIds))
    for (const ext of extRows) {
      // ⚠️ 只搬 entryId —— 扩展表现在没有别的列了（2026-06 域收窄，见 db/schema.ts）。
      extensionMap.set(ext.entryId, { entryId: ext.entryId })
    }
  }

  return rows.map((row) => ({
    ...mapEntry(row, tagMap.get(row.id) ?? [], taxonomyMap.get(row.id) ?? {}),
    extension: extensionMap.get(row.id) ?? null,
  }))
}