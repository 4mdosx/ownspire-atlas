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
      entryId TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      attackPattern TEXT NOT NULL DEFAULT '[]',
      behaviorPattern TEXT NOT NULL DEFAULT '[]',
      telegraph TEXT NOT NULL DEFAULT '[]',
      reactionPattern TEXT NOT NULL DEFAULT '[]'
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
  migrateTaxonomySpace()
  seedDesignSpaces()
  schemaVersionApplied = SCHEMA_VERSION
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

  // 「我的」空间的维度：种子数据。插完即止（IGNORE），之后维度归 db 管。
  const count = sqlite().prepare('SELECT count(*) AS n FROM design_axes WHERE spaceId = ?').get('space-mine') as { n: number }
  if (count.n > 0) return

  // ⚠️ 这里刻意从 types/atlas.ts import 而不是把维度定义搬进 database.ts：
  // 定义仍然在那里（那是唯一的真相来源），db 只做一次性的搬运。
  const groupLabel = new Map(MONSTER_TAXONOMY_GROUPS.map((group) => [group.key, group]))
  const insert = sqlite().prepare(
    `INSERT OR IGNORE INTO design_axes (id, spaceId, key, labelZh, labelEn, hintZh, groupKey, anchorsJson, sortOrder, createdAt, updatedAt)
     VALUES (?, 'space-mine', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let order = 0
  for (const axis of MONSTER_TAXONOMY) {
    const group = groupLabel.get(axis.group)
    insert.run(
      `axis-${axis.key}`,
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