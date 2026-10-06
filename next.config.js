const allowedOrigins = (process.env.SERVER_ACTION_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/**
 * distDir 可被 ATLAS_DIST_DIR 覆盖。
 *
 * ⚠️ 存在的原因很具体：WorkBuddy 的 safe-delete shim 会拦 `unlink` 与部分
 * `rename`，而 Next 在重建 `.next/dev/server/server-reference-manifest.json`
 * 时正好要走「写 .tmp 再 rename 覆盖」这一步 —— 于是在本机上 dev server 与
 * `next build` 都会以 `EPERM: operation not permitted, rename ...` 收场。
 * 这不是代码问题（同一份代码换目录就正常跑）。
 *
 * 不设这个变量时行为与从前完全一致，容器构建不受影响。
 */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins,
    },
  },
  ...(process.env.ATLAS_DIST_DIR ? { distDir: process.env.ATLAS_DIST_DIR } : {}),
}

module.exports = nextConfig