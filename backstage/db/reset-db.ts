import 'server-only'
import fs from 'node:fs'
import { databaseFile, mediaRoot } from './database'

/**
 * 清库。⚠️ 会删掉 local.db 与 media 下所有图片。
 *
 * 唯一的用途是开发期重来。执行前要求打 `RESET` 确认 ——
 * 这条命令没有 undo，误跑的代价是一个下午的采集。
 */
function main() {
  if (process.argv[2] !== 'RESET') {
    console.error('这会删掉全部条目、标签与图片。确认要执行就跑：npm run reset-db -- RESET')
    process.exitCode = 1
    return
  }
  const db = databaseFile()
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${db}${suffix}`
    if (fs.existsSync(file)) {
      fs.rmSync(file)
      console.log(`已删除 ${file}`)
    }
  }
  const root = mediaRoot()
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true })
    console.log(`已删除 ${root}`)
  }
  console.log('完成。下次启动会重新建空库。')
}

main()