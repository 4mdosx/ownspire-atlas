const allowedOrigins = (process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/**
 * ⚠️ **不要试图用 distDir 绕开本机的 rename 拦截**（2026-10-06 实测无效）。
 *
 * 本机 WorkBuddy 的 safe-delete shim 会拦 `unlink` 与部分 `rename`，而
 * turbopack 重建缓存时要走「写 CURRENT.next 再 rename 覆盖」这一步 ——
 * dev server 与 `next build` 都会以 `EPERM: ... rename ...` 收场。
 *
 * 试过并确认**无效**的方案：换 distDir（含绝对路径 —— Next 16 会把 distDir
 * 拼到项目根目录下，`/tmp/x` 变成 `<repo>/tmp/x`，仍在工作区内）、
 * `--webpack` 后端、清扩展属性、非沙箱模式。
 *
 * 要跑 dev server 用 `npm run dev:local`，它把缓存放到工作区外。
 */

const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
}

module.exports = nextConfig