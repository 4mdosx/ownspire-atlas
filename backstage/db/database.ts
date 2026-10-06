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
const SCHEMA_VERSION = 1

function ensureSchema(): void {
  if (schemaVersionApplied >= SCHEMA_VERSION) return
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS monster_entries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      sourceUrl TEXT NOT NULL,
      sourceTitle TEXT NOT NULL DEFAULT '',
      sourceGame TEXT NOT NULL DEFAULT '',
      imagePath TEXT NOT NULL,
      imageSource TEXT NOT NULL DEFAULT 'file',
      originalName TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      bodyType TEXT NOT NULL DEFAULT '',
      scale TEXT NOT NULL DEFAULT '',
      movement TEXT NOT NULL DEFAULT '[]',
      combatRole TEXT NOT NULL DEFAULT '[]',
      attackPattern TEXT NOT NULL DEFAULT '[]',
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

    CREATE TABLE IF NOT EXISTS entry_tags (
      entryId TEXT NOT NULL REFERENCES monster_entries(id) ON DELETE CASCADE,
      tagId TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (entryId, tagId)
    );

    CREATE TABLE IF NOT EXISTS import_id_map (
      externalId TEXT PRIMARY KEY,
      localId TEXT NOT NULL,
      importedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS entry_tags_tag_idx ON entry_tags(tagId, entryId);
    CREATE INDEX IF NOT EXISTS monster_entries_status_idx ON monster_entries(status, createdAt);
    CREATE INDEX IF NOT EXISTS monster_entries_created_idx ON monster_entries(createdAt);
  `)
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