#!/usr/bin/env node
/**
 * 迁移门禁 —— 「schema.ts 改了但没 generate」必须红。
 *
 * ⚠️ **不能用 `drizzle-kit check` 当门禁**：实测（drizzle-kit 1.0.0-rc.4）在
 * 「schema 已改、还没 generate」时它照样打印 `Everything's fine` 并以 0 退出，
 * 也就是说它抓不到这里唯一要抓的那件事。
 *
 * 真正可靠的判据是：**跑一次 generate，再看 `drizzle/` 有没有因此变脏**。
 * generate 是纯静态的（只比 schema.ts 与上一份 snapshot，不连库），所以能
 * 放心在 CI 里跑；它若无事发生就不产出文件，工作区保持干净。
 *
 * ⚠️ 判据必须是 `git status --porcelain`（含未跟踪文件），不能是 `git diff` ——
 * 新生成的迁移目录是**未跟踪**的，diff 看不见它。
 */
import { execSync } from 'node:child_process'

execSync('drizzle-kit generate', { stdio: 'inherit' })

const dirty = execSync('git status --porcelain drizzle/').toString().trim()
if (dirty) {
  console.error(
    `\n✗ schema.ts 与 drizzle/ 不一致 —— 有迁移没提交：\n\n${dirty}\n\n` +
      `先跑 \`npm run db:generate\`，把产出的迁移文件一起提交。\n`,
  )
  process.exit(1)
}
console.log('✓ drizzle/ 与 schema.ts 一致')
