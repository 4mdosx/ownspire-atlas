import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
// ⚠️ types/atlas.ts 是**纯类型 + 常量**，不 import 任何 db 模块 —— 所以这里
// 静态 import 不会成环。它是维度定义的唯一真相来源，seed 只做一次性搬运。
import { MONSTER_TAXONOMY, MONSTER_TAXONOMY_GROUPS } from '@/types/atlas'

export type AppDatabase = NodeSQLiteDatabase

const dbPath = process.env.DB_FILE_NAME
  ? process.env.DB_FILE_NAME.replace(/^file:/, '')
  : path.join(process.cwd(), 'local.db')

/**
 * ⚠️ 连接**必须是可重开的**，不能是模块级常量。
 *
 * 原来这里是 `const sqlite = new DatabaseSync(dbPath)`，配合 `closeDatabase()`
 * 就会把连接关掉且再也开不回来 —— 任何「关库 → 重开 → 验幂等」的路径都跑不了
 * （2026-10-06 做设计空间迁移验证时踩到：`closeDatabase()` 之后任何查询都报
 * `Failed query`，而症状完全指不到「连接已经关了」）。
 *
 * 所以用 getter 惰性打开，关掉后置空 —— 下次调用自动重连。
 * ⚠️ 这是**懒打开**：不在 import 时建连接，那样才可能支持「先设
 * DB_FILE_NAME 再首次打开」这种用法（验证脚本正需要这个）。
 */
let connection: DatabaseSync | null = null

function sqlite(): DatabaseSync {
  if (!connection) connection = new DatabaseSync(dbPath)
  return connection
}

let schemaVersionApplied = 0
const SCHEMA_VERSION = 2

/**
 * v0.1 → v0.2 是破坏性 schema 变更（monster_entries 从业务表变成 1:1 扩展表）。
 *
 * ⚠️ 迁移窗口靠「数据库还是空的」这个事实，不靠迁移脚本。v0.2 交付时
 * entries / tags / entry_tags / entry_taxonomy 四张新表先建好，legacy 的
 * `monster_entries`（还带 name / bodyType 那些列的那张）留着。
 *
 * ⚠️ **legacy 表非空时直接抛错，不自动搬数据。** 这是有意的：真到了有数据
 * 的时候再做一次显式迁移 —— 那时数据形态、id 语义、media 目录都要人工确认，
 * 自动迁移的静默错误比停下来问更贵。0 条数据是这次改造唯一的便宜窗口。
 */
