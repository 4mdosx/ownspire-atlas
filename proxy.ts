import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

/**
 * 未登录一律挡在门外。
 *
 * ⚠️ 这里**只验签，不查 pinEpoch**。epoch 校验要读 SQLite，而 proxy 跑在
 * Edge/中间件运行时里，`node:sqlite` 不可用。真正的 epoch 校验在
 * `verifySessionToken()`（Node 运行时）。所以 proxy 是「挡外面的」，
 * service 层是「挡里面的」—— 换过 PIN 之后旧 cookie 能过 proxy，
 * 但过不了真正校验 epoch 的那条路径。
 *
 * 公开路径：
 * - `/login` 登录页本身
 * - `/api/auth/login` 用 PIN 解锁
 * - `/api/auth/setup` **首次设置 PIN**。必须公开 —— 否则新部署没有 PIN、
 *   也没有会话，永远走不到设置这一步，整个实例进不去。
 *   它安全是因为 service 层用 `isPinConfigured()` 把住了：已设过就一律拒绝。
 * - `/healthz` 部署健康检查（ownspire-infra 的 deploy 靠它取版本号）
 *
 * ⚠️ `/api/auth/pin`（改 PIN）如果将来加，**绝不能公开** ——
 * 那会让任何人都能改掉 PIN。
 */
const PUBLIC_PATHS = new Set(['/login', '/healthz', '/api/auth/login', '/api/auth/setup'])

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname)
}

function deny(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, code: 'unauthorized', error: '需要登录。' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  return NextResponse.redirect(url)
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (isPublic(request.nextUrl.pathname)) return NextResponse.next()

  const secret = process.env.SESSION_SECRET
  const token = request.cookies.get('atlas_session')?.value
  if (!secret || !token) return deny(request)

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] })
    return NextResponse.next()
  } catch {
    return deny(request)
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|ttf|woff2?)$).*)',
  ],
}