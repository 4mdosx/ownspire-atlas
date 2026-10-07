import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
// ⚠️ types/atlas.ts 是**纯类型 + 常量**，不 import 任何 db 模块 —— 所以这里
// 静态 import 不会成环。它是维度定义的唯一真相来源，seed 只做一次性搬运。
import { MONSTER_TAXONOMY, MONSTER_TAXONOMY_GROUPS } from '@/types/atlas'

export type AppDatabase = NodeSQLiteDatabase

/**
 * ⭐ 数据库路径的解析。
 *
 * ⚠️⚠️ **默认不在项目目录里，而在 `DATA_DIR`（2026-10-07 改）**。
 *
 * 起因是一次实测：同一个 db 文件，**放在 `/tmp` 能正常写，放在项目目录里连
 * `CREATE TABLE` 都报 `disk I/O error`**：
 *
 *   /tmp/probe.db   →✓ 写事务正常、WAL 可切换
 *   ./probe2.db     → ✗ CREATE TABLE 直接disk I/O error
 *
 * 而报错**完全指不到真正的原因** —— 第一次遇到时我以为是数据库损坏，
 * 于是去删journal、换 pragma，绕了半圈。真正的分界是**文件所在目录**，
 * 不是文件本身。
 *
 * ⚠️ 推测是 WorkBuddy 的 safe-delete shim 对工作区内路径的文件操作有额外限制
 * （同一个 rename 拦截让 `.next` 必须做成符号链接）。**不必深究** —— 判据
 * 清楚且后果明确：**代码在项目里，数据在外面**，这也是更常规的分开。
 *
 * ⚠️ **迁移说明**：改动前库在`<repo>/local.db`。首次启动时若新位置没有库而旧
 * 位置有，会自动复制过去并打一行日志 —— 那是唯一一次搬数据，之后靠正常
 * 备份流程（导出包）。
 *
 * 想留在项目里可以显式指定 `DB_FILE_NAME=./local.db`，但那个位置在本机会
 * 遇到上面那个写限制。
 */
const DEFAULT_DATA_DIR = path.join(process.env.HOME ?? process.cwd(), '.local', 'share', 'creative-atlas')

function resolveDbPath(): string {
  const explicit = process.env.DB_FILE_NAME
  if (explicit) return explicit.replace(/^file:/, '')
  // ⚠️ 先看新位置有没有库：有就直接用（不覆盖），没有才看旧的。
  const target = path.join(process.env.DATA_DIR ?? DEFAULT_DATA_DIR, 'atlas.db')
  if (fs.existsSync(target)) return target
  const legacy = path.join(process.cwd(), 'local.db')
  if (fs.existsSync(legacy)) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(legacy, target)
      console.warn(`[atlas] 数据库已从 ${legacy} 复制到 ${target}（工作区内无法正常写入，见 database.ts 的注释）`)
    } catch (error) {
      //⚠️ 搬不动就退回旧路径 —— 报错比「静默建一个空库」好。
      return legacy
    }
  }
  return target
}

const dbPath = resolveDbPath()

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
  if (connection) return connection
  const opened = new DatabaseSync(dbPath)
  //⭐ 连接建立时立刻设这三项，而不是每次查询前 —— 因为它们是**连接级**设置。
  //
  // ⚠️ `busy_timeout` 是修「读时报 `database is locked`」的标准解法（默认 0ms，
  //    意味着「一撞到锁就立刻报错」而不是等）。dev server 与验证脚本常同时开着，
  //    没有它就是随机失败。
  //
  // ⚠️ `journal_mode = WAL` 让读不阻塞写。默认的 rollback journal 在有读者时
  //    会挡住写者 —— 对这个「一个进程写、偶尔读」的小库，WAL 是标准选择。
  // ⚠️ `synchronous = NORMAL` 是 WAL 的配套：省掉每次事务的fsync。个人采集库
  //    丢一次事务可以接受（下次重新操作），而每次 fsync 会让采集变卡。
  //
  // ⚠️⚠️ **别用「删掉 -journal 文件」当修法**（2026-10-07踩过）：它出现的
  // 根因是**上一个进程被中断**（dev server 被 kill、build 失败），而 SQLite
  // 会认为有未完成的事务要回滚。手动删 journal 绕过了回滚，于是那些「未完成」
  // 的部分留在库里，症状是 `disk I/O error` —— 而它的报错完全指不到真正的原因。
  //    **正确做法是让下一个进程自己回滚**（也就是设 busy_timeout 并重开连接）。
  for (const pragma of ['PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL']) {
    opened.exec(pragma)
  }
  connection = opened
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
  // ⚠️ 数据目录可能还不存在（新装 / 首次迁移）。SQLite 不会自己建父目录，
  // 而建库失败时报的是 `unable to open database file` —— 完全指不到「目录
  // 不存在」这件事，所以在这里显式建。
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
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
      analysisStatus TEXT NOT NULL DEFAULT 'committed',
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
  migrateDomainRename()
  dropBehaviorColumns()
  migrateTaxonomySpace()
  seedDesignSpaces()
  syncDesignAxes()
  schemaVersionApplied = SCHEMA_VERSION
}

