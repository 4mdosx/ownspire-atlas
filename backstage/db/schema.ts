import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/**
 * v0 只有一张业务表。
 *
 * ⚠️ 所有 JSON 数组字段（movement / combatRole / attackPattern）存成 TEXT，
 * 默认 '[]'。不用 JSON 扩展类型 —— 读的时候 parse 一次，写的时候 stringify，
 * 这样导出/导入只需要关心 TEXT 本身，不依赖 SQLite 的 JSON1 扩展是否编译进来。
 */

export const monsterEntries = sqliteTable('monster_entries', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),

  // 来源。sourceUrl 强制 —— 没有出处的东西不进Atlas。
  sourceUrl: text('sourceUrl').notNull(),
  sourceTitle: text('sourceTitle').notNull().default(''),
  sourceGame: text('sourceGame').notNull().default(''),

  // 资产。imagePath 是相对 media 根的路径，不是绝对路径。
  imagePath: text('imagePath').notNull(),
  imageSource: text('imageSource').notNull().default('file'),
  originalName: text('originalName').notNull().default(''),

  notes: text('notes').notNull().default(''),

  // Monster Design。全部可空 —— v0 不做调查问卷。
  bodyType: text('bodyType').notNull().default(''),
  scale: text('scale').notNull().default(''),
  movement: text('movement').notNull().default('[]'),
  combatRole: text('combatRole').notNull().default('[]'),
  attackPattern: text('attackPattern').notNull().default('[]'),

  status: text('status').notNull().default('inbox'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

export const entryTags = sqliteTable('entry_tags', {
  entryId: text('entryId').notNull().references(() => monsterEntries.id, { onDelete: 'cascade' }),
  tagId: text('tagId').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  createdAt: text('createdAt').notNull(),
}, (table) => [
  primaryKey({ columns: [table.entryId, table.tagId] }),
])

/**
 * 导入用的外部 id 映射表。
 *
 * 为什么需要：导出包里的 entryId 可能是别的机器上生成的，直接搬会撞 id。
 * 导入时按 externalId 查这张表，命中就复用本地 id，没命中就新建并登记。
 * 这张表不进导出包 —— 它是导入机制的内部状态，不是数据。
 */
export const importIdMap = sqliteTable('import_id_map', {
  externalId: text('externalId').primaryKey(),
  localId: text('localId').notNull(),
  importedAt: text('importedAt').notNull(),
})