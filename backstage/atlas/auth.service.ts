import 'server-only'
import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { getPinEpoch, isPinConfigured, savePin, verifyStoredPin, PIN_LENGTH } from './pin.service'
import {
  clearSignal,
  describeRemaining,
  describeSignal,
  lockedFor,
  recordFailure,
  recordFailureSignal,
  recordSuccess,
  resetAll,
  resetSignals,
} from '@/lib/backoff'

/**
 * PIN 认证。**与 ownspire-raven / ownspire-shrine 的 `auth.service.ts` 同一套逻辑**。
 *
 * ⚠️ **atlas 的所有 pin.* 调用都要 `await`** —— atlas 的数据层是 drizzle
 * （`getDatabase()` 是 async），而 raven/shrine 是同步的原生 SQL。
 * 把 raven 那份同步调用照抄过来会得到「Promise 上取属性」的错误，
 * 而且症状是 `undefined` 而不是异常，极难定位。
 *
 * ============================ 三个动作 ============================
 *
 * - `setupPin` —— 首次设置。**已设置就拒绝**，否则任何能打开 /login 的人
 *   都能覆盖掉现有 PIN。这条边界是「首次设置」与「修改」的分界。
 * - `loginWithPin` —— 用 PIN 解锁。错误时**不回显是第几位错**：
 *   4 位数字的组合本来就少，任何额外信息都在缩小枚举空间。
 * - `updatePin` —— 修改。必须先验当前 PIN，否则拿到会话的人就能永久改掉 PIN。
 *
 * ============================ 会话与 epoch ============================
 *
 * JWT 里存的是**签发时的 pinEpoch**，校验时与数据库里的当前值比对。
 * 换 PIN → epoch 变 → 所有旧会话立刻失效。这替代了「配置指纹」：
 * 指纹方案要在每次校验时读配置文件，而 proxy 跑在 Edge runtime 里读不了文件。
 *
 * ⚠️ **已知局限**：atlas 现在只有 proxy 一道门（没有逐路由的 requireSession），
 * 所以旧 cookie 能过 proxy。epoch 校验只发生在真正调用 `verifySessionToken` 的地方。
 * 这是 raven 同一个既存问题，两个项目一并记着。
 */

export const SESSION_COOKIE = 'atlas_session'

/** 单用户部署：没有账号体系，所有登录成功者都是同一个主体。 */
const SESSION_SUBJECT = 'owner'

/** 会话有效期（小时）。与 raven / shrine 的默认一致。 */
const SESSION_HOURS = 24 * 7

export type SessionPayload = {
  sub: string
  /** 签发时的 PIN epoch。与数据库里的当前值不一致即视为失效。 */
  pinEpoch: string
}

function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 16) {
    throw new Error(
      'SESSION_SECRET 没有设置或短于 16 字符。请在 .env 或容器 env_file 里给它一个足够长的随机串。'
    )
  }
  return new TextEncoder().encode(secret)
}

// ---------------------------------------------------------------------------
// 登录限流：指数退避
// ---------------------------------------------------------------------------

/**
 * ⚠️ `clientIp` 信任 `x-forwarded-for` 的第一个值。这在有可信反向代理时是对的，
 * 但意味着客户端可以自己伪造这个头 —— 一个直接暴露到公网、没有代理的部署，
 * 攻击者每次请求换一个伪造的 XFF 就能绕过全部限流。
 * ownspire 的部署形态是 Tailscale 内网 + 反代，所以这里成立。
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'local'
}

/**
 * 抛出限流错误，如果这个 IP 正处于退避锁定中。
 *
 * ⚠️ 用**自定义错误类**：atlas 没有 raven 那层统一信封（`backstage/lib/http.ts`
 * 是 raven 后来才加的），所以这里只需要一个带 `remainingMs` 的类型，
 * 让 route 能判断该回 429 并把剩余时间带上。
 */
export class RateLimitedError extends Error {
  readonly remainingMs: number
  constructor(message: string, remainingMs: number) {
    super(message)
    this.name = 'RateLimitedError'
    this.remainingMs = remainingMs
  }
}

export function assertNotRateLimited(ip: string): void {
  const remaining = lockedFor(ip)
  if (remaining <= 0) return
  throw new RateLimitedError(describeRemaining(remaining), remaining)
}

/**
 * 记一次 PIN 校验失败，施加指数退避，并在判定可疑时打一行日志。
 *
 * ⚠️ 调用方必须先 `assertNotRateLimited()`：锁定期间继续调它会把锁定时长
 * 无限顶高，攻击者只要一直点就能让某人的锁定再也解不开。
 */
export function recordLoginFailure(ip: string): void {
  recordFailure(ip)
  const signal = recordFailureSignal(ip)
  if (signal.suspicious) {
    // ⚠️ 走 console.warn 而不是静默：这是「感知到有人在重试」的唯一出口。
    // PM2 / docker logs 都能直接看到。
    console.warn(describeSignal(signal, ip))
  }
}

