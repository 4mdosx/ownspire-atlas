import { sql } from 'drizzle-orm'
import { getDatabase } from './database'

/**
 * 建库。幂等 —— 可以重复跑。
 *
 * 用法：`npm run init-db`
 * serve 之前也调一次 ensureSchema，所以这个脚本主要是给「第一次跑」和
 * 「出问题时手工修库」用的。
 *
 * ⚠️ 这里**不写** `import 'server-only'`。那个模块在 Next 编译期会被替换成
 * 「import 就抛错」的桩，用来防客户端组件误引service；但 tsx 直接跑脚本时
 * 它就是一颗真炸弹。脚本文件与服务模块的界线就在这一行。
 * （navi 的 init-db / clear-pin 同样不写这一行，本项目与它保持一致。）
 *
 * ⚠️ 表清单与计数都走 `sql` 模板，不碰 `db.$client`（drizzle-orm 1.0-rc 的
 * 内部字段，类型上不存在，版本一升就断），也不依赖 `db.run()` 的返回类型
 * （那个在 rc 版里是 StatementResultingChanges，给读操作用不可靠）。
 */
async function main() {
  const db = await getDatabase()

  const tableRows = await db.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `)
  console.log('表已就绪：')
  for (const row of tableRows) console.log(`  ${row.name}`)

  const countRows = await db.all<{ entryCount: number; tagCount: number; taxonomyCount: number }>(sql`
    SELECT
      (SELECT count(*) FROM entries) AS entryCount,
      (SELECT count(*) FROM tags) AS tagCount,
      (SELECT count(*) FROM entry_taxonomy) AS taxonomyCount
  `)
  const row = countRows[0]
  console.log(`条目 ${row?.entryCount ?? 0} 条 · 标签 ${row?.tagCount ?? 0} 个 · 打分 ${row?.taxonomyCount ?? 0} 条`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})