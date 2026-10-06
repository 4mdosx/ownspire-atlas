import 'server-only'
import { nanoid } from 'nanoid'
import { asc, eq, inArray } from 'drizzle-orm'
import { getDatabase } from '@/backstage/db/database'
import { entryTags, monsterEntries, tags } from '@/backstage/db/schema'
import { CONTROLLED_TAXONOMY, type Tag } from '@/types/atlas'

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
  return rows
}

export async function getTag(id: string): Promise<Tag> {
  const db = await getDatabase()
  const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1)
  if (!row) throw new Error('标签不存在')
  return row
}

export async function findTagByName(name: string): Promise<Tag | null> {
  const normalized = normalizeTagName(name)
  const db = await getDatabase()
  const rows = await db.select().from(tags)
  return rows.find((row) => row.name.toLowerCase() === normalized.toLowerCase()) ?? null
}

export async function createTag(name: string): Promise<Tag> {
  const normalized = normalizeTagName(name)
  if (!normalized) throw new Error('标签不能为空')
  const db = await getDatabase()
  const now = new Date().toISOString()
  const row: Tag = { id: `tag-${Date.now()}-${nanoid(6)}`, name: normalized, createdAt: now, updatedAt: now }
  try {
    await db.insert(tags).values(row)
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
export async function findOrCreateTag(name: string): Promise<Tag> {
  const existing = await findTagByName(name)
  if (existing) return existing
  try {
    return await createTag(name)
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
 * ⚠️ 必须先摘关系再删 tag。靠 ON DELETE CASCADE 也能删掉 entry_tags 行，
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

export async function tagsForEntries(entryIds: string[]): Promise<Map<string, Tag[]>> {
  const grouped = new Map<string, Tag[]>()
  if (entryIds.length === 0) return grouped
  const db = await getDatabase()
  const rows = await db
    .select({ entryId: entryTags.entryId, id: tags.id, name: tags.name, createdAt: tags.createdAt, updatedAt: tags.updatedAt })
    .from(entryTags)
    .innerJoin(tags, eq(tags.id, entryTags.tagId))
    .where(inArray(entryTags.entryId, entryIds))
    .orderBy(asc(tags.name))
  for (const row of rows) {
    const list = grouped.get(row.entryId) ?? []
    list.push({ id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt })
    grouped.set(row.entryId, list)
  }
  return grouped
}

export async function setEntryTags(entryId: string, tagIds: string[]): Promise<void> {
  const db = await getDatabase()
  const [entry] = await db.select({ id: monsterEntries.id }).from(monsterEntries).where(eq(monsterEntries.id, entryId)).limit(1)
  if (!entry) throw new Error('条目不存在')
  const unique = [...new Set(tagIds.filter((id) => id.trim()))]
  if (unique.length > 0) {
    const found = await db.select({ id: tags.id }).from(tags).where(inArray(tags.id, unique))
    if (found.length !== unique.length) throw new Error('标签不存在')
  }
  const now = new Date().toISOString()
  db.transaction((trx) => {
    trx.delete(entryTags).where(eq(entryTags.entryId, entryId)).run()
    for (const tagId of unique) trx.insert(entryTags).values({ entryId, tagId, createdAt: now }).run()
  })
}

/** 采集路径用：给一批 tag 名，一次性挂上。已存在的复用，不存在的建。 */
export async function attachEntryTagsByName(entryId: string, names: string[]): Promise<void> {
  const wanted = [...new Set(names.map(normalizeTagName).filter(Boolean))]
  if (wanted.length === 0) return
  const resolved = await Promise.all(wanted.map(findOrCreateTag))
  const current = (await tagsForEntries([entryId])).get(entryId) ?? []
  const merged = [...current.map((item) => item.id)]
  for (const tag of resolved) if (!merged.includes(tag.id)) merged.push(tag.id)
  await setEntryTags(entryId, merged)
}

export async function detachEntryTag(entryId: string, tagId: string): Promise<void> {
  const current = (await tagsForEntries([entryId])).get(entryId) ?? []
  await setEntryTags(entryId, current.filter((item) => item.id !== tagId).map((item) => item.id))
}

/**
 * tag 使用频次统计 —— 阶段 5「哪些 tag 高频 / 从来没用过」的判据来源。
 *
 * ⚠️ 只统计挂在条目上的 tag。tags 表里可能有从未被用过的 tag（建了没挂），
 * 那些正是要清理的对象，所以不能反过来从 tags 表出发数。
 */
export async function tagUsage(): Promise<Array<{ id: string; name: string; count: number; controlled: boolean }>> {
  const db = await getDatabase()
  const rows = await db
    .select({ id: tags.id, name: tags.name, entryId: entryTags.entryId })
    .from(tags)
    .leftJoin(entryTags, eq(entryTags.tagId, tags.id))
  const controlled: ReadonlySet<string> = new Set(Object.values(CONTROLLED_TAXONOMY).flat())
  const counted = rows.map((row) => ({
    id: row.id,
    name: row.name,
    count: row.entryId ? 1 : 0,
    controlled: controlled.has(row.name),
  }))
  return counted.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}