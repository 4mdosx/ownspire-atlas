'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Layers, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { DOMAINS, type DomainCode, type DomainDef } from '@/types/atlas'

/**
 * ⭐ 库选择器（domain switcher）。
 *
 * ⚠️ **它常驻顶栏，不在录入流里。** 这是本次通用化最重要的一个界面决定。
 *
 * 「先选类型，再开始填」听起来很自然，但那是给每次采集都加一步。D2 判据是
 * 「连续录 20 条不觉得烦」—— 每条前面插一个选择动作，是最直接的摩擦增量。
 *
 * Eagle 的做法值得抄：**库是上下文，不是步骤。** 选定后Capture 直接进表单。
 * 只有两种情况才走完整选型：① 首次进入（还没选过库）② 显式点「切换库」。
 */
export function DomainSwitcher({ current, onChange }: { current: DomainCode | null; onChange: (domain: DomainCode) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = DOMAINS.find((domain) => domain.code === current) ?? null

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm font-semibold hover:bg-accent"
      >
        <Layers className="size-3.5 text-muted-foreground" />
        {active ? (
          <>
            {active.labelZh}
            <span className="text-[11px] font-normal text-muted-foreground">{active.labelEn}</span>
          </>
        ) : (
          <span className="text-muted-foreground">选一个库</span>
        )}
        <ChevronDown className="size-3 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border bg-background p-1 shadow-lg">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">库 · Library</p>
          {DOMAINS.map((domain) => (
            <DomainOption key={domain.code} domain={domain} active={domain.code === current} onSelect={() => { onChange(domain.code); setOpen(false) }} />
          ))}
          <p className="mt-1 flex items-center gap-1.5 border-t px-2 py-2 text-[11px] text-muted-foreground">
            <Plus className="size-3" />
            新增库 = 改代码（domain 列表不进数据库）
          </p>
        </div>
      )}
    </div>
  )
}

function DomainOption({ domain, active, onSelect }: { domain: DomainDef; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent', active && 'bg-accent/60')}
    >
      <Check className={cn('mt-0.5 size-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
      <span className="min-w-0">
        <span className="block text-xs font-medium">
          {domain.labelZh} <span className="text-[11px] font-normal text-muted-foreground">{domain.labelEn}</span>
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{domain.hintZh}</span>
      </span>
    </button>
  )
}

/**
 * ⭐ 首次进入的选型页 —— 一整页的库选择，不是一行下拉。
 *
 * ⚠️ 这是一次性的。选完就再也不出现（除非显式切库）。所以它可以做得慢、
 * 可以解释清楚每个库是干什么的 —— 反正只走一次。
 *
 * 「未选择的情况下多一个 step 选类型」—— 就是这一屏。
 */
export function DomainGate({ onPick }: { onPick: (domain: DomainCode) => void }) {
  const [query, setQuery] = useState('')
  const filtered = DOMAINS.filter((domain) => {
    const needle = query.trim().toLowerCase()
    if (!needle) return true
    return [domain.labelZh, domain.labelEn, domain.hintZh, domain.code].some((field) => field.toLowerCase().includes(needle))
  })

  return (
    <div className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">第一步</p>
      <h1 className="mt-1 text-xl font-semibold">你在收集什么？</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        选一个库开始。以后随时能切，<span className="text-foreground">切库不会丢已有条目</span>。
      </p>

      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索库…"
        className="mt-6 h-9"
      />

      <div className="mt-3 space-y-1.5">
        {filtered.map((domain) => (
          <button
            key={domain.code}
            type="button"
            onClick={() => onPick(domain.code)}
            className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:border-foreground/40 hover:bg-accent/40"
          >
            <Layers className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {domain.labelZh} <span className="text-xs font-normal text-muted-foreground">{domain.labelEn}</span>
              </span>
              <span className="block text-xs text-muted-foreground">{domain.hintZh}</span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="px-1 py-3 text-xs text-muted-foreground">没有匹配的库。新增库要改代码。</p>}
      </div>
    </div>
  )
}

/** 轻量版：给 Quick Add 用的「换库」入口。 */
export function DomainChip({ domain, onOpen }: { domain: DomainDef; onOpen: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onOpen} className="shrink-0">
      <Layers className="mr-1 size-3.5" />
      {domain.labelZh}
      <ChevronDown className="ml-1 size-3 opacity-60" />
    </Button>
  )
}