/** Verify that a fresh database uses only the current Axis schema. */
import { sql } from 'drizzle-orm'

async function main(): Promise<void> {
  process.env.DB_FILE_NAME = `/tmp/atlas-axis-schema-${Date.now()}.db`
  const { closeDatabase, getDatabase, pingDatabase } = await import('@/backstage/db/database')

  for (let pass = 0; pass < 2; pass += 1) {
    pingDatabase()
    const db = await getDatabase()
    const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
    const names = new Set(tables.map((row) => row.name))
    if (!names.has('entry_axis_values') || names.has('entry_taxonomy')) {
      throw new Error('Axis 表不是唯一的评分存储')
    }
    const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(entries)`)
    if (columns.some((column) => column.name === 'notes')) throw new Error('旧 notes 列仍存在')
    const tagColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(tags)`)
    if (tagColumns.some((column) => column.name === 'groupName')) throw new Error('旧 tag 分组列仍存在')
    const linkColumns = await db.all<{ name: string }>(sql`PRAGMA table_info(entry_tags)`)
    if (!linkColumns.some((column) => column.name === 'confidence')) throw new Error('tag 关联缺少 confidence')
    const axes = await db.all<{ count: number }>(sql`SELECT count(*) AS count FROM design_axes WHERE spaceId = 'space-mine'`)
    if (axes[0]?.count !== 6) throw new Error(`预置轴数量错误：${axes[0]?.count}`)
    await closeDatabase()
  }
  console.log('Axis schema and reopening: 2/2 passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