function migrateLegacyMonsterEntries(): void {
  const legacy = sqlite()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='monster_entries'`)
    .get() as { name?: string } | undefined
  if (!legacy) return

  // 新 schema 的 monster_entries 没有 name 列 —— 有的话就是 legacy 表。
  const columns = sqlite().prepare(`PRAGMA table_info(monster_entries)`).all() as Array<{ name: string }>
  const isLegacy = columns.some((column) => column.name === 'name')
  if (!isLegacy) return

  const row = sqlite().prepare(`SELECT COUNT(*) AS n FROM monster_entries`).get() as { n: number }
  if (row.n > 0) {
    throw new Error(
      `检测到 v0.1 旧结构的 monster_entries 且有 ${row.n} 行数据。` +
        'v0.2 是破坏性 schema 变更，需要一次显式迁移（确认 id 语义 + media 目录）。' +
        '先把数据导出成 v0.1 导出包，再清库重跑。',
    )
  }
  sqlite().exec(`DROP TABLE monster_entries`)
}

function ensureSchema(): void {
  if (schemaVersionApplied >= SCHEMA_VERSION) return
  sqlite().exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      sourceUrl TEXT NOT NULL,
      sourceTitle TEXT NOT NULL DEFAULT '',
      sourceGame TEXT NOT NULL DEFAULT '',
      imagePath TEXT NOT NULL DEFAULT '',
      imageSource TEXT NOT NULL DEFAULT 'file',
      originalName TEXT NOT NULL DEFAULT '',
      observed TEXT NOT NULL DEFAULT '',
      read TEXT NOT NULL DEFAULT '',
      worthwhileBecause TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      groupName TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    -- ⚠️ monster 扩展表与 entries 同名不同形（v0.1 那张是业务表，v0.2 是1:1 扩展）。
    -- 名字复用是为了让 migrateLegacyMonsterEntries 能靠列结构判别新旧。
    CREATE TABLE IF NOT EXISTS monster_entries (
      entryId TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entry_tags (
      entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tagId TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      origin TEXT NOT NULL DEFAULT 'user',
      ruleId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      PRIMARY KEY (entryId, tagId)
    );

    CREATE TABLE IF NOT EXISTS entry_taxonomy (
      entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      spaceId TEXT NOT NULL DEFAULT '' REFERENCES design_spaces(id) ON DELETE CASCADE,
      dimensionKey TEXT NOT NULL,
      score REAL NOT NULL,
      setAt TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (entryId, spaceId, dimensionKey)
    );

    CREATE TABLE IF NOT EXISTS import_id_map (
      externalId TEXT PRIMARY KEY,
      localId TEXT NOT NULL,
      importedAt TEXT NOT NULL
    );

    -- ⭐ 设计空间与它的维度（2026-10-06）
    CREATE TABLE IF NOT EXISTS design_spaces (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      labelZh TEXT NOT NULL,
      labelEn TEXT NOT NULL DEFAULT '',
      hintZh TEXT NOT NULL DEFAULT '',
      sortOrder INTEGER NOT NULL DEFAULT 0,
      isBuiltin INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS design_axes (
      id TEXT PRIMARY KEY,
      spaceId TEXT NOT NULL REFERENCES design_spaces(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      labelZh TEXT NOT NULL,
      labelEn TEXT NOT NULL DEFAULT '',
      hintZh TEXT NOT NULL DEFAULT '',
      groupKey TEXT NOT NULL DEFAULT '',
      anchorsJson TEXT NOT NULL DEFAULT '[]',
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS design_axes_space_key ON design_axes(spaceId, key);
    CREATE INDEX IF NOT EXISTS design_axes_space_idx ON design_axes(spaceId, sortOrder);

    CREATE INDEX IF NOT EXISTS entry_tags_tag_idx ON entry_tags(tagId, entryId);
    CREATE INDEX IF NOT EXISTS entry_tags_origin_idx ON entry_tags(origin, ruleId);
    CREATE INDEX IF NOT EXISTS entries_status_idx ON entries(status, createdAt);
    CREATE INDEX IF NOT EXISTS entries_created_idx ON entries(createdAt);
    CREATE INDEX IF NOT EXISTS entries_domain_idx ON entries(domain, createdAt);
    CREATE INDEX IF NOT EXISTS entry_taxonomy_dim_idx ON entry_taxonomy(dimensionKey, score);
  `)
  addMissingColumns()
  migrateLegacyMonsterEntries()
  dropBehaviorColumns()
  migrateTaxonomySpace()
  seedDesignSpaces()
  syncDesignAxes()
  schemaVersionApplied = SCHEMA_VERSION
}

/**
 * ⭐⭐ 丢弃 `monster_entries` 的四个行为列（2026-10-06 域收窄）。
 *
 * ⚠️ **这是删列，所以比加列危险得多** —— 加列最坏是没用上，删列最坏是丢数据。
 * 因此判据不是「这些列不重要」，而是**「这些列里没有非默认值的数据」**：
 *
 *   · 全是 `'[]'`（从未被填过）→ 直接重建表丢掉
 *   · 有任何一条非 `'[]'`       → **抛错停下**，把内容原样留在表里
 *
 * 报错而不是「备份后照样删」：那需要用户来决定「这几条行为描述要不要抢救」，
 * 而代码不该替他决定。停下问一句的成本，远低于「三个月后发现动作笔记没了」。
 *
 * ⚠️ 判断放在**事务外**先查一遍：一旦开始重建，中途失败就只剩半张表。
 */
function dropBehaviorColumns(): void {
  const columns = sqlite().prepare('PRAGMA table_info(monster_entries)').all() as Array<{ name: string }>
  const dropped = ['attackPattern', 'behaviorPattern', 'telegraph', 'reactionPattern']
  const present = dropped.filter((column) => columns.some((item) => item.name === column))
  if (present.length === 0) return

  const marks = present.map((column) => `${column} != '[]'`).join(' OR ')
  const rows = sqlite()
    .prepare(`SELECT count(*) AS n FROM monster_entries WHERE ${marks}`)
    .get() as { n: number }
  if (rows.n > 0) {
    throw new Error(
      `monster_entries 里有 ${rows.n} 条行为描述（${present.join(' / ')}），但 monster 域已收窄为形象设计，这些列要丢掉。\n` +
        '那些内容还没进 notes 的话，先手工搬过去再重试。库里原样保留着，没有丢。',
    )
  }

  sqlite().exec('BEGIN')
  try {
    sqlite().exec(`
      CREATE TABLE monster_entries_new (entryId TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE);
      INSERT INTO monster_entries_new (entryId) SELECT entryId FROM monster_entries;
      DROP TABLE monster_entries;
      ALTER TABLE monster_entries_new RENAME TO monster_entries;
    `)
    sqlite().exec('COMMIT')
  } catch (error) {
    sqlite().exec('ROLLBACK')
    throw error
  }
}

