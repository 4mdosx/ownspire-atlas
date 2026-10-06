import 'server-only'
import { nanoid } from 'nanoid'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDatabase } from '@/backstage/db/database'
import { entries, entryTags, tags } from '@/backstage/db/schema'
import { isTagGroupKey, type EntryTag, type Tag, type TagGroup, type TagOrigin } from '@/types/atlas'

/**
 * db 行 → Tag。`groupName` 列在类型层叫 `group`。
 *
 * ⚠️ 用 as 断言而不是校验：groupName 是我们自己写进去的、且写之前过了
 * isTagGroupKey，脏值只可能来自手工改库。而这里抛错的代价是「整个标签
 * 列表打不开」—— 一个显示字段的值不值得这个。
 */
function toTag(row: typeof tags.$inferSelect): Tag {
  return { ...row, group: (isTagGroupKey(row.groupName) ? row.groupName : '') as TagGroup }
}

/**
 * tag 名归一化：去首尾空白 + 压掉内部连续空白。
 *
 * ⚠️ 不小写化。tag 名会作为界面文字显示，`cheap-to-animate` 和 `Cheap-To-Animate`
 * 是审美标签而非分类标签，混用说明人自己也没想清楚，不该由代码替他合并。
 * 唯一性判断走大小写不敏感（见 findTagByName）。
 */
export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 40)
}

function isUniqueError(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed: tags\.name/i.test(error.message)
}

export async function listTags(): Promise<Tag[]> {
  const db = await getDatabase()
  const rows = await db.select().from(tags).orderBy(asc(tags.name))
  return rows.map(toTag)
}

export async function getTag(id: string): Promise<Tag> {
  const db = await getDatabase()
  const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1)
  if (!row) throw new Error('标签不存在')
  return toTag(row)
}

export async function findTagByName(name: string): Promise<Tag | null> {
  const normalized = normalizeTagName(name)
  const db = await getDatabase()
  const rows = await db.select().from(tags)
  const hit = rows.find((row) => row.name.toLowerCase() === normalized.toLowerCase())
  return hit ? toTag(hit) : null
}

/**
 * 建 tag，可选给一个命名空间。
 *
 * ⚠️ group 默认空 —— **归类不强制**。随手加一个 tag 不该被「必须先选组」
 * 拦住：那会让随手记变成一道手续，而随手记的频次远高于归类的需要。
 * 归类是给 Faceted Search 用的，欠着不影响找得到东西。
 */
export async function createTag(name: string, group: TagGroup = ''): Promise<Tag> {
  const normalized = normalizeTagName(name)
  if (!normalized) throw new Error('标签不能为空')
  const db = await getDatabase()
  const now = new Date().toISOString()
  const row: Tag = { id: `tag-${Date.now()}-${nanoid(6)}`, name: normalized, group, createdAt: now, updatedAt: now }
  try {
    await db.insert(tags).values({ ...row, groupName: group })
  } catch (error) {
    if (isUniqueError(error)) throw new Error('标签已存在')
    throw error
  }
  return row
}

/**
 * 找到就用，找不到就建 —— 采集时的打字量能省一分是一分。
 * 并发下靠 UNIQUE 约束兜住：撞了就当「别人刚建好」，重查一次。
 */
export async function findOrCreateTag(name: string, group: TagGroup = ''): Promise<Tag> {
  const existing = await findTagByName(name)
  // ⚠️ 已存在的 tag **不覆盖 group**。group 是归类动作，导入包/批量操作
  // 顺手改掉一个tag 的归类会让用户失去对命名空间的所有权 ——
  // 归类应该由「我认为它属于哪类」这个显式动作驱动。
  if (existing) return existing
  try {
    return await createTag(name, group)
  } catch (error) {
    if (error instanceof Error && error.message === '标签已存在') {
      const again = await findTagByName(name)
      if (again) return again
    }
    throw error
  }
}

export async function renameTag(id: string, name: string): Promise<Tag> {
  await getTag(id)
  const normalized = normalizeTagName(name)
  if (!normalized) throw new Error('标签不能为空')
  const conflict = await findTagByName(normalized)
  if (conflict && conflict.id !== id) throw new Error('标签已存在')
  const db = await getDatabase()
  try {
    await db.update(tags).set({ name: normalized, updatedAt: new Date().toISOString() }).where(eq(tags.id, id))
  } catch (error) {
    if (isUniqueError(error)) throw new Error('标签已存在')
    throw error
  }
  return getTag(id)
}

/**
 * 删除标签，同时摘掉它挂在所有条目上的关系。
 *
 * ⚠️ 必须先摘关系再删tag。靠 ON DELETE CASCADE 也能删掉 entry_tags 行，
 * 但显式先删能让意图明确 —— 将来若关掉 cascade，这条不会被静默漏掉。
 */
