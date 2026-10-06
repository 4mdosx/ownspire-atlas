import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'

export type AppDatabase = NodeSQLiteDatabase

const dbPath = process.env.DB_FILE_NAME
  ? process.env.DB_FILE_NAME.replace(/^file:/, '')
  : path.join(process.cwd(), 'local.db')

const sqlite = new DatabaseSync(dbPath)

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
  const legacy = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='monster_entries'`)
    .get() as { name?: string } | undefined
  if (!legacy) return

  // 新 schema 的 monster_entries 没有 name 列 —— 有的话就是 legacy 表。
  const columns = sqlite.prepare(`PRAGMA table_info(monster_entries)`).all() as Array<{ name: string }>
  const isLegacy = columns.some((column) => column.name === 'name')
  if (!isLegacy) return

  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM monster_entries`).get() as { n: number }
  if (row.n > 0) {
    throw new Error(
      `检测到 v0.1 旧结构的 monster_entries 且有 ${row.n} 行数据。` +
        'v0.2 是破坏性 schema 变更，需要一次显式迁移（确认 id 语义 + media 目录）。' +
        '先把数据导出成 v0.1 导出包，再清库重跑。',
    )
  }
  sqlite.exec(`DROP TABLE monster_entries`)
}

function ensureSchema(): void {
  if (schemaVersionApplied >= SCHEMA_VERSION) return
  sqlite.exec(`
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
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
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
      dimensionKey TEXT NOT NULL,
      score REAL NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (entryId, dimensionKey)
    );

    CREATE TABLE IF NOT EXISTS import_id_map (
      externalId TEXT PRIMARY KEY,
      localId TEXT NOT NULL,
      importedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS entry_tags_tag_idx ON entry_tags(tagId, entryId);
    CREATE INDEX IF NOT EXISTS entry_tags_origin_idx ON entry_tags(origin, ruleId);
    CREATE INDEX IF NOT EXISTS entries_status_idx ON entries(status, createdAt);
    CREATE INDEX IF NOT EXISTS entries_created_idx ON entries(createdAt);
    CREATE INDEX IF NOT EXISTS entries_domain_idx ON entries(domain, createdAt);
    CREATE INDEX IF NOT EXISTS entry_taxonomy_dim_idx ON entry_taxonomy(dimensionKey, score);
  `)
  migrateLegacyMonsterEntries()
  schemaVersionApplied = SCHEMA_VERSION
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
  sqlite.prepare('SELECT 1').get()
}

export async function getDatabase(): Promise<AppDatabase> {
  ensureSchema()
  if (!globalForDb.db) globalForDb.db = drizzle({ client: sqlite })
  return globalForDb.db
}

export async function closeDatabase(): Promise<void> {
  globalForDb.db = undefined
  sqlite.close()
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