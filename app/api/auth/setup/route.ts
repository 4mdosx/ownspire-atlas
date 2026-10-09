import { NextResponse } from 'next/server'
import {
  assertNotRateLimited,
  clientIp,
  RateLimitedError,
  sessionCookieOptions,
  setupPin,
  SESSION_COOKIE,
} from '@/backstage/atlas/auth.service'
import { PIN_LENGTH } from '@/backstage/atlas/pin.service'

/**
 * 首次设置 PIN。**公开写接口**。
 *
 * ⚠️ 为什么它可以公开：service 层用 `isPinConfigured()` 把住了入口 ——
 * 已设置过 PIN 时这里一律拒绝。所以「公开」不等于「谁能改」，
 * 最坏情况是别人抢先占坑设一个 PIN（那意味着他本来就有你的数据库写权限，
 * 这种情况下再挡也没有意义）。
 *
 * 成功时**直接签发会话**：设置完 PIN 的人就是主人，让他再输一遍是纯粹的摩擦。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request)
  try {
    assertNotRateLimited(ip)
    const body = (await request.json().catch(() => ({}))) as { pin?: unknown; confirmPin?: unknown }
    const result = await setupPin({ pin: body.pin, confirmPin: body.confirmPin }, ip)
    if (!result.ok) {
      const alreadySetup = result.errors['pin']?.[0] === 'PIN 已设置，请直接解锁'
      return NextResponse.json(
        {
          ok: false,
          code: alreadySetup ? 'pin_already_configured' : 'invalid_input',
          error: alreadySetup ? 'PIN 已设置，请直接解锁。' : (result.errors['confirmPin']?.[0] ?? 'PIN 不合法。'),
          errors: result.errors,
        },
        { status: alreadySetup ? 409 : 400 }
      )
    }
    const response = NextResponse.json({
      ok: true,
      configured: true,
      pinLength: PIN_LENGTH,
      session: { expiresAt: result.expiresAt },
    })
    response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.expiresAt))
    return response
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return NextResponse.json(
        { ok: false, code: 'rate_limited', error: error.message, remainingMs: error.remainingMs },
        { status: 429 }
      )
    }
    console.error('[atlas] 设置 PIN 接口异常：', error)
    return NextResponse.json({ ok: false, code: 'internal_error', error: '服务暂时不可用。' }, { status: 500 })
  }
}