export async function deleteTag(id: string): Promise<void> {
  await getTag(id)
  const db = await getDatabase()
  db.transaction((trx) => {
    trx.delete(entryTags).where(eq(entryTags.tagId, id)).run()
    trx.delete(tags).where(eq(tags.id, id)).run()
  })
}

/** ⭐ 批量读 tag，带上关联上的 origin。 */
export async function tagsForEntries(entryIds: string[]): Promise<Map<string, EntryTag[]>> {
  const grouped = new Map<string, EntryTag[]>()
  if (entryIds.length === 0) return grouped
  const db = await getDatabase()
  const rows = await db
    .select({
      entryId: entryTags.entryId,
      id: tags.id,
      name: tags.name,
      // groupName 要带出来 —— 侧栏的 Faceted Search 按组分面靠它。
      groupName: tags.groupName,
      origin: entryTags.origin,
      ruleId: entryTags.ruleId,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    })
    .from(entryTags)
    .innerJoin(tags, eq(tags.id, entryTags.tagId))
    .where(inArray(entryTags.entryId, entryIds))
    .orderBy(asc(tags.name))
  for (const row of rows) {
    const list = grouped.get(row.entryId) ?? []
    list.push({
      id: row.id,
      name: row.name,
      group: (isTagGroupKey(row.groupName) ? row.groupName : '') as TagGroup,
      origin: row.origin as TagOrigin,
      ruleId: row.ruleId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    grouped.set(row.entryId, list)
  }
  return grouped
}

/**
 * ⭐ 设置 entry 的 tag。
 *
 * ⚠️ **默认只替换 origin='user' 的关系，系统 tag 原样保留。**
 *
 * 这条是「区分用户输入与系统自动添加」的真正价值所在：用户编辑标签时
 * 不该把系统打的项目标记一起抹掉。反过来，「清空全部」要能显式做到 ——
 * 所以给 `includeSystem` 开关，而不是靠猜。
 *
 * ⚠️ 替换语义，不是只加不删。传空数组在默认模式下等于「清空用户 tag」
 * （2026-10-06 验证脚本抓到的真bug：以前 attach 语义下传空数组是空操作）。
 */
export async function setEntryTags(entryId: string, tagIds: string[], includeSystem = false): Promise<void> {
  const db = await getDatabase()
  const [entry] = await db.select({ id: entries.id }).from(entries).where(eq(entries.id, entryId)).limit(1)
  if (!entry) throw new Error('条目不存在')

  const unique = [...new Set(tagIds.filter((id) => id.trim()))]
  if (unique.length > 0) {
    const found = await db.select({ id: tags.id }).from(tags).where(inArray(tags.id, unique))
    if (found.length !== unique.length) throw new Error('标签不存在')
  }

  // ⚠️ 先读出已有关系的 origin。删掉再重插时必须按原来的 origin 写回，
  // 否则系统 tag 会被静默降级成 user —— 那正是这个字段存在的理由，
  // 不能自己把它抹了。
  const existing = await db
    .select({ tagId: entryTags.tagId, origin: entryTags.origin, ruleId: entryTags.ruleId })
    .from(entryTags)
    .where(eq(entryTags.entryId, entryId))
  const originByTag = new Map(existing.map((row) => [row.tagId, { origin: row.origin as TagOrigin, ruleId: row.ruleId }]))

  const now = new Date().toISOString()
  db.transaction((trx) => {
    trx
      .delete(entryTags)
      .where(includeSystem ? eq(entryTags.entryId, entryId) : and(eq(entryTags.entryId, entryId), eq(entryTags.origin, 'user')))
      .run()
    for (const tagId of unique) {
      const preserved = originByTag.get(tagId)
      trx
        .insert(entryTags)
        .values({
          entryId,
          tagId,
          origin: preserved?.origin ?? 'user',
          ruleId: preserved?.ruleId ?? '',
          createdAt: now,
        })
        .run()
    }
  })
}

/**
 * 采集路径用：给一批 tag 名，**只加不删**，系统 tag 不动。
 *
 * ⚠️ 名字里带ByName 就是「加」的意思，而 setEntryTags 是「替换」语义 ——
 * 两者混用是 2026-10-06 那个「清空标签静默失效」bug 的根源。
 */
export async function attachEntryTagsByName(entryId: string, names: string[]): Promise<void> {
  const wanted = [...new Set(names.map(normalizeTagName).filter(Boolean))]
  if (wanted.length === 0) return
  // ⚠️ 显式箭头，不写 wanted.map(findOrCreateTag) —— findOrCreateTag 的第二个
  // 参数是 group，map 会把数组下标传进去（详见 entry.service.ts 里的同处注释）。
  const resolved = await Promise.all(wanted.map((name) => findOrCreateTag(name)))
  const current = (await tagsForEntries([entryId])).get(entryId) ?? []
  const merged = [...current.map((item) => item.id)]
  for (const tag of resolved) if (!merged.includes(tag.id)) merged.push(tag.id)
  // 只替换 user 那批 —— merged 里的系统 tag 会按原origin 写回。
  await setEntryTags(entryId, merged)
}

/** 摘掉一个 tag。系统 tag 需要显式指定 includeSystem 才会真删。 */
export async function detachEntryTag(entryId: string, tagId: string): Promise<void> {
  const current = (await tagsForEntries([entryId])).get(entryId) ?? []
  const tag = current.find((item) => item.id === tagId)
  await setEntryTags(
    entryId,
    current.filter((item) => item.id !== tagId).map((item) => item.id),
    tag?.origin === 'system',
  )
}

/**
 * ⭐ 挂系统 tag —— 「属于什么项目」的实现入口。
 *
 * ⚠️ ruleId 是这条 tag 的来源规则标识。系统 tag 按 ruleId 整批查、整批摘，
 * 是「一个项目背后通过 tag 实现」的可运维前提。
 */
export async function attachSystemTag(entryId: string, name: string, ruleId: string, group: TagGroup = ''): Promise<void> {
  if (!ruleId.trim()) throw new Error('系统 tag 必须带 ruleId —— 没有来源规则的系统 tag 无法追溯')
  const tag = await findOrCreateTag(name, group)
  const db = await getDatabase()
  const now = new Date().toISOString()
  await db
    .insert(entryTags)
    .values({ entryId, tagId: tag.id, origin: 'system', ruleId: ruleId.trim(), createdAt: now })
    .onConflictDoUpdate({ target: [entryTags.entryId, entryTags.tagId], set: { origin: 'system', ruleId: ruleId.trim() } })
}

/**
 * 整批摘掉某条规则挂上的 tag —— 项目结束时的清理。
 *
 * ⚠️⚠️ **这是全局删除，不限定在某条条目上。** 签名里只有 `ruleId`，
 * **没有 `entryId`** —— 所以凡是引用同一 `ruleId` 的条目，tag 都会被摘掉。
 *
 * ⚠️ 这一点在测试里长期被测错（我曾写成 `detachSystemTagsByRule(entryId, ruleId)`，
 * 多传一个参数反而被忽略，于是「只摘了那条的」是假绿）。所以这里写死注释：
 *
 * · 要**只摘某一条**的 tag → 用 `detachEntryTag(entryId, tagId)`
 * · 要**按规则全局清**（项目结束）→ 用这个
 *
 * 两者不能混：系统 tag 的语义本来就是「这条记录因为某规则而被标记」，
 * 所以清一个规则就该清全部 —— 否则库里会留下半截状态。
 */
export async function detachSystemTagsByRule(ruleId: string): Promise<number> {
  const db = await getDatabase()
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(entryTags)
    .where(and(eq(entryTags.origin, 'system'), eq(entryTags.ruleId, ruleId)))
  await db.delete(entryTags).where(and(eq(entryTags.origin, 'system'), eq(entryTags.ruleId, ruleId)))
  return row?.count ?? 0
}

/**
 * tag 使用频次统计 —— 「哪些 tag 高频 / 从来没用过」的判据来源。
 *
 * ⚠️ 只统计挂在条目上的 tag。tags 表里可能有从未被用过的 tag（建了没挂），
 * 那些正是要清理的对象，所以不能反过来从 tags 表出发数。
 *
 * ⚠️ `controlled` 字段保留但恒为 false —— v0.2 起 tag 没有白名单，
 * 「是否受控」不再是 tag 的属性（那是 taxonomy 的事）。
 * 保留字段是为了让现有 UI 调用点不用改。
 */
export async function tagUsage(): Promise<Array<{ id: string; name: string; count: number; controlled: boolean }>> {
  const db = await getDatabase()
  const rows = await db
    .select({ id: tags.id, name: tags.name, entryId: entryTags.entryId })
    .from(tags)
    .leftJoin(entryTags, eq(entryTags.tagId, tags.id))
  const counted = rows.map((row) => ({
    id: row.id,
    name: row.name,
    count: row.entryId ? 1 : 0,
    controlled: false,
  }))
  return counted.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}
/**
 * 改tag 的命名空间。
 *
 * ⚠️ group 挂在 **tag 实体**上而不是 entry_tags 上 —— 归类是「这个词属于哪类」，
 * 是这个词的性质，与它挂在哪些条目上无关。所以改一次全局生效。
 * （这与 origin 挂在 entry_tags 上正好相反：origin 记的是「这条关联是谁加的」，
 * 同一个词在不同条目上可以有不同 origin。）
 *
 * ⚠️ 允许改回空串（取消归类）。强制归类会让随手记变成一道手续，
 * 而随手记的频次远高于归类的需要。
 */
export async function setTagGroup(name: string, group: TagGroup): Promise<Tag> {
  const tag = await findTagByName(name)
  if (!tag) throw new Error('标签不存在')
  const db = await getDatabase()
  const now = new Date().toISOString()
  await db.update(tags).set({ groupName: group, updatedAt: now }).where(eq(tags.id, tag.id))
  return { ...tag, group, updatedAt: now }
}
