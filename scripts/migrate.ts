/**
 * 手动跑迁移（`npm run db:migrate`）。
 *
 * 应用启动时 `getDatabase()` 会自动跑到最新，所以这个脚本是给**运维**用的：
 * 部署前先单独跑一次，让「结构没跟上」这件事在启动前响，而不是混在第一次
 * 请求的 500 里。
 */
import { databaseFile, getDatabase } from '@/backstage/db/database'

async function main(): Promise<void> {
  await getDatabase()
  console.log(`迁移已到最新：${databaseFile()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
