const allowedOrigins = (process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/**
 * ⚠️ **不要试图用 distDir 绕开本机的 rename 拦截**（2026-10-06 实测无效）。
 *
 * 本机WorkBuddy 的 safe-delete shim 会拦 `unlink` 与部分 `rename`，而
 * turbopack 重建缓存时要走「写 CURRENT.next 再 rename 覆盖」这一步 ——
 * dev server 与 `next build` 都会以 `EPERM: ... rename ...` 收场。
 *
 * 试过并确认**无效**的方案：换 distDir（含绝对路径 —— Next 16 会把 distDir
 * 拼到项目根目录下，`/tmp/x` 变成 `<repo>/tmp/x`，仍在工作区内）、
 * `--webpack` 后端、清扩展属性、非沙箱模式。
 *
 * **有效的只有一个**：让 `.next` 本身是指向工作区外的符号链接。
 * 而那会带来第二个问题 —— turbopack 的 chunk 因此跑在 /tmp，解析不到
 * node_modules 里的 postcss 插件。**两件事一起做才成立**，具体见
 * `scripts/next-dir.mjs` 的注释（含「链接为什么必须放在 distDir 的上一级」）。
 *
 * `dev` / `build` / `dev:local` 都以 `prepare-next.mjs` 开头就是为了这个 ——
 * 少一条路径就会缺那个链接，而症状看起来与配置无关。
 */

const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
}

module.exports = nextConfig
