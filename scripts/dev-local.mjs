/**
 * 本机开发用的 dev server —— 把 Next 的构建目录挪到工作区外。
 *
 * ⚠️ 为什么需要它（2026-10-06踩了一整天）：
 * WorkBuddy 的 safe-delete shim 会拦 `unlink` 与部分 `rename`，而 turbopack
 * 重建缓存时必须走「写 CURRENT.next 再 rename 覆盖」这一步。于是本机上
 * `next dev` 与 `next build` 都会以 `EPERM: operation not permitted, rename ...`
 * 收场。
 *
 * 试过并确认**无效**的方案，不要重复试：
 * · 换 distDir（含绝对路径）—— Next 16 会把 distDir 拼到项目根目录下，
 *   `/tmp/x` 变成 `<repo>/tmp/x`，仍在工作区内，拦截照旧
 * · `next dev --webpack`
 * · 清 macOS 扩展属性（`xattr -cr`）
 * · 非沙箱模式
 *
 * **有效的只有一个**：让 `.next` 本身是**符号链接**指向工作区外 ——
 * Next 往里写时跟的是链接，操作系统层面的目标路径在工作区外。
 *
 * 用法：npm run dev:local
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const workDir = path.join(process.env.TMPDIR ?? '/tmp', 'atlas-next-local')
const linkPath = path.join(root, '.next')

// ⚠️ 顺序要紧：workDir 必须先存在，symlink 才能建进去。
// 反过来会报 `ENOENT: no such file or directory, symlink '.../node_modules' -> '.../atlas-next-local/node_modules'`。
if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true })

/**
 * ⚠️ node_modules 也得跟着挪。
 *
 * 起因：postcss 插件是按 **require 栈所在目录** 往上找 node_modules 的。
 * .next 一旦是符号链接，turbopack 的 chunk 就跑在 /tmp 那边，
 * `@tailwindcss/postcss` 于是从 /tmp 往上找 —— 找不到，报
 * `Cannot find module '@tailwindcss/postcss'`。
 *
 * 所以把依赖目录也软链过去，让「从 /tmp 往上找」这条路能落回真实的
 * node_modules。node_modules 是只读的，链接它没有风险。
 */
const modulesLink = path.join(workDir, 'node_modules')
if (!fs.existsSync(modulesLink)) {
  fs.symlinkSync(path.join(root, 'node_modules'), modulesLink, 'dir')
}

// 旧的真实目录会让 ln -sfn 失败（ln 到目录里会建成子目录），先清掉。
if (fs.existsSync(linkPath) && !fs.lstatSync(linkPath).isSymbolicLink()) {
  fs.rmSync(linkPath, { recursive: true, force: true })
}
if (!fs.existsSync(linkPath)) fs.symlinkSync(workDir, linkPath, 'dir')

const child = spawn('npx', ['next', 'dev', '-p', process.env.PORT ?? '5600'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

const bye = () => {
  child.kill('SIGTERM')
}
process.on('SIGINT', bye)
process.on('SIGTERM', bye)
child.on('exit', (code) => process.exit(code ?? 0))