/** 登录成功 —— 退避计数与攻击信号**一起**清空。 */
export function recordLoginSuccess(ip: string): void {
  recordSuccess(ip)
  clearSignal(ip)
}

export function resetRateLimits(): void {
  resetAll()
  resetSignals()
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export async function createSessionToken(): Promise<string> {
  const pinEpoch = await getPinEpoch()
  // ⚠️ 没有 epoch 就没有会话可签发 —— 那是「还没设过 PIN」。
  // 显式抛错，而不是签一个空 epoch 的 token：后者会产生一个「看起来已登录」的会话。
  if (!pinEpoch) throw new Error('尚未设置 PIN，无法签发会话。')
  const payload: SessionPayload = { sub: SESSION_SUBJECT, pinEpoch }
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(sessionKey())
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string') return null
    const pinEpoch = typeof payload.pinEpoch === 'string' ? payload.pinEpoch : ''
    if (pinEpoch === '') return null
    const currentEpoch = await getPinEpoch()
    if (!currentEpoch || pinEpoch !== currentEpoch) return null
    return { sub: payload.sub, pinEpoch }
  } catch {
    return null
  }
}

export async function currentSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  return verifySessionToken(token)
}

export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(expiresAt),
  }
}

// ---------------------------------------------------------------------------
// 三个动作
// ---------------------------------------------------------------------------

export type AuthResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; errors: Record<string, string[]> }

function lifetimeMs(): number {
  return SESSION_HOURS * 3600 * 1000
}

/** 校验 PIN 的形状（4 位数字），返回规范化后的值或 null。 */
function normalizePin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(trimmed) ? trimmed : null
}

export async function setupPin(input: { pin?: unknown; confirmPin?: unknown }, ip: string): Promise<AuthResult> {
  assertNotRateLimited(ip)
  if (await isPinConfigured()) {
    return { ok: false, errors: { pin: ['PIN 已设置，请直接解锁'] } }
  }
  const pin = normalizePin(input.pin)
  const confirm = normalizePin(input.confirmPin)
  if (pin === null) return { ok: false, errors: { pin: [`PIN 需为 ${PIN_LENGTH} 位数字`] } }
  if (confirm === null) return { ok: false, errors: { confirmPin: [`PIN 需为 ${PIN_LENGTH} 位数字`] } }
  if (pin !== confirm) return { ok: false, errors: { confirmPin: ['两次输入的 PIN 不一致'] } }

  await savePin(pin)
  recordLoginSuccess(ip)
  return { ok: true, token: await createSessionToken(), expiresAt: Date.now() + lifetimeMs() }
}

export async function loginWithPin(input: { pin?: unknown }, ip: string): Promise<AuthResult> {
  assertNotRateLimited(ip)
  if (!(await isPinConfigured())) return { ok: false, errors: { pin: ['尚未设置 PIN'] } }
  const pin = normalizePin(input.pin)
  if (pin === null) return { ok: false, errors: { pin: [`PIN 需为 ${PIN_LENGTH} 位数字`] } }

  const valid = await verifyStoredPin(pin)
  if (!valid) {
    recordLoginFailure(ip)
    return { ok: false, errors: { pin: ['PIN 不正确'] } }
  }
  recordLoginSuccess(ip)
  return { ok: true, token: await createSessionToken(), expiresAt: Date.now() + lifetimeMs() }
}

export async function updatePin(
  input: { currentPin?: unknown; pin?: unknown; confirmPin?: unknown },
  ip: string
): Promise<AuthResult> {
  assertNotRateLimited(ip)
  if (!(await isPinConfigured())) return { ok: false, errors: { currentPin: ['尚未设置 PIN'] } }
  const current = normalizePin(input.currentPin)
  const pin = normalizePin(input.pin)
  const confirm = normalizePin(input.confirmPin)
  if (current === null) return { ok: false, errors: { currentPin: [`PIN 需为 ${PIN_LENGTH} 位数字`] } }
  if (pin === null) return { ok: false, errors: { pin: [`PIN 需为 ${PIN_LENGTH} 位数字`] } }
  if (confirm === null) return { ok: false, errors: { confirmPin: [`PIN 需为 ${PIN_LENGTH} 位数字`] } }
  if (pin !== confirm) return { ok: false, errors: { confirmPin: ['两次输入的 PIN 不一致'] } }

  const valid = await verifyStoredPin(current)
  if (!valid) {
    recordLoginFailure(ip)
    return { ok: false, errors: { currentPin: ['当前 PIN 不正确'] } }
  }
  await savePin(pin)
  recordLoginSuccess(ip)
  return { ok: true, token: await createSessionToken(), expiresAt: Date.now() + lifetimeMs() }
}