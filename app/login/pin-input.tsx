'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * 分格 PIN 输入。
 *
 * **与 raven / shrine / navi 的同名组件同一套交互**：数字键盘、自动跳格、退格回退、整串粘贴。
 *
 * 为什么值得写成一个组件而不是 `<input type="password" maxLength={4}>`：
 *
 * 1. **移动端弹出数字键盘**靠 `inputMode="numeric"` +
 *    `autoComplete="one-time-code"`（后者让 iOS/Android 提议从短信里 autofill）。
 * 2. **输完自动跳下一格、退格回上一格**。4 次点击 vs 1 次点击 ——
 *    这是每天都要做的动作，摩擦直接乘 4。
 * 3. **支持粘贴整串**。`maxLength={1}` 的单格输入默认会把粘贴的 4 位截成 1 位，
 *    所以在第一格上单独接管 paste。
 *
 * ⚠️ `onComplete` 只在所有格填满时触发一次；同一串数字不会被触发两次 ——
 * 改末位时无脑再报一次，登录页会连发两个请求。
 */
export function PinInput({
  length,
  onComplete,
  onChange,
  disabled = false,
  autoFocus = true,
  invalid = false,
  label = 'PIN',
}: {
  length: number
  /** 填满时触发一次。刻意可选：设置态的「确认 PIN」不传它。 */
  onComplete?: (value: string) => void
  onChange?: (value: string) => void
  disabled?: boolean
  autoFocus?: boolean
  /** 校验失败时给所有格子加错误色。 */
  invalid?: boolean
  label?: string
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(''))
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLInputElement | null)[]>([])
  // 上一次已经 complete 过的串。用来抑制「改末位再报一次」。
  const completedRef = useRef<string>('')

  function publish(next: string[]) {
    const value = next.join('')
    onChange?.(value)
    const filled = next.length === length && next.every((digit) => digit !== '')
    if (filled && value !== completedRef.current) {
      completedRef.current = value
      onComplete?.(value)
    }
    // 清空后要让下一次重新触发，否则「输错→清空→重输正确」会静默失败。
    if (!filled && value === '' && completedRef.current !== '') completedRef.current = ''
  }

  function handleChange(index: number, raw: string) {
    // 只接受数字。非数字（中文输入法候选词、粘贴的字母）直接忽略。
    if (!/^\d*$/.test(raw)) return
    const next = [...digits]
    // `maxLength=1` 在部分浏览器里仍可能收到多字符（粘贴/自动填充），取最后一位。
    next[index] = raw.slice(-1)
    setDigits(next)
    publish(next)
    if (next[index] !== '' && index < length - 1) {
      setActive(index + 1)
      refs.current[index + 1]?.focus()
    }
  }

  function handleKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Backspace') return
    // 空格退格 → 回上一格。这是分格输入的标准手势，单个 input 做不到。
    if (digits[index] === '' && index > 0) {
      setActive(index - 1)
      refs.current[index - 1]?.focus()
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    event.preventDefault()
    const pasted = event.clipboardData.getData('text/plain').trim()
    if (!/^\d+$/.test(pasted)) return
    const next = [...digits]
    for (let i = 0; i < Math.min(length, pasted.length); i += 1) next[i] = pasted[i]
    setDigits(next)
    publish(next)
    const focusIndex = Math.min(pasted.length, length - 1)
    setActive(focusIndex)
    refs.current[focusIndex]?.focus()
  }

  useEffect(() => {
    if (!autoFocus || disabled) return
    refs.current[active]?.focus()
  }, [active, autoFocus, disabled])

  const CELL =
    'h-12 w-11 rounded-md border border-input bg-background px-0 text-center text-lg font-semibold text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50'

  return (
    // `role="group"` + 每格的 aria-label：读屏会念「PIN 第 1 位，共 4 位」，
    // 否则它只会念「编辑框」，用户不知道总共几位。
    <div role="group" aria-label={`${label}，共 ${length} 位`} className="flex justify-center gap-2">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element
          }}
          type="password"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={digit}
          disabled={disabled}
          aria-label={`${label} 第 ${index + 1} 位`}
          aria-invalid={invalid || undefined}
          onChange={(event) => handleChange(index, event.target.value)}
          onKeyDown={(event) => handleKeyDown(index, event)}
          // 只在第一格接粘贴：多格都接的话一次粘贴会触发 N 次 fill。
          onPaste={index === 0 ? handlePaste : undefined}
          onFocus={() => setActive(index)}
          className={cn(CELL, active === index && 'border-primary', invalid && 'border-destructive text-destructive')}
        />
      ))}
    </div>
  )
}