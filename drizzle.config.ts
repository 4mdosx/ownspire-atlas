import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit 配置。
 *
 * ⚠️ **两个包都锁精确版本**（package.json 里 `drizzle-orm` / `drizzle-kit` 都没有 `^`）。
 * 这是 rc 版本：drizzle-orm `1.0.0-rc.4` 才有 `node-sqlite` 驱动（`node:sqlite`），
 * 稳定版 0.45.x 只有 better-sqlite3 之类的第三方引擎。而 `^` 在 rc 上尤其危险 ——
 * `^1.0.0-rc.4` 的语义是「>=1.0.0-rc.4 <2.0.0」，会把同样带 rc 标签的后续预发布
 * 版本（rc.5、rc.6…）一路放进可接受范围，每次 `npm install` 装到的都可能不同，
 * 于是「本地能跑、CI 红」这类问题完全没有复现路径。
 *
 * ⚠️ **generate 只需要 schema，不需要连库** —— 它做的是「schema.ts 与上一份
 * snapshot 的差异」，纯静态。所以 dbCredentials 只是让 `studio` / `push` 之类
 * 真要连库的命令有地方取路径；我们不在 CI 里用那些命令。
 *
 * ⚠️ schema.ts 里 `@/options/shared` 这个路径别名能被解析，靠的是 drizzle-kit
 * 读 tsconfig 的 paths —— 不是靠它认识 Next.js 的别名。改 tsconfig 的 paths 时
 * 记得回来确认 `npm run db:generate` 还能跑。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './backstage/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DB_FILE_NAME ?? 'local.db' },
})
