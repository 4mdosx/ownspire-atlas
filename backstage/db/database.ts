import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
// types/atlas.ts 提供首次建库种子；运行时轴定义只从 design_axes 读取。
import { CREATURE_AXIS_SEEDS, CREATURE_AXIS_GROUPS } from '@/types/atlas'

export type AppDatabase = NodeSQLiteDatabase

/** Database location. Explicit paths are used by verification scripts. */
const DEFAULT_DATA_DIR = path.join(process.env.HOME ?? process.cwd(), '.local', 'share', 'creative-atlas')

function resolveDbPath(): string {
  return process.env.DB_FILE_NAME || path.join(process.env.DATA_DIR ?? DEFAULT_DATA_DIR, 'atlas.db')
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

let schemaReady = false

/** The current schema is created directly. Older databases need an explicit, reviewed migration. */
function ensureSchema(): void {
  if (schemaReady) return
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const oldTable = sqlite().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entry_taxonomy'").get()
  const entryColumns = sqlite().prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>
  const tagColumns = sqlite().prepare('PRAGMA table_info(tags)').all() as Array<{ name: string }>
  const entryTagColumns = sqlite().prepare('PRAGMA table_info(entry_tags)').all() as Array<{ name: string }>
  const freshDatabase = entryColumns.length === 0
  if (oldTable || entryColumns.some((column) => column.name === 'notes') ||
      tagColumns.some((column) => column.name === 'groupName') ||
      (entryTagColumns.length > 0 && !entryTagColumns.some((column) => column.name === 'confidence'))) {
    throw new Error('检测到旧版数据库结构。请先执行显式迁移，数据库未被修改。')
  }

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
      status TEXT NOT NULL DEFAULT 'pending_ai' CHECK (status IN ('pending_ai', 'inbox', 'reviewed')),
      analysisStatus TEXT NOT NULL DEFAULT 'committed',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monster_entries (
      entryId TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS entry_tags (
      entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tagId TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      origin TEXT NOT NULL DEFAULT 'user',
      ruleId TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
      createdAt TEXT NOT NULL,
      PRIMARY KEY (entryId, tagId)
    );
    CREATE TABLE IF NOT EXISTS import_id_map (
      externalId TEXT PRIMARY KEY,
      localId TEXT NOT NULL,
      importedAt TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS entry_axis_values (
      entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      spaceId TEXT NOT NULL REFERENCES design_spaces(id) ON DELETE CASCADE,
      axisKey TEXT NOT NULL,
      value REAL NOT NULL CHECK (value >= 0 AND value <= 1),
      setAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (entryId, spaceId, axisKey)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS design_axes_space_key ON design_axes(spaceId, key);
    CREATE INDEX IF NOT EXISTS design_axes_space_idx ON design_axes(spaceId, sortOrder);
    CREATE INDEX IF NOT EXISTS entry_tags_tag_idx ON entry_tags(tagId, entryId);
    CREATE INDEX IF NOT EXISTS entry_tags_origin_idx ON entry_tags(origin, ruleId);
    CREATE INDEX IF NOT EXISTS entries_status_idx ON entries(status, createdAt);
    CREATE INDEX IF NOT EXISTS entries_created_idx ON entries(createdAt);
    CREATE INDEX IF NOT EXISTS entries_domain_idx ON entries(domain, createdAt);
    CREATE INDEX IF NOT EXISTS entry_axis_values_idx ON entry_axis_values(spaceId, axisKey, value);
  `)

  if (freshDatabase) {
    const now = new Date().toISOString()
    const spaces = [
      ['space-mine', 'mine', '我的设计空间', 'My Space', '不是它客观有多强，是我认为它在哪', 10],
      ['space-source', 'source', '原作坐标系', 'Source', '原作里客观是什么样 —— 观察，不是我的判断', 20],
    ] as const
    const insertSpace = sqlite().prepare(`INSERT INTO design_spaces
    (id, code, labelZh, labelEn, hintZh, sortOrder, isBuiltin, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    for (const space of spaces) insertSpace.run(...space, now, now)

    const groups = new Map(CREATURE_AXIS_GROUPS.map((group) => [group.key, group]))
    const insertAxis = sqlite().prepare(`INSERT INTO design_axes
      (id, spaceId, key, labelZh, labelEn, hintZh, groupKey, anchorsJson, sortOrder, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [index, axis] of CREATURE_AXIS_SEEDS.entries()) {
      const group = groups.get(axis.group)
      insertAxis.run(`axis-${axis.key}`, 'space-mine', axis.key, axis.labelZh, axis.labelEn,
        axis.hintZh, `${group?.labelZh ?? ''}|${group?.labelEn ?? ''}`,
        JSON.stringify(axis.anchors), (index + 1) * 10, now, now)
    }
  }
  schemaReady = true
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
  schemaReady = false
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
