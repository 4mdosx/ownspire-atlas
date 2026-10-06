'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { QuickAdd } from './quick-add'
import { AtlasSidebar, EMPTY_FILTER, FilterBar, type AtlasFilter } from './atlas-filters'
import { EntryGrid } from './entry-grid'
import { EntryDrawer } from './entry-drawer'
import { DomainGate, DomainSwitcher } from './domain-switcher'
import { domainOf, isGallerySize, type DomainCode, type EntryDetail, type EntryStatus, type EntrySummary, type GallerySize, type Tag } from '@/types/atlas'

/**
 * Library 工作区 —— v0.2 的全部界面。
 *
 * 三段式布局（照 navi 的 workspace）：左栏筛选 + 顶部 Quick Add +
 * 主区卡片墙 + 右侧 drawer。
 *
 * ⚠️ **domain 选择不在录入流里。** 库选择器常驻顶栏，Capture 直接进表单。
 * 首次进入才走一次 DomainGate（那一屏是"未选择情况下的选型 step"）。
 * 理由见 domain-switcher.tsx 的注释：每条采集前面插一步是直接违背 D2 判据的摩擦。
 *
 * ⚠️ 筛选在客户端做，不过服务端 —— v0 的量级是几百条，一次全取回来
 * 换来「改筛选条件零往返」。真正的分页留到 1000 条以上。
 */
export function LibraryWorkspace() {
  /** 当前库。null = 还没选过，走 DomainGate。 */
  const [domain, setDomain] = useState<DomainCode | null>(null)
  const [entries, setEntries] = useState<EntrySummary[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [counts, setCounts] = useState<Record<EntryStatus, number>>({ inbox: 0, reviewed: 0, reference: 0 })
  const [untagged, setUntagged] = useState(0)
  const [filter, setFilter] = useState<AtlasFilter>(EMPTY_FILTER)
  const [size, setSize] = useState<GallerySize>('md')
  const [selected, setSelected] = useState<EntryDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  /**
   * 库选择持久化到 localStorage。
   *
   * ⚠️ 只存「用户选了哪个库」这一个字符串，不存条目数据。
   * 这是 Eagle 的做法 —— 库是长期上下文，每次进来都重选一遍是纯摩擦。
   */
  useEffect(() => {
    const saved = window.localStorage.getItem('atlas:domain')
    if (saved) setDomain(saved as DomainCode)
  }, [])

  /**
   * 卡片尺寸持久化到 localStorage。
   *
   * ⚠️ 只存「用户选了哪一档」这一个字符串。理由与库选择一样：这是显示
   * 偏好，每次进来重选一遍是纯摩擦 —— 而「一屏能扫几十张」和「停下来
   * 仔细看」是两种不同的使用节奏，不该每次都重新决定。
   *
   * 存的值要**校验**再用：localStorage 是可以手改的，坏值会让
   * gridTemplateColumns 拿到 NaN，整个列表塌掉。
   */
  useEffect(() => {
    const saved = window.localStorage.getItem('atlas:gallerySize')
    if (saved && isGallerySize(saved)) setSize(saved)
  }, [])

  const pickSize = useCallback((next: GallerySize) => {
    setSize(next)
    window.localStorage.setItem('atlas:gallerySize', next)
  }, [])

  const pickDomain = useCallback((next: DomainCode) => {
    setDomain(next)
    window.localStorage.setItem('atlas:domain', next)
    setFilter(EMPTY_FILTER)
  }, [])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/atlas/entries')
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || '加载失败')
      setEntries(body.data)
      setCounts(body.counts)
      setUntagged(body.untagged ?? 0)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // tag 列表随条目一起刷新 —— 不单独开一个接口，v0 不值得
  useEffect(() => {
    const seen = new Map<string, Tag>()
    for (const entry of entries) for (const tag of entry.tags) if (!seen.has(tag.name)) seen.set(tag.name, tag)
    setTags([...seen.values()].sort((left, right) => left.name.localeCompare(right.name)))
  }, [entries])

  const visible = useMemo(() => {
    return entries.filter((entry) => {
      if (filter.domain && entry.domain !== filter.domain) return false
      if (filter.status && entry.status !== filter.status) return false
      if (filter.untagged && entry.tags.length > 0) return false
      if (filter.origin && !entry.tags.some((tag) => tag.origin === filter.origin)) return false
      if (filter.tags.length > 0 && !filter.tags.every((tag) => entry.tags.some((item) => item.name === tag))) return false
      if (filter.q.trim()) {
        const needle = filter.q.trim().toLowerCase()
        const haystack = [entry.name, entry.notes, entry.sourceGame, entry.sourceTitle, ...entry.tags.map((tag) => tag.name)]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [entries, filter])

  /**
   * 点卡片开 drawer 时拉完整详情。
   *
   * ⚠️ 必须单独拉：列表返回的是 EntrySummary，不含 extension。
   * 而 extension 只在该 domain 的条目上才有值 —— 判断要不要查都要先知道 domain。
   */
  const openDetail = async (summary: EntrySummary) => {
    const response = await fetch(`/api/atlas/entries/${summary.id}`)
    const body = await response.json()
    if (response.ok && body.success) setSelected(body.data)
  }

  if (domain === null) {
    return <DomainGate onPick={pickDomain} />
  }

  const activeDomain = domainOf(domain)

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">Creative Atlas</h1>
        <span className="text-muted-foreground">/</span>
        {/* 库是上下文：常驻顶栏，不在采集流里。 */}
        <DomainSwitcher current={domain} onChange={pickDomain} />
        <span className="ml-auto text-[11px] text-muted-foreground">{entries.length} 条 ·全部类型</span>
      </header>

      {error && <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div>}

      {/* ⚠️ 这里**不能**是 shrink-0。度量区默认展开后 QuickAdd 会变高，
          钉住高度就会把下面的 Gallery 挤出视口 —— 表现是「点了展开但
          什么都没变，只是把内容顶走了」（2026-10-06 实测）。
          min-h-0 + shrink 让它自然占位，主区自己收缩。 */}
      {activeDomain && (
        <div className="shrink border-b p-3">
          <QuickAdd domain={activeDomain} knownTags={tags.map((tag) => tag.name)} onSaved={() => void load()} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <AtlasSidebar entries={entries} tags={tags} filter={filter} onFilter={setFilter} counts={counts} untaggedCount={untagged} />

        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar filter={filter} onFilter={setFilter} resultCount={visible.length} size={size} onSizeChange={pickSize} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-8 text-sm text-muted-foreground">载入中…</p>
            ) : (
              <EntryGrid entries={visible} selectedId={selected?.id} onSelect={(entry) => void openDetail(entry)} size={size} />
            )}
          </div>
        </main>
      </div>

      {selected && (
        <EntryDrawer
          entry={selected}
          onClose={() => setSelected(null)}
          onChange={(next) => {
            setSelected(next)
            void load()
          }}
          onDeleted={(id) => {
            setSelected(null)
            setEntries((current) => current.filter((item) => item.id !== id))
            void load()
          }}
        />
      )}
    </div>
  )
}