/**
 * ⭐ `entry_taxonomy` 加 spaceId 且主键从 (entryId, dimensionKey) 变成三元组。
 *
 * ⚠️ **SQLite 的 `ALTER TABLE ADD COLUMN` 改不了主键**，所以必须重建表。
 * 这不是「顺手加个列」，是结构性变更 —— 所以要把旧数据**搬过去**，而不是
 * 建一张新表把旧表扔了。
 *
 * ⚠️ **旧数据全部归入「我的」空间**，这是语义判断而不是随便选：v0.2 时期打的
 * 分，全部是「在我的设计语言里我认为它在哪」—— 与那次语义纠正（把「度量」
 * 改成「我的设计空间」）是同一件事。所以搬到 `mine` 是准确的，不是权宜。
 *
 * ⚠️ **搬之前先查旧表存不存在**。全新库里上面那条 `CREATE TABLE IF NOT EXISTS`
 * 已经建出了三元组版本，这时不该重建 —— 重建会把刚建的表连同刚写的种子一起
 * 搞乱。判据是 `PRAGMA table_info` 里有没有 spaceId 列。
 *
 * ⚠️ 整个过程放在一个事务里：中途失败会留下半张表，而那比报错更难收拾。
 */
function migrateTaxonomySpace(): void {
  const columns = sqlite().prepare('PRAGMA table_info(entry_taxonomy)').all() as Array<{ name: string }>
  if (columns.length === 0) return // 表还不存在（全新库），上面的 CREATE 已经建对了
  if (columns.some((item) => item.name === 'spaceId')) return // 已经迁过了

  const mineId = 'space-mine'
  const now = new Date().toISOString()

  // ⚠️ 整个过程放在显式事务里：中途失败会留下半张表（旧的被 DROP 掉、
  // 新的还没搬完），而那比报错更难收拾。
  //
  // ⚠️ 用 BEGIN/COMMIT 显式写，而不是假设 `sqlite().transaction()` —— node:sqlite
  // 的 DatabaseSync **没有** transaction 方法（那是 better-sqlite3 才有的）。
  // 这里的 try/catch 负责回滚。
  sqlite().exec('BEGIN')
  try {
    // ⚠️ 先建空间，否则外键指向不存在的行会被 SQLite 拒绝（外键检查是开的）。
    sqlite().exec(`
      INSERT OR IGNORE INTO design_spaces (id, code, labelZh, labelEn, hintZh, sortOrder, isBuiltin, createdAt, updatedAt)
      VALUES ('${mineId}', 'mine', '我的设计空间', 'My Space', '不是它客观有多强，是我认为它在哪', 10, 1, '${now}', '${now}');

      CREATE TABLE entry_taxonomy_new (
        entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        spaceId TEXT NOT NULL DEFAULT '' REFERENCES design_spaces(id) ON DELETE CASCADE,
        dimensionKey TEXT NOT NULL,
        score REAL NOT NULL,
        setAt TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (entryId, spaceId, dimensionKey)
      );

      INSERT INTO entry_taxonomy_new (entryId, spaceId, dimensionKey, score, setAt, updatedAt)
        SELECT entryId, '${mineId}', dimensionKey, score, setAt, updatedAt FROM entry_taxonomy;

      DROP TABLE entry_taxonomy;
      ALTER TABLE entry_taxonomy_new RENAME TO entry_taxonomy;
    `)
    sqlite().exec('COMMIT')
  } catch (error) {
    sqlite().exec('ROLLBACK')
    throw error
  }
}

/**
 * ⭐ 预置两个设计空间：「原作」与「我的」。
 *
 * ⚠️ **只有「我的」带维度，「原作」刻意留空。** 原作的维度取决于原作是什么
 * 游戏 —— 蘑菇打的是HP/移动速度，Boss 战打的是威胁范围/技能组合。硬塞一套
 * 预置维度进去，就等于又回到了「照搬原作的坐标系」，那正是这套系统要避开的事。
 * 空着，等真的有原作需要填时再按那条原作的实际字段定义。
 *
 * ⚠️ 「我的」的维度从 `types/atlas.ts` 的 MONSTER_TAXONOMY 搬过来，只搬一次 ——
 * 之后维度归数据库管（代码常量那份仅作为**首次初始化的种子**）。
 * 留一份在代码里是为了让新库开箱就有一条完整的「我的」空间，而不是空表。
 */