/**
 * ⭐ `entries.domain` 的 code 改名：`monster` → `creature`（2026-10-07）。
 *
 * ⚠️ 为什么改：domain 从「分类」变成「**一个创作问题**」（见 types/atlas.ts
 * 的注释）。而 `monster` 这个名字在我们自己的对话里已经被用成「完整设计」的
 * 意思了 —— combat / encounter 都属于 monster design。**叫 monster 会让边界
 * 迟早重新膨胀**，因为看到这个名字就会觉得「战斗相关的东西也该放进来」。
 *
 * ⚠️ **`monster` 的向后兼容是刻意的**：monster_entries 表沿用旧名，且
 * DOMAIN_ALIASES 里保留映射 —— 读的时候两个 code 都认，所以旧导出包与旧脚本
 * 不会突然失效。**改名的是「我们怎么称呼它」，不是「历史数据变成非法」。**
 *
 * ⚠️ 迁移只UPDATE 值，不动结构。而 `entries.domain` 上可能有个索引
 * （entries_domain_idx），UPDATE 会自动维护它。
 */
const DOMAIN_RENAMES: ReadonlyArray<{ from: string; to: string }> = [{ from: 'monster', to: 'creature' }]

function migrateDomainRename(): void {
  for (const { from, to } of DOMAIN_RENAMES) {
    const count = sqlite().prepare('SELECT count(*) AS n FROM entries WHERE domain = ?').get(from) as { n: number }
    if (count.n === 0) continue
    sqlite().prepare('UPDATE entries SET domain = ? WHERE domain = ?').run(to, from)
  }
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
  // 当前种子（六根视觉轴，2026-10-07）
  'visualMass',
  'proportion',
  'shapeLanguage',
  'visualComplexity',
  'familiarity',
  'threatAffinity',
  // 域收窄时退出种子（2026-10-06）：combat / role 属玩法不属造型，砍掉
  'combat',
  'role',
  // 「分类不是刻度」的修正（2026-10-07）：form 降级成 tag 分组、palette 改成
  // 观察项、mobility 划给 Animation domain。⚠️ 三条里有两条（form / scale）
  // 曾经打过分，所以仍然搬：删了重建会丢用户已打的分。
  'form',
  'scale',
  'palette',
  'mobility',
  // 更早的：movement 是 mobility 的前身
  'movement',
])

/**
 * 退役轴 → 现役轴的分数搬家映射。
 *
 * ⚠️ **只有语义仍然成立的关系才写在这里。** `form` / `palette` / `mobility`
 * 刻意不在表里 —— 它们被降级成 tag / 观察项 / 划给别的 domain，把它们的分塞进
 * 某个新轴等于伪造一次用户没做过的判断。
 */
const AXIS_MOVES: ReadonlyArray<readonly [string, string]> = [['scale', 'visualMass']]

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

  // 2. 搬迁退役轴的用户分数（2026-10-07）
  //
  // ⚠️ **判据只看坐标行，不看轴表**：轴表可能是全新的（刚被迁移建出来），
  // 而坐标行是用户真打过的分。「轴表里没有 scale」不代表「没有 scale 的分」。
  //
  // ⚠️ **映射显式、不猜**：每一条退役轴都要写清它的分数去哪儿。
  //「猜一个最接近的」会让一次语义修正变成一次静默的数据篡改。
  //
  // ⚠️ **`form` / `palette` / `mobility` 的分数刻意不搬** —— 那三条轴的性质
  // 变了（form 变成 Tag 分组、palette 改成观察项、mobility 划给 Animation
  // domain），把它们塞进某个新轴等于伪造一次用户没做过的判断。
  // 只有 `scale → visualMass` 是真搬家：体量感仍是视觉体量的一部分，
  // 用户的判断没有因为改名而失效。
  //
  // ⚠️ 退役轴的**定义**在第 3 步统一删；没搬走的分数行留在坐标表里，
  // 等那个概念重新出现时还能找回。
  for (const [from, to] of AXIS_MOVES) {
    const count = sqlite()
      .prepare('SELECT count(*) AS n FROM entry_taxonomy WHERE spaceId = ? AND dimensionKey = ?')
      .get(spaceId, from) as { n: number }
    if (count.n === 0) continue
    sqlite().exec('BEGIN')
    try {
      // ⚠️ 先清目标轴上已有的分再搬 —— 目标可能已经被用户自己填过了
      // （「先有 scale、后有 visualMass」的那种用户），直接覆盖会丢。
      sqlite().prepare('DELETE FROM entry_taxonomy WHERE spaceId = ? AND dimensionKey = ?').run(spaceId, to)
      sqlite()
        .prepare('UPDATE entry_taxonomy SET dimensionKey = ?, updatedAt = ? WHERE spaceId = ? AND dimensionKey = ?')
        .run(to, now, spaceId, from)
      sqlite().exec('COMMIT')
    } catch (error) {
      sqlite().exec('ROLLBACK')
      throw error
    }
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
    table: 'entries',
    column: 'analysisStatus',
    ddl: "ALTER TABLE entries ADD COLUMN analysisStatus TEXT NOT NULL DEFAULT 'committed'",
  },
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