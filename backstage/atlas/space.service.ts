import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '@/backstage/db/database'
import { designAxes, designSpaces } from '@/backstage/db/schema'
import type { DesignAxis, DesignAxisGroup, DesignSpace } from '@/types/atlas'

/**
 * ⭐ 设计空间 —— 坐标系的持有者。
 *
 * 这层的存在理由见 `db/schema.ts` 的 designSpaces 注释：一句话是
 * **「原作的移动性」与「我的移动性」是两个不同的问题**，而 v0.2 把它们挤在
 * 同一列，于是半年后无法判断自己改的是什么，于是不敢改。
 */

/** 空间 → 读它的全部维度（按 sortOrder）。 */
export async function listDesignAxes(spaceId: string): Promise<DesignAxis[]> {
  const db = await getDatabase()
  const rows = await db.select().from(designAxes).where(eq(designAxes.spaceId, spaceId)).orderBy(asc(designAxes.sortOrder))
  return rows.map(toAxis)
}

/** 全部空间，按 sortOrder。⚠️ sortOrder 小 = 靠前 = 「我的」先于「原作」。 */
export async function listDesignSpaces(): Promise<DesignSpace[]> {
  const db = await getDatabase()
  const rows = await db.select().from(designSpaces).orderBy(asc(designSpaces.sortOrder))
  return rows.map(toSpace)
}

/** 按 code 取空间。代码里认 code（'mine' / 'source'），不认 id —— id 是数据。 */
export async function findSpaceByCode(code: string): Promise<DesignSpace | null> {
  const db = await getDatabase()
  const [row] = await db.select().from(designSpaces).where(eq(designSpaces.code, code)).limit(1)
  return row ? toSpace(row) : null
}

export async function findAxis(spaceId: string, key: string): Promise<DesignAxis | null> {
  const db = await getDatabase()
  // ⚠️ 两个条件合在**同一个** where 里 —— chainable 两次 .where() 是后者覆盖前者，
  // 那样查出来的是「该空间下任意一条轴」，条件静默失效。
  const [row] = await db
    .select()
    .from(designAxes)
    .where(and(eq(designAxes.spaceId, spaceId), eq(designAxes.key, key)))
    .limit(1)
  return row ? toAxis(row) : null
}

function toSpace(row: typeof designSpaces.$inferSelect): DesignSpace {
  return {
    id: row.id,
    code: row.code,
    labelZh: row.labelZh,
    labelEn: row.labelEn,
    hintZh: row.hintZh,
    sortOrder: row.sortOrder,
    isBuiltin: row.isBuiltin === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * ⚠️ groupKey 存的是 `中文|English` 的合并字符串 —— 因为坐标轴的分组名也是
 * 内容（用户能改），不能像 spaceId 那样外键到一张表：那会让「改一个组的显示名」
 * 变成一次跨表写入，而它只是个排版标签。
 *
 * 代价是 group 改名时全库的 axis 行都要跟着改。分组是排版概念，那个代价可接受。
 */
function toAxis(row: typeof designAxes.$inferSelect): DesignAxis {
  const [zh, en] = row.groupKey.split('|')
  let anchors: string[] = []
  try {
    const parsed = JSON.parse(row.anchorsJson) as unknown
    if (Array.isArray(parsed)) anchors = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    anchors = []
  }
  return {
    id: row.id,
    spaceId: row.spaceId,
    key: row.key,
    labelZh: row.labelZh,
    labelEn: row.labelEn,
    hintZh: row.hintZh,
    group: { labelZh: zh ?? '', labelEn: en ?? '' } as DesignAxisGroup,
    anchors,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * 新建设计空间（项目坐标系用）。
 *
 * ⚠️ **只有项目空间才需要手建**。「原作」和「我的」是预置的。
 * code 一旦定下就别改 —— 它是数据里的稳定标识，导出包/脚本认它。
 */
export async function createDesignSpace(input: {
  code: string
  labelZh: string
  labelEn?: string
  hintZh?: string
}): Promise<DesignSpace> {
  const code = input.code.trim()
  if (!code) throw new Error('空间 code 不能为空')
  if (!/^[a-z0-9-]+$/.test(code)) throw new Error('空间 code 只能用小写字母、数字与连字符')
  const db = await getDatabase()
  const now = new Date().toISOString()
  // 排在预置空间之后。⚠️ 不是 +1 —— 用 max+10 才不会跟别人撞。
  const maxRow = db.select({ value: sql<number>`max(${designSpaces.sortOrder})` }).from(designSpaces).get() as
    | { value: number | null }
    | undefined
  const sortOrder = (maxRow?.value ?? 0) + 10
  const row: DesignSpace = {
    id: `space-${nanoid(8)}`,
    code,
    labelZh: input.labelZh.trim(),
    labelEn: input.labelEn?.trim() ?? '',
    hintZh: input.hintZh?.trim() ?? '',
    sortOrder,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(designSpaces).values({
    id: row.id,
    code: row.code,
    labelZh: row.labelZh,
    labelEn: row.labelEn,
    hintZh: row.hintZh,
    sortOrder: row.sortOrder,
    isBuiltin: 0,
    createdAt: now,
    updatedAt: now,
  })
  return row
}

/** 加一条维度到某个空间。 */
export async function createDesignAxis(input: {
  spaceId: string
  key: string
  labelZh: string
  labelEn?: string
  hintZh?: string
  groupLabelZh?: string
  groupLabelEn?: string
  anchors: string[]
}): Promise<DesignAxis> {
  const key = input.key.trim()
  if (!key) throw new Error('维度 key 不能为空')
  if (input.anchors.length < 2) throw new Error('维度至少要有 2 个档位 —— 只有 1 个档位的轴没法打分')
  const db = await getDatabase()
  const now = new Date().toISOString()
  const maxRow = db.select({ value: sql<number>`max(${designAxes.sortOrder})` }).from(designAxes).where(eq(designAxes.spaceId, input.spaceId)).get() as
    | { value: number | null }
    | undefined
  const row = {
    id: `axis-${nanoid(8)}`,
    spaceId: input.spaceId,
    key,
    labelZh: input.labelZh.trim(),
    labelEn: input.labelEn?.trim() ?? '',
    hintZh: input.hintZh?.trim() ?? '',
    groupKey: `${input.groupLabelZh?.trim() ?? ''}|${input.groupLabelEn?.trim() ?? ''}`,
    anchorsJson: JSON.stringify(input.anchors),
    sortOrder: (maxRow?.value ?? 0) + 10,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(designAxes).values(row)
  return toAxis(row)
}