function seedDesignSpaces(): void {
  const now = new Date().toISOString()

  const builtin = [
    {
      id: 'space-source',
      code: 'source',
      labelZh: '原作坐标系',
      labelEn: 'Source',
      hintZh: '原作里客观是什么样 —— 观察，不是我的判断',
      sortOrder: 20,
    },
    {
      id: 'space-mine',
      code: 'mine',
      labelZh: '我的设计空间',
      labelEn: 'My Space',
      hintZh: '不是它客观有多强，是我认为它在哪',
      sortOrder: 10,
    },
  ]

  for (const space of builtin) {
    sqlite()
      .prepare(
        `INSERT OR IGNORE INTO design_spaces (id, code, labelZh, labelEn, hintZh, sortOrder, isBuiltin, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(space.id, space.code, space.labelZh, space.labelEn, space.hintZh, space.sortOrder, now, now)
  }
}

/**
 * ⭐ 「我的」空间的坐标轴与代码里的种子**保持同步**。
 *
 * ⚠️ 这里曾是 `if (count > 0) return` —— 只在空库时播种，之后维度归 db 管。
 * 那个做法在「维度定义搬进数据库」的那一步是对的，但 2026-10-06 域收窄时
 * 它立刻失效了：库里躺着 5 条旧轴（form/scale/movement/combat/role），
 * 而新定义只有 4 条（form/scale/palette/mobility）。
 *
 * ⚠️ **只增不删的同步是错的**，而「删掉不认识的轴」更危险 —— 用户手工加的
 * 轴会被无声抹掉。所以这里**显式处理三类情况**：
 *
 * 1. **新增**（palette）—— 种子里有、库里没有 → 插进去
 * 2. **改名**（movement → mobility）—— 库里的旧 key 不在种子里，且种子里
 *    有一条「同位置的替代品」→ 改名并搬走已有分数。**不能删了重建**，
 *    那样会丢用户已打的分
 * 3. **删轴**（combat / role）—— 删掉轴定义，但**分数行保留**：那是用户
 *    打的分，删轴是产品决定，不是数据清理。分数留着，将来这轴回来时分数还在
 *
 * ⚠️ 判据「库里的轴不在种子里」只能用来发现**可能**过时，不能直接删 ——
 * 用户完全可能自己加了轴（那正是空间可扩展的目的）。所以只删「曾经是种子
 * 的一部分、现在不在了」的：`SEEDED_AXIS_KEYS` 里记着历史 key。
 */
const SEEDED_AXIS_KEYS: ReadonlySet<string> = new Set([
  // 当前种子
  'form',
  'scale',
  'palette',
  'mobility',
  // 已退出种子（2026-10-06 域收窄）：movement 改名成 mobility，combat/role 砍掉
  'movement',
  'combat',
  'role',
])

function syncDesignAxes(): void {
  // ⚠️ 从 types/atlas.ts import 而不是把定义搬进 database.ts：
  // 定义仍然在那里（那是唯一的真相来源），这里只是做一次性的同步。
  const groupLabel = new Map(MONSTER_TAXONOMY_GROUPS.map((group) => [group.key, group]))
  const now = new Date().toISOString()
  const spaceId = 'space-mine'

  const existing = sqlite().prepare('SELECT key, id FROM design_axes WHERE spaceId = ?').all(spaceId) as Array<{
    key: string
    id: string
  }>
  const existingKeys = new Set(existing.map((row) => row.key))
  const seedKeys = new Set(MONSTER_TAXONOMY.map((axis) => axis.key))

  let order = 0

  // 1. 新增
  const insert = sqlite().prepare(
    `INSERT OR IGNORE INTO design_axes (id, spaceId, key, labelZh, labelEn, hintZh, groupKey, anchorsJson, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const axis of MONSTER_TAXONOMY) {
    if (!existingKeys.has(axis.key)) {
      const group = groupLabel.get(axis.group)
      insert.run(
        `axis-${axis.key}`,
        spaceId,
        axis.key,
        axis.labelZh,
        axis.labelEn,
        axis.hintZh,
        `${group?.labelZh ?? ''}|${group?.labelEn ?? ''}`,
        JSON.stringify(axis.anchors),
        (order += 10),
        now,
        now,
      )
    }
  }

  // 2. 改名：movement → mobility（2026-10-06 域收窄时的唯一一次轴改名）
  //
  // ⚠️ **分数的搬迁不依赖「库里有没有那条轴」**，只看坐标行里有没有那个 key。
  // 理由：轴表可能是全新的（migrateTaxonomySpace 刚建出来），而坐标行是用户
  // 真打过的分 —— 那种情况下「轴表里没有 movement」不代表「没有 movement 的分」。
  //
  // ⚠️ 先搬分数、再改轴的 key，顺序反过来会撞唯一索引
  //（design_axes 有 UNIQUE(spaceId, key)）。
  const now2 = new Date().toISOString()
  const hasOldScores = sqlite()
    .prepare(`SELECT count(*) AS n FROM entry_taxonomy WHERE spaceId = ? AND dimensionKey = 'movement'`)
    .get(spaceId) as { n: number }
  if (hasOldScores.n > 0) {
    sqlite().exec('BEGIN')
    try {
      sqlite()
        .prepare(`UPDATE entry_taxonomy SET dimensionKey = 'mobility' WHERE spaceId = ? AND dimensionKey = 'movement'`)
        .run(spaceId)
      // 轴定义：没有就补一条，有的就改标签（补与改都写成幂等的 upsert）
      sqlite()
        .prepare(
          `INSERT INTO design_axes (id, spaceId, key, labelZh, labelEn, hintZh, groupKey, anchorsJson, sortOrder, createdAt, updatedAt)
           VALUES ('axis-mobility', ?, 'mobility', '动势', 'Mobility', '静止时给人的重量感。它跳不跳、怎么飞，是行为不是形象',
                   '动势|Motion', ?, 40, ?, ?)
           ON CONFLICT(spaceId, key) DO UPDATE SET
             labelZh = excluded.labelZh, labelEn = excluded.labelEn,
             hintZh = excluded.hintZh, groupKey = excluded.groupKey,
             anchorsJson = excluded.anchorsJson, updatedAt = excluded.updatedAt`,
        )
        .run(spaceId, JSON.stringify(['anchored', 'weighted', 'light', 'weightless']), now2, now2)
      sqlite()
        .prepare(`DELETE FROM design_axes WHERE spaceId = ? AND key = 'movement'`)
        .run(spaceId)
      sqlite().exec('COMMIT')
    } catch (error) {
      sqlite().exec('ROLLBACK')
      throw error
    }
  } else if (existingKeys.has('movement')) {
    // ⚠️ 没有分数但有轴定义 —— 只清理轴，不动坐标。
    sqlite().prepare(`DELETE FROM design_axes WHERE spaceId = ? AND key = 'movement'`).run(spaceId)
  }

  // 3. 删掉已退出种子的轴定义。
  // ⚠️ **分数行不动** —— 那是用户打的分。产品决定删轴不等于数据清理。
  for (const key of existingKeys) {
    // 只有「曾经是种子、现在不是」才删。用户自己加的轴（不在 SEEDED 里）一律保留。
    if (SEEDED_AXIS_KEYS.has(key) && !seedKeys.has(key)) {
      sqlite().prepare('DELETE FROM design_axes WHERE spaceId = ? AND key = ?').run(spaceId, key)
    }
  }

  // 4. 更新已有轴的显示信息（标签/档位改了要跟着变）
  const update = sqlite().prepare(
    `UPDATE design_axes SET labelZh = ?, labelEn = ?, hintZh = ?, groupKey = ?, anchorsJson = ?, updatedAt = ?
     WHERE spaceId = ? AND key = ?`,
  )
  for (const axis of MONSTER_TAXONOMY) {
    if (!existingKeys.has(axis.key)) continue // 新增的已经插对了
    const group = groupLabel.get(axis.group)
    update.run(
      axis.labelZh,
      axis.labelEn,
      axis.hintZh,
      `${group?.labelZh ?? ''}|${group?.labelEn ?? ''}`,
      JSON.stringify(axis.anchors),
      now,
      spaceId,
      axis.key,
    )
  }
}

/**
 * 给已存在的表补列。
 *
 * ⚠️ 为什么需要这一步：`CREATE TABLE IF NOT EXISTS` 对**已存在**的表是
 * 完全的 no-op —— 加了新的列定义，老库也不会长出那一列。而这个项目的
 * 迁移窗口是「库是空的」（见 migrateLegacyMonsterEntries 的注释），所以
 * 正常路径下老库不该存在；可一旦有人手工加过列、或从旧版本带着库升级，
 * 就会撞上「schema 声明了但表里没有」的情况，而症状是难懂的
 * `no such column: observed` —— 报错完全指不到「你的库比代码旧」这件事。
 *
 * 所以显式补列。**只加列，不改类型、不删列、不搬数据**：
 * 改类型和搬数据都属于「可能丢信息」，那种宁可停下来问。
 *
 * SQLite 的 `ALTER TABLE ADD COLUMN` 要求新列有默认值或可空，
 * 这里所有列都给了 DEFAULT ''，所以能直接加。
 */
const COLUMNS_TO_ADD: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'entries', column: 'observed', ddl: "ALTER TABLE entries ADD COLUMN observed TEXT NOT NULL DEFAULT ''" },
  { table: 'entries', column: 'read', ddl: "ALTER TABLE entries ADD COLUMN read TEXT NOT NULL DEFAULT ''" },
  {
    table: 'entries',
    column: 'worthwhileBecause',
    ddl: "ALTER TABLE entries ADD COLUMN worthwhileBecause TEXT NOT NULL DEFAULT ''",
  },
  { table: 'tags', column: 'groupName', ddl: "ALTER TABLE tags ADD COLUMN groupName TEXT NOT NULL DEFAULT ''" },
  {
    table: 'entry_taxonomy',
    column: 'setAt',
    ddl: "ALTER TABLE entry_taxonomy ADD COLUMN setAt TEXT NOT NULL DEFAULT ''",
  },
]

