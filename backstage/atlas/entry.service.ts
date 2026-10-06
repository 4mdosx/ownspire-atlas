import 'server-only'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { getDatabase } from '@/backstage/db/database'
import { entryTags, importIdMap, monsterEntries, tags } from '@/backstage/db/schema'
import { attachEntryTagsByName, tagsForEntries } from './tag.service'
import { ENTRY_STATUSES, type EntryStatus, type EntrySummary, type ImageSource, type MonsterEntry } from '@/types/atlas'

const MAX_NAME = 120
const MAX_URL = 2000
const MAX_NOTES = 8000

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function mapEntry(row: typeof monsterEntries.$inferSelect, tagList: MonsterEntry['tags'] = []): EntrySummary {
  return {
    ...row,
    status: row.status as EntryStatus,
    imageSource: row.imageSource as ImageSource,
    movement: parseList(row.movement),
    combatRole: parseList(row.combatRole),
    attackPattern: parseList(row.attackPattern),
    tags: tagList,
  }
}

function assertStatus(value: unknown): EntryStatus {
  if (typeof value === 'string' && (ENTRY_STATUSES as string[]).includes(value)) return value as EntryStatus
  throw new Error(`状态只能是 ${ENTRY_STATUSES.join(' / ')}`)
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
 */
function assertImagePath(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('必须有图片')
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
  name?: string
  sourceUrl: string
  sourceTitle?: string
  sourceGame?: string
  /** 相对 media 根的路径。 */
  imagePath: string
  imageSource?: ImageSource
  originalName?: string
  notes?: string
  bodyType?: string
  scale?: string
  movement?: string[]
  combatRole?: string[]
  attackPattern?: string[]
  status?: EntryStatus
  tagNames?: string[]
}

export type UpdateEntryInput = Partial<Omit<CreateEntryInput, 'imagePath'>> & { imagePath?: string }

export async function getEntry(id: string): Promise<EntrySummary> {
  const db = await getDatabase()
  const [row] = await db.select().from(monsterEntries).where(eq(monsterEntries.id, id)).limit(1)
  if (!row) throw new Error('条目不存在')
  const tagMap = await tagsForEntries([id])
  return mapEntry(row, tagMap.get(id) ?? [])
}

export type ListFilter = {
  status?: EntryStatus
  /** 同时命中所有 tag 才算 —— 「flying + small」用这个。 */
  tagNames?: string[]
  /** 命中任意 tag 就算。 */
  anyTagNames?: string[]
  /** 搜 name 与 notes。 */
  q?: string
  limit?: number
  offset?: number
}

/**
 * 列表查询。
 *
 * ⚠️ tag筛选走子查询而不是 join 后group —— join 后去重会把不带 tag 的条目
 * 一起吞掉（INNER JOIN 的经典坑）。AND 语义用 `IN (子查询)` 表达，
 * 一行就能保证「同时命中所有指定 tag」。
 */
export async function listEntries(filter: ListFilter = {}): Promise<EntrySummary[]> {
  const db = await getDatabase()
  const conditions = []

  if (filter.status) conditions.push(eq(monsterEntries.status, filter.status))

  if (filter.tagNames && filter.tagNames.length > 0) {
    for (const name of filter.tagNames) {
      const trimmed = name.trim()
      if (!trimmed) continue
      const sub = db
        .select({ entryId: entryTags.entryId })
        .from(entryTags)
        .innerJoin(tags, eq(tags.id, entryTags.tagId))
        .where(eq(tags.name, trimmed))
      conditions.push(inArray(monsterEntries.id, sub))
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
      conditions.push(inArray(monsterEntries.id, sub))
    }
  }

  if (filter.q?.trim()) {
    const needle = `%${filter.q.trim()}%`
    conditions.push(or(like(monsterEntries.name, needle), like(monsterEntries.notes, needle), like(monsterEntries.sourceGame, needle)))
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined
  const limit = Math.min(Math.max(filter.limit ?? 60, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)

  const rows = await db
    .select()
    .from(monsterEntries)
    .where(where)
    .orderBy(desc(monsterEntries.createdAt))
    .limit(limit)
    .offset(offset)

  if (rows.length === 0) return []
  const tagMap = await tagsForEntries(rows.map((row) => row.id))
  return rows.map((row) => mapEntry(row, tagMap.get(row.id) ?? []))
}

export async function countEntries(filter: ListFilter = {}): Promise<number> {
  const rows = await listEntries({ ...filter, limit: 500, offset: 0 })
  // v0 的量级（几百条）下这个近似是准的；上千条之后再换 count 查询。
  return rows.length
}

/**
 * 采集入口。
 *
 * ⚠️ tags 强制（至少一个），但其余设计字段一律可空。这是 v0 的核心纪律：
 * Atlas 是采集系统，不是调查问卷。
 */
export async function createEntry(input: CreateEntryInput): Promise<EntrySummary> {
  const sourceUrl = assertSourceUrl(input.sourceUrl)
  const imagePath = assertImagePath(input.imagePath)

  const db = await getDatabase()
  const now = new Date().toISOString()
  const id = `m-${nanoid(10)}`
  const tagNames = (input.tagNames ?? []).map((item) => clip(item, 40)).filter(Boolean)
  if (tagNames.length === 0) throw new Error('至少打一个标签 —— 不打标签的条目以后再也找不回来')

  await db.insert(monsterEntries).values({
    id,
    name: clip(input.name, MAX_NAME),
    sourceUrl,
    sourceTitle: clip(input.sourceTitle, MAX_NAME),
    sourceGame: clip(input.sourceGame, MAX_NAME),
    imagePath,
    imageSource: input.imageSource === 'paste' ? 'paste' : 'file',
    originalName: clip(input.originalName, MAX_NAME),
    notes: clip(input.notes, MAX_NOTES),
    bodyType: clip(input.bodyType, 40),
    scale: clip(input.scale, 40),
    movement: JSON.stringify(clipList(input.movement)),
    combatRole: JSON.stringify(clipList(input.combatRole)),
    attackPattern: JSON.stringify(clipList(input.attackPattern)),
    status: input.status ? assertStatus(input.status) : 'inbox',
    createdAt: now,
    updatedAt: now,
  })

  await attachEntryTagsByName(id, tagNames)
  return getEntry(id)
}

export async function updateEntry(id: string, input: UpdateEntryInput): Promise<EntrySummary> {
  const current = await getEntry(id)
  const db = await getDatabase()
  const updates: Partial<typeof monsterEntries.$inferInsert> = { updatedAt: new Date().toISOString() }

  if (input.name !== undefined) updates.name = clip(input.name, MAX_NAME)
  if (input.sourceUrl !== undefined) updates.sourceUrl = assertSourceUrl(input.sourceUrl)
  if (input.sourceTitle !== undefined) updates.sourceTitle = clip(input.sourceTitle, MAX_NAME)
  if (input.sourceGame !== undefined) updates.sourceGame = clip(input.sourceGame, MAX_NAME)
  if (input.imagePath !== undefined) updates.imagePath = assertImagePath(input.imagePath)
  if (input.imageSource !== undefined) updates.imageSource = input.imageSource === 'paste' ? 'paste' : 'file'
  if (input.originalName !== undefined) updates.originalName = clip(input.originalName, MAX_NAME)
  if (input.notes !== undefined) updates.notes = clip(input.notes, MAX_NOTES)
  if (input.bodyType !== undefined) updates.bodyType = clip(input.bodyType, 40)
  if (input.scale !== undefined) updates.scale = clip(input.scale, 40)
  if (input.movement !== undefined) updates.movement = JSON.stringify(clipList(input.movement))
  if (input.combatRole !== undefined) updates.combatRole = JSON.stringify(clipList(input.combatRole))
  if (input.attackPattern !== undefined) updates.attackPattern = JSON.stringify(clipList(input.attackPattern))
  if (input.status !== undefined) updates.status = assertStatus(input.status)

  await db.update(monsterEntries).set(updates).where(eq(monsterEntries.id, id))
  if (input.tagNames !== undefined) {
    const tagNames = input.tagNames.map((item) => clip(item, 40)).filter(Boolean)
    await attachEntryTagsByName(id, tagNames)
  }
  return getEntry(id)
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
  await db.update(monsterEntries).set({ status: next, updatedAt: new Date().toISOString() }).where(eq(monsterEntries.id, id))
  return getEntry(id)
}

/**
 * 删除条目连带它的 tag 关系。
 *
 * ⚠️ 不删图片文件。图片是本地唯一的原始参考，误删的代价远大于留一个孤儿文件；
 * 清理孤儿图片是维护命令的事（`npm run gc-media`），不该在用户点删除时顺手做。
 */
export async function deleteEntry(id: string): Promise<void> {
  await getEntry(id)
  const db = await getDatabase()
  db.transaction((trx) => {
    trx.delete(entryTags).where(eq(entryTags.entryId, id)).run()
    trx.delete(monsterEntries).where(eq(monsterEntries.id, id)).run()
  })
}

/** 各状态的数量 —— 侧栏显示 Inbox 计数用。 */
export async function statusCounts(): Promise<Record<EntryStatus, number>> {
  const db = await getDatabase()
  const rows = await db
    .select({ status: monsterEntries.status, count: sql<number>`count(*)` })
    .from(monsterEntries)
    .groupBy(monsterEntries.status)
  const counts: Record<EntryStatus, number> = { inbox: 0, reviewed: 0, reference: 0 }
  for (const row of rows) {
    if ((ENTRY_STATUSES as string[]).includes(row.status)) counts[row.status as EntryStatus] = row.count
  }
  return counts
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

/** 最近录入 —— 导出时按这个顺序写，保证多次导出的包顺序稳定可 diff。 */
export async function entriesOrderedById(): Promise<EntrySummary[]> {
  const db = await getDatabase()
  const rows = await db.select().from(monsterEntries).orderBy(asc(monsterEntries.createdAt), asc(monsterEntries.id))
  if (rows.length === 0) return []
  const tagMap = await tagsForEntries(rows.map((row) => row.id))
  return rows.map((row) => mapEntry(row, tagMap.get(row.id) ?? []))
}