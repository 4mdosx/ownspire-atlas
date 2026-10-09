import { NextResponse } from 'next/server'
import {
  assertNotRateLimited,
  clientIp,
  loginWithPin,
  RateLimitedError,
  sessionCookieOptions,
  SESSION_COOKIE,
} from '@/backstage/atlas/auth.service'
import { PIN_LENGTH } from '@/backstage/atlas/pin.service'

/**
 * 用 PIN 解锁。**公开写接口**（`proxy.ts` 的 PUBLIC_PATHS 里）。
 *
 * 状态码的区分是给界面用的：
 * - **400**：位数不对。提示留在输入框旁边。
 * - **401**：位数对但值不对。不透露是哪一位错 —— 4 位数字总共 10000 种，
 *   多给一点信息都在缩小枚举空间。
 * - **429**：退避锁定中。**必须带上还剩多少时间**，用户才知道什么时候能再试。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request)
  try {
    assertNotRateLimited(ip)
    const body = (await request.json().catch(() => ({}))) as { pin?: unknown }
    const result = await loginWithPin({ pin: body.pin }, ip)
    if (!result.ok) {
      const wrongShape = result.errors['pin']?.[0]?.includes('位数字') ?? false
      return NextResponse.json(
        {
          ok: false,
          code: wrongShape ? 'invalid_input' : 'invalid_pin',
          error: wrongShape ? result.errors['pin'][0] : 'PIN 不正确。',
          errors: result.errors,
        },
        { status: wrongShape ? 400 : 401 }
      )
    }
    const response = NextResponse.json({ ok: true, session: { expiresAt: result.expiresAt } })
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt))
    return response
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return NextResponse.json(
        { ok: false, code: 'rate_limited', error: error.message, remainingMs: error.remainingMs },
        { status: 429 }
      )
    }
    console.error('[atlas] 登录接口异常：', error)
    return NextResponse.json({ ok: false, code: 'internal_error', error: '服务暂时不可用。' }, { status: 500 })
  }
}