function addMissingColumns(): void {
  for (const { table, column, ddl } of COLUMNS_TO_ADD) {
    const existing = sqlite().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    // 表本身可能还不存在（全新库）—— 那时 CREATE TABLE 已经带上了新列。
    if (existing.length === 0) continue
    if (existing.some((item) => item.name === column)) continue
    sqlite().exec(ddl)
  }

  // entries.notes 是已废弃的别名。新库不写它，但老库里已有内容 ——
  // **保守地搬进 observed**：不猜用户哪些是判断，猜错比不猜贵。
  // 要挪的话用户在界面上自己动手。
  const columns = sqlite().prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>
  if (!columns.some((item) => item.name === 'notes')) return
  sqlite().exec(
    `UPDATE entries SET observed = notes WHERE observed = '' AND notes != ''`,
  )
}

/**
 * media 根目录。
 *
 * ⚠️ 只返回路径，不创建 —— v0 里写入方（上传接口）负责确保目录存在。
 * 读方碰不到这个函数，避免浏览 Gallery 时顺手在磁盘上撒目录。
 */
export function mediaRoot(): string {
  const configured = process.env.MEDIA_ROOT?.trim()
  if (configured) return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured)
  return path.join(process.cwd(), 'media')
}

/** 把 DB 里的相对路径还原成可读绝对路径。 */
export function resolveMediaPath(relative: string): string {
  const root = mediaRoot()
  const resolved = path.resolve(root, relative)
  // 相对路径里出现 .. 会逃出 media 根 —— 这是从导入包来的不可信输入，必须挡住。
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`图片路径逃出了 media 根：${relative}`)
  }
  return resolved
}

const globalForDb = globalThis as unknown as { db: AppDatabase | undefined }

export function pingDatabase(): void {
  ensureSchema()
  sqlite().prepare('SELECT 1').get()
}

export async function getDatabase(): Promise<AppDatabase> {
  ensureSchema()
  if (!globalForDb.db) globalForDb.db = drizzle({ client: sqlite() })
  return globalForDb.db
}

export async function closeDatabase(): Promise<void> {
  globalForDb.db = undefined
  // ⚠️ 必须置空 connection —— 否则下次 `sqlite()` 拿到的是已关闭的句柄，
  // 症状是 `Failed query: ...`，完全指不到「连接已经关了」。
  connection?.close()
  connection = null
  // ⚠️ schemaVersionApplied 也必须清零 —— 不然重开后 ensureSchema 会因为
  // 「本进程迁移过了」直接 return，跳过所有建表与迁移。新连接面对的是同一个
  // 文件，理应重新确认一次结构。
  schemaVersionApplied = 0
}

/** 容器启动前先探测数据库可用 —— /healthz 要返回这个。 */
export function databaseFile(): string {
  return dbPath
}

export function mediaRootExists(): boolean {
  try {
    return fs.statSync(mediaRoot()).isDirectory()
  } catch {
    return false
  }
}