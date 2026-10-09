import { redirect } from 'next/navigation'
import { currentSession } from '@/backstage/atlas/auth.service'
import { isPinConfigured, PIN_LENGTH } from '@/backstage/atlas/pin.service'
import { PinLoginForm } from './login-form'

/**
 * 登录页（服务端组件）。
 *
 * **两态由服务端决定**，不由客户端猜：`isPinConfigured()` 为假 → 首次设置，
 * 为真 → 解锁。放在服务端是因为这个判断要读 SQLite，而客户端拿不到这个信息 ——
 * 让客户端先渲染再纠正会闪一下错误的表单，而且首次设置时用户会先看到
 * 一个「输入 PIN」的框，再被告知「尚未设置 PIN」。
 *
 * ⚠️ 这是唯一一个**不套应用外壳**的页面：外壳里有导航，而未登录时点任何一处
 * 都会被 proxy 弹回来，那等于给用户必然失败的按钮。
 *
 * `next` 参数来自 proxy 的重定向（`?next=/library`）。⚠️ 只接受**站内相对路径**：
 * 直接把查询参数塞进 `location.replace()` 就是一个开放重定向。
 */
function safeNext(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '/'
  if (!raw.startsWith('/')) return '/'
  // `//evil.com` 与 `/\evil.com` 都会被浏览器当成协议相对地址，必须挡掉。
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  return raw
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  // ⚠️ Next 15+ 的 searchParams 是 Promise，必须 await。忘了 await 会拿到一个
  // 永远为空的普通对象，表现为「重定向回来永远跳首页」。
  const params = await searchParams
  const next = safeNext(params.next)

  const configured = await isPinConfigured()
  // 已经解锁就别再给一次登录框。proxy 本该拦住，但直接访问 /login 时这里兜住。
  if (configured && (await currentSession())) {
    redirect(next)
  }

  return <PinLoginForm mode={configured ? 'unlock' : 'setup'} pinLength={PIN_LENGTH} next={next} />
}