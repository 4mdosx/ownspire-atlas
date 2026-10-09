'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { PinInput } from './pin-input'
import { ATLAS_VERSION } from '@/backstage/version'

/**
 * 登录表单。两态：**首次设置 PIN / 之后输入 PIN 解锁**。
 *
 * 三条不能省的规矩（与 raven / shrine 的同一份实现保持一致）：
 *
 * 1. **失败时原样显示服务端那句 `error`。** 退避锁定的 429 会返回
 *    「请 2 小时后再试」—— 这句话包含**还要等多久**，客户端自己编一句
 *    「登录失败」就把唯一有用的信息丢了。
 * 2. **解锁态填满即提交，设置态保留按钮。** 差别是有理由的：
 *    解锁时输完 4 位意图已经明确；而设置态要判「两次是否一致」，
 *    输完之前判不了 —— 自动提交会让用户还没确认第一遍就吃一个「两次不一致」。
 * 3. **成功后用 `location.replace`**：路由器的客户端缓存里可能还留着
 *    「未登录时被 proxy 重定向到 /login」的那次渲染结果，硬跳转能确保
 *    拿到带 cookie 的新会话。代价是一次整页加载，值得。
 */
export function PinLoginForm({ mode, pinLength, next }: { mode: 'setup' | 'unlock'; pinLength: number; next: string }) {
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [pinError, setPinError] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [pending, setPending] = useState(false)

  function clearErrors() {
    setError('')
    setPinError('')
    setConfirmError('')
  }

  /** 把服务端返回的字段级错误贴到对应输入框下；没有字段级错误就用那句人话。 */
  function applyErrors(payload: Record<string, unknown>, fallback: string) {
    const errors = (payload['errors'] ?? {}) as Record<string, string[]>
    setPinError(errors['pin']?.[0] ?? '')
    setConfirmError(errors['confirmPin']?.[0] ?? errors['currentPin']?.[0] ?? '')
    if (Object.keys(errors).length === 0) setError(fallback)
  }

  async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: response.ok, status: response.status, payload }
  }

  async function submitUnlock(value: string) {
    if (pending) return
    clearErrors()
    setPending(true)
    try {
      const { ok, status, payload } = await post('/api/auth/login', { pin: value })
      if (ok) {
        setPin('')
        window.location.replace(next)
        return
      }
      applyErrors(payload, String(payload['error'] ?? '登录失败。'))
      // ⚠️ 429（退避锁定）时**保留**已输的内容：锁定解除后可以直接重试，
      // 让人重新输 4 位是对一次限流的过度惩罚。只有 401（PIN 错了）才清空。
      if (status !== 401 && status !== 429) setError(String(payload['error'] ?? '登录失败。'))
      if (status === 401) setPin('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败。')
    } finally {
      setPending(false)
    }
  }

  async function submitSetup() {
    if (pending) return
    clearErrors()
    setPending(true)
    try {
      const { ok, status, payload } = await post('/api/auth/setup', { pin, confirmPin })
      if (ok) {
        setPin('')
        setConfirmPin('')
        window.location.replace(next)
        return
      }
      applyErrors(payload, String(payload['error'] ?? '设置 PIN 失败。'))
      // 只清「确认 PIN」这一栏：新 PIN 是用户刚想清楚的。
      setConfirmPin('')
      if (status !== 400 && status !== 409 && status !== 429) {
        setError(String(payload['error'] ?? '设置 PIN 失败。'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置 PIN 失败。')
    } finally {
      setPending(false)
    }
  }

  const setupReady = pin.length === pinLength && confirmPin.length === pinLength

  return (
    <main className="grid min-h-svh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Ownspire Atlas</h1>
          <p className="mt-1 text-xs text-muted-foreground">设计参考采集库 · {ATLAS_VERSION}</p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (mode === 'setup' && setupReady) void submitSetup()
          }}
          className="space-y-5 rounded-lg border bg-card p-5"
          noValidate
        >
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            {mode === 'setup'
              ? `首次使用，请设置一个 ${pinLength} 位 PIN。它保存在本机数据库里，只用于解锁 atlas。`
              : `输入 ${pinLength} 位 PIN 解锁。`}
          </p>

          <div className="space-y-2">
            <label className="block text-center text-xs font-medium text-muted-foreground">
              {mode === 'setup' ? '新 PIN' : 'PIN'}
            </label>
            <PinInput
              length={pinLength}
              disabled={pending}
              invalid={pinError !== ''}
              label={mode === 'setup' ? '新 PIN' : 'PIN'}
              onChange={setPin}
              onComplete={(value) => {
                if (mode === 'unlock') void submitUnlock(value)
              }}
            />
            {pinError && <p className="text-center text-[11px] text-destructive">{pinError}</p>}
          </div>

          {mode === 'setup' && (
            <div className="space-y-2">
              <label className="block text-center text-xs font-medium text-muted-foreground">确认 PIN</label>
              <PinInput
                length={pinLength}
                autoFocus={false}
                disabled={pending}
                invalid={confirmError !== ''}
                label="确认 PIN"
                onChange={setConfirmPin}
              />
              {confirmError && <p className="text-center text-[11px] text-destructive">{confirmError}</p>}
            </div>
          )}

          {/* `role="alert"` 让读屏立刻念出错误；`break-words` 是因为退避文案
              可能很长（「请 24 小时后再试」），窄屏上不换行会把卡片撑破。 */}
          {error && (
            <p
              role="alert"
              className="break-words rounded-md border border-destructive/60 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          {mode === 'setup' ? (
            // ⚠️ atlas 的 `Button` **没有 `loading` prop**（只有 variant/size），
            // 所以这里用 `disabled` + 文案切换来表示进行中。
            // 按钮宽度不变是因为文案长度相近 —— 而如果文案长度差很多，
            // 该给 Button 补一个 loading 而不是靠文案硬凑。
            <Button type="submit" className="w-full" disabled={!setupReady || pending}>
              {pending ? '保存中…' : '保存 PIN'}
            </Button>
          ) : (
            // 解锁态没有提交按钮（填满即提交）。留一个「重新载入」是因为
            // 用户中途在别处改了 PIN 的话，本页的 setup/unlock 判定已经过期。
            <Button type="button" variant="ghost" size="sm" className="w-full" disabled={pending} onClick={() => window.location.reload()}>
              {pending ? '验证中…' : '重新载入'}
            </Button>
          )}
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          PIN 输错会触发指数退避：越错越久，最长锁 24 小时。
        </p>
      </div>
    </main>
  )
}