'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QuickAdd } from './quick-add'
import { AtlasSidebar, FilterBar, type AtlasFilter } from './atlas-filters'
import { EntryGrid } from './entry-grid'
import { EntryDrawer } from './entry-drawer'
import type { EntryStatus, EntrySummary, Tag } from '@/types/atlas'

/**
 * Monster 页面 —— v0 的全部界面。
 *
 * 三段式布局（照 navi 的 app/aaa/workspace.tsx）：左栏筛选 + 顶部 Quick Add +
 * 主区卡片墙 + 右侧 drawer。
 *
 * ⚠️ 筛选在客户端做，不过服务端 —— v0 的量级是几百条，一次全取回来
 * 换来「改筛选条件零往返」。真正的分页留到 1000 条以上。
 */
export function MonsterWorkspace() {
  const [entries, setEntries] = useState<EntrySummary[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [counts, setCounts] = useState<Record<EntryStatus, number>>({ inbox: 0, reviewed: 0, reference: 0 })
  const [untagged, setUntagged] = useState(0)
  const [filter, setFilter] = useState<AtlasFilter>({ tags: [], q: '', untagged: false })
  const [selected, setSelected] = useState<EntrySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  const visible = entries.filter((entry) => {
    if (filter.status && entry.status !== filter.status) return false
    if (filter.untagged && entry.tags.length > 0) return false
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

  const onSaved = () => {
    void load()
  }

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">Creative Atlas / Monster</h1>
        <p className="text-[11px] text-muted-foreground">
          {entries.length} 条 · v0 只做 Monster
        </p>
        <span className="ml-auto text-[11px] text-muted-foreground">
          粘图 → 打tag → Enter
        </span>
      </header>

      {error && <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div>}

      <div className="shrink-0 border-b p-3">
        <QuickAdd knownTags={tags.map((tag) => tag.name)} onSaved={onSaved} />
      </div>

      <div className="flex min-h-0 flex-1">
        <AtlasSidebar entries={entries} tags={tags} filter={filter} onFilter={setFilter} counts={counts} untaggedCount={untagged} />

        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar filter={filter} onFilter={setFilter} resultCount={visible.length} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-8 text-sm text-muted-foreground">载入中…</p>
            ) : (
              <EntryGrid entries={visible} selectedId={selected?.id} onSelect={setSelected} />
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