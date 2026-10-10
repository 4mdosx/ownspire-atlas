/**
 * 一次性：把「迁移系统之前」手建库里的数据搬进 drizzle 迁移建的新库。
 *
 * 用法：
 *   tsx scripts/import-from-legacy.ts <旧库路径>
 *   （新库用 `DB_FILE_NAME`，缺省是 ~/.local/share/creative-atlas/atlas.db）
 *
 * ⚠️ **为什么是「建新库 + 导入」而不是「给旧库补结构」**：旧库里没有
 * `__drizzle_migrations`，而 0000_initial 里的 CREATE TABLE 在已存在的表上会
 * 直接失败 —— 想在旧库上继续用迁移系统，只能伪造一条「已应用」记录，那等于
 * 声明「旧库结构 == 迁移产出的结构」，而这个等式恰恰是我们没法验证的（旧库
 * 缺 settings 表就是现成的反例）。建新库的话，结构是迁移**自己**建的，等式
 * 天然成立。
 *
 * ⚠️ 内置的两个 design_space 与「我的」空间的轴**不搬** —— 新库 migrate 之后
 * seed 已经建好了同一批（id 都一致），这里靠 `onConflictDoNothing()` 跳过。
 * 所以脚本可以重复跑：跑第二次是「全部冲突 → 全部跳过」。
 *
 * ⚠️ 顺序是**拓扑序**：entries → monster_entries / entry_tags，反过来会撞
 * 外键（新库开了外键约束的列）。
 */
import { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '@/backstage/db/database'
import {
  designAxes,
  designSpaces,
  entries,
  entryAxisValues,
  entryTags,
  importIdMap,
  monsterEntries,
  tags,
} from '@/backstage/db/schema'

const legacyPath = process.argv[2]
if (!legacyPath) {
  console.error('用法：tsx scripts/import-from-legacy.ts <旧库路径>')
  process.exit(1)
}

/** 旧库是手建的，列顺序与 schema 一致，直接 `SELECT *` 拿整行。 */
function readAll<T>(legacy: DatabaseSync, table: string): T[] {
  const exists = legacy
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name: string } | undefined
  if (!exists) {
    console.log(`  ${table}: 旧库没有这张表，跳过`)
    return []
  }
  return legacy.prepare(`SELECT * FROM ${table}`).all() as T[]
}

async function main(): Promise<void> {
  const legacy = new DatabaseSync(legacyPath)
  const db = await getDatabase()

  const rowSets = {
    design_spaces: readAll(legacy, 'design_spaces'),
    design_axes: readAll(legacy, 'design_axes'),
    tags: readAll(legacy, 'tags'),
    entries: readAll(legacy, 'entries'),
    monster_entries: readAll(legacy, 'monster_entries'),
    entry_tags: readAll(legacy, 'entry_tags'),
    entry_axis_values: readAll(legacy, 'entry_axis_values'),
    import_id_map: readAll(legacy, 'import_id_map'),
  }

  for (const [name, rows] of Object.entries(rowSets)) {
    console.log(`  ${name}: 旧库 ${rows.length} 行`)
  }

  // 拓扑序：被引用的先写。
  if (rowSets.design_spaces.length) await db.insert(designSpaces).values(rowSets.design_spaces as never[]).onConflictDoNothing()
  if (rowSets.design_axes.length) await db.insert(designAxes).values(rowSets.design_axes as never[]).onConflictDoNothing()
  if (rowSets.tags.length) await db.insert(tags).values(rowSets.tags as never[]).onConflictDoNothing()
  if (rowSets.entries.length) await db.insert(entries).values(rowSets.entries as never[]).onConflictDoNothing()
  if (rowSets.monster_entries.length) await db.insert(monsterEntries).values(rowSets.monster_entries as never[]).onConflictDoNothing()
  if (rowSets.entry_tags.length) await db.insert(entryTags).values(rowSets.entry_tags as never[]).onConflictDoNothing()
  if (rowSets.entry_axis_values.length) await db.insert(entryAxisValues).values(rowSets.entry_axis_values as never[]).onConflictDoNothing()
  if (rowSets.import_id_map.length) await db.insert(importIdMap).values(rowSets.import_id_map as never[]).onConflictDoNothing()

  const counts = {
    entries: (await db.select().from(entries)).length,
    tags: (await db.select().from(tags)).length,
    entry_tags: (await db.select().from(entryTags)).length,
    monster_entries: (await db.select().from(monsterEntries)).length,
    design_axes: (await db.select().from(designAxes)).length,
  }
  console.log('导入后新库计数：', counts)
  legacy.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
