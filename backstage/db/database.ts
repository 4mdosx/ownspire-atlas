import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
// types/atlas.ts 提供首次建库种子；运行时轴定义只从 design_axes 读取。
import { CREATURE_AXIS_SEEDS, CREATURE_AXIS_GROUPS } from '@/types/atlas'
import { designAxes, designSpaces } from '@/backstage/db/schema'

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

/**
 * 迁移文件的位置。
 *
 * ⚠️ 这是**运行时**读的目录，不是构建期打包进 bundle 的资源 —— 所以容器镜像里
 * 必须把 `drizzle/` 一起 COPY 进去（Dockerfile 里有这一行，别删）。
 * 用 `process.cwd()` 拼而不是 import 一个常量，是为了让验证脚本能把 cwd 指到别处跑。
 */
function migrationsFolder(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'drizzle')
}

/**
 * 拒绝给**迁移系统之前**的旧库跑迁移。
 *
 * ⚠️ 必须在 `migrate()` **之前**跑，且早于任何写操作 —— 因为 `migrate()` 撞上
 * 已经存在的表只会抛一句 `table entries already exists`，而那句指不到
 * 「你手上是个 2026-10 之前建的库」这个真正的原因。
 *
 * ⚠️ 只**报错**，不搬运。自动迁移的静默错误比停下来问更贵。
 */
function assertNotLegacySchema(): void {
  const oldTable = sqlite().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entry_taxonomy'").get()
  const entryColumns = sqlite().prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>
  const tagColumns = sqlite().prepare('PRAGMA table_info(tags)').all() as Array<{ name: string }>
  const entryTagColumns = sqlite().prepare('PRAGMA table_info(entry_tags)').all() as Array<{ name: string }>
  if (oldTable || entryColumns.some((column) => column.name === 'notes') ||
      entryColumns.some((column) => column.name === 'sourceUrl') ||
      tagColumns.some((column) => column.name === 'groupName') ||
      (entryTagColumns.length > 0 && !entryTagColumns.some((column) => column.name === 'confidence'))) {
    throw new Error('检测到旧版数据库结构。请先执行显式迁移，数据库未被修改。')
  }
}

/**
 * 两个内置设计空间 + 「我的」空间的维度种子。
 *
 * ⚠️ 判据是「design_spaces 里没有东西」，不是「这是不是新库」。种子写成幂等的
 * 好处是：内置空间万一被误删，重启能自己长回来，而不是让整个轴系统空着
 * 且没有任何报错。
 */
async function seedBuiltinSpaces(database: AppDatabase): Promise<void> {
  const existing = await database.select({ id: designSpaces.id }).from(designSpaces).limit(1)
  if (existing.length > 0) return
  const now = new Date().toISOString()
  await database.insert(designSpaces).values([
    {
      id: 'space-mine', code: 'mine', labelZh: '我的设计空间', labelEn: 'My Space',
      hintZh: '不是它客观有多强，是我认为它在哪', sortOrder: 10,
      isBuiltin: 1, createdAt: now, updatedAt: now,
    },
    {
      id: 'space-source', code: 'source', labelZh: '原作坐标系', labelEn: 'Source',
      hintZh: '原作里客观是什么样 —— 观察，不是我的判断', sortOrder: 20,
      isBuiltin: 1, createdAt: now, updatedAt: now,
    },
  ])
  const groups = new Map(CREATURE_AXIS_GROUPS.map((group) => [group.key, group]))
  await database.insert(designAxes).values(
    CREATURE_AXIS_SEEDS.map((axis, index) => {
      const group = groups.get(axis.group)
      return {
        id: `axis-${axis.key}`,
        spaceId: 'space-mine',
        key: axis.key,
        labelZh: axis.labelZh,
        labelEn: axis.labelEn,
        hintZh: axis.hintZh,
        groupKey: `${group?.labelZh ?? ''}|${group?.labelEn ?? ''}`,
        anchorsJson: JSON.stringify(axis.anchors),
        sortOrder: (index + 1) * 10,
        createdAt: now,
        updatedAt: now,
      }
    }),
  )
}

/**
 * ⭐ 结构由 drizzle 迁移建立（`drizzle-kit generate` 产出，`schema.ts` 是唯一真相）。
 *
 * ⚠️ **这里不再有第二份 CREATE TABLE。** 之前是「手写 SQL 建表 + schema.ts 定义
 * 查询类型」两份各写一遍 —— 改了 schema.ts 忘了改 SQL（或反过来）没有任何报错
 * 路径，只有真跑一次插入才暴露。现在删掉手写那份，剩下唯一一份是 schema.ts。
 */
async function ensureSchema(): Promise<void> {
  if (schemaReady) return
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  assertNotLegacySchema()
  const database = db()
  migrate(database, { migrationsFolder: migrationsFolder() })
  await seedBuiltinSpaces(database)
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
  // ⚠️ 相对路径是 `path.join(cwd, 动态段)`。healthz 把这个函数打进 server bundle 后，
  // Turbopack 会据此把整个仓库追进 server trace（镜像构建被撑大，甚至直接失败）。
  // 这是运行时目录，不是要打包的项目文件。
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(/* turbopackIgnore: true */ process.cwd(), configured)
  }
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

/**
 * drizzle 实例。与 `sqlite()` 一样是**可重开的**：`closeDatabase()` 把它置空，
 * 下次调用重新包一个 —— 见 `sqlite()` 上方那条教训。
 */
function db(): AppDatabase {
  if (!globalForDb.db) globalForDb.db = drizzle({ client: sqlite() })
  return globalForDb.db
}

export async function pingDatabase(): Promise<void> {
  await ensureSchema()
  sqlite().prepare('SELECT 1').get()
}

export async function getDatabase(): Promise<AppDatabase> {
  await ensureSchema()
  return db()
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
    return fs.statSync(/* turbopackIgnore: true */ mediaRoot()).isDirectory()
  } catch {
    return false
  }
}
