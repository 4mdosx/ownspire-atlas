import { primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * v0.2 数据模型：顶层 entries + 按 domain 分流的扩展表。
 *
 * ⚠️ 所有 JSON 数组字段存成 TEXT，默认 '[]'。不用 JSON 扩展类型 —— 读的时候
 * parse 一次，写的时候 stringify，这样导出/导入只需要关心 TEXT 本身，
 * 不依赖 SQLite 的 JSON1 扩展是否编译进来。
 *
 * ⚠️ domain 列表**不进数据库**，留在 types/atlas.ts 的代码常量里。现在只有一个
 * domain，进表的代价是多两张表、多一层 join、顺序和中英文要 seed。等第二个
 * domain 真出现、维度真要分叉了再搬进来。`entries.domain` 这一列本身
 * 就足够支撑 Catalog 跨类型查询 —— 通用化的核心收益不需要 domains 表。
 */

/**
 * 顶层条目。所有 domain 共用。
 *
 * ⚠️ imagePath 从 v0.1 的 NOT NULL 降为可空：通用化后必然有不以图为中心的
 * 采集类型，强制图片会挡住它们。代价是 monster 这个 domain 的图片入口
 * 不再是数据库约束，靠 UI 提示。
 */
export const entries = sqliteTable('entries', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),

  name: text('name').notNull().default(''),

  // 来源。sourceUrl 强制 —— 没有出处的东西不进 Atlas。
  sourceUrl: text('sourceUrl').notNull(),
  sourceTitle: text('sourceTitle').notNull().default(''),
  sourceGame: text('sourceGame').notNull().default(''),

  // 资产。imagePath 是相对 media 根的路径，不是绝对路径。
  imagePath: text('imagePath').notNull().default(''),
  imageSource: text('imageSource').notNull().default('file'),
  originalName: text('originalName').notNull().default(''),

  notes: text('notes').notNull().default(''),

  status: text('status').notNull().default('inbox'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

/**
 * monster 扩展表。1:1，外键指向 entries.id。
 *
 * ⚠️ **只有 taxonomy 表达不了的结构化数据才放这里。**
 *
 * v0.1 的 bodyType / scale / movement / combatRole / attackPattern（离散版）
 * 已被裁掉 —— 它们和 taxonomy 维度重复，留两套就是让用户填两遍，而且两遍
 * 可能不一致。taxonomy 接管那五项。
 *
 * 剩下的四个 *Pattern 是唯一符合「taxonomy 表达不了」的候选：它们有结构、
 * 有先后和组合关系，不是一条刻度上的位置。
 *
 * ⚠️ 没有第二个 domain 出现之前，「哪些字段属于扩展表」这个划分只有理论
 * 保证。跑起来发现放错层，改的是加列不是改表。
 */
export const monsterEntries = sqliteTable('monster_entries', {
  entryId: text('entryId')
    .primaryKey()
    .references(() => entries.id, { onDelete: 'cascade' }),
  attackPattern: text('attackPattern').notNull().default('[]'),
  behaviorPattern: text('behaviorPattern').notNull().default('[]'),
  telegraph: text('telegraph').notNull().default('[]'),
  reactionPattern: text('reactionPattern').notNull().default('[]'),
})

/**
 * tag 名字字典。跨 domain 复用的同一套 tag 系统。
 *
 * ⚠️ **这里没有 origin 字段 —— 这是有意的。**
 * origin（用户输入 vs 系统自动添加）必须挂在 entry_tags 上：tag 表里 `cute`
 * 只有一行，但可能你手动加过、系统也自动加过。origin 挂在 tag 上，
 * 这一行的归属就歧义了。
 */
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

/**
 * entry ↔ tag 关联。
 *
 * ⚠️ origin + ruleId 在这张表上，不在 tags 上。ruleId 是系统 tag 的来源规则
 * 标识 —— 「属于什么项目」这件事的实现基础就是：项目相关的 tag 全部
 * origin='system' + ruleId，可以按规则整批查、整批追溯。
 */
export const entryTags = sqliteTable(
  'entry_tags',
  {
    entryId: text('entryId')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    tagId: text('tagId')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    origin: text('origin').notNull().default('user'),
    ruleId: text('ruleId').notNull().default(''),
    createdAt: text('createdAt').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.tagId] })],
)

/**
 * taxonomy 打分。
 *
 * ⚠️ 维度定义（维度列表、中英文、顺序、极值）**在代码常量里**，不在数据库。
 * 这是「字段要从数据里长出来」的纪律在框架层的应用：现在只有一个 domain，
 * 进表是提前付成本。等第二个 domain 出现、维度真要分叉再搬。
 *
 * ⚠️ 存 0–1 连续分，**不存星数**。星级是显示编码：`star = round(score × 5)`。
 * 界面是 1–5 星（5 档离散）而数据是 0.01 精度（101 档），这个矛盾靠
 * 「点击 0.2 步进 / 方向键 0.01 步进」化解，映射规则写死在 types/atlas.ts。
 */
export const entryTaxonomy = sqliteTable(
  'entry_taxonomy',
  {
    entryId: text('entryId')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    dimensionKey: text('dimensionKey').notNull(),
    score: real('score').notNull(),
    updatedAt: text('updatedAt').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.dimensionKey] })],
)

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