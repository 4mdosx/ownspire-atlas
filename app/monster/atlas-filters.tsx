'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Filter, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CONTROLLED_TAXONOMY, STATUS_LABEL, type EntryStatus, type EntrySummary, type Tag } from '@/types/atlas'

/**
 * 侧栏 + 筛选栏。
 *
 * ⚠️ 这三样东西（状态筛选 / tag 筛选 / 搜索）在 v0 就是全部 —— 文档里说
 * 「三个操作就够：视觉浏览 → Tag 筛选 → 搜索」。所以这里没有第四个控件。
 */

const DIMENSION_LABEL: Record<keyof typeof CONTROLLED_TAXONOMY, string> = {
  form: 'Form',
  scale: 'Scale',
  movement: 'Movement',
  combat: 'Combat',
  role: 'Role',
}

export type AtlasFilter = {
  status?: EntryStatus
  tags: string[]
  q: string
}

export function AtlasSidebar({
  entries,
  tags,
  filter,
  onFilter,
  counts,
}: {
  entries: EntrySummary[]
  tags: Tag[]
  filter: AtlasFilter
  onFilter: (next: AtlasFilter) => void
  counts: Record<EntryStatus, number>
}) {
  const usage = useMemo(() => {
    const counted = new Map<string, number>()
    for (const entry of entries) for (const tag of entry.tags) counted.set(tag.name, (counted.get(tag.name) ?? 0) + 1)
    return counted
  }, [entries])

  const toggleTag = (name: string) => {
    onFilter({ ...filter, tags: filter.tags.includes(name) ? filter.tags.filter((item) => item !== name) : [...filter.tags, name] })
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-muted/20 p-3">
      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Collection</h2>
        <p className="mb-2 text-sm font-semibold">Monster</p>
        <div className="space-y-0.5">
          <FilterRow label="全部" count={Object.values(counts).reduce((sum, n) => sum + n, 0)} active={!filter.status} onClick={() => onFilter({ ...filter, status: undefined })} />
          {(Object.keys(STATUS_LABEL) as EntryStatus[]).map((status) => (
            <FilterRow
              key={status}
              label={STATUS_LABEL[status]}
              count={counts[status]}
              active={filter.status === status}
              onClick={() => onFilter({ ...filter, status: filter.status === status ? undefined : status })}
            />
          ))}
        </div>
      </section>

      {(Object.keys(CONTROLLED_TAXONOMY) as Array<keyof typeof CONTROLLED_TAXONOMY>).map((dimension) => (
        <section key={dimension}>
          <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{DIMENSION_LABEL[dimension]}</h2>
          <div className="space-y-0.5">
            {CONTROLLED_TAXONOMY[dimension].map((name) => (
              <FilterRow
                key={name}
                label={name}
                count={usage.get(name) ?? 0}
                active={filter.tags.includes(name)}
                onClick={() => toggleTag(name)}
              />
            ))}
          </div>
        </section>
      ))}

      {tags.filter((tag) => !(Object.values(CONTROLLED_TAXONOMY).flat() as string[]).includes(tag.name)).length > 0 && (
        <section>
          <h2 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">自由 tag</h2>
          <div className="flex flex-wrap gap-1">
            {tags
              .filter((tag) => !(Object.values(CONTROLLED_TAXONOMY).flat() as string[]).includes(tag.name))
              .map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.name)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    filter.tags.includes(tag.name) ? 'border-transparent bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {tag.name}
                  <span className="ml-1 opacity-60">{usage.get(tag.name) ?? 0}</span>
                </button>
              ))}
          </div>
        </section>
      )}
    </aside>
  )
}

function FilterRow({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm transition-colors', active ? 'bg-foreground text-background' : 'hover:bg-muted')}
    >
      <span className="truncate">{label}</span>
      <span className="ml-2 shrink-0 text-[11px] opacity-70">{count}</span>
    </button>
  )
}

export function FilterBar({ filter, onFilter, resultCount }: { filter: AtlasFilter; onFilter: (next: AtlasFilter) => void; resultCount: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <div className="relative min-w-56 flex-1">
        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="搜索"
          placeholder="搜名字、笔记、来源游戏…"
          value={filter.q}
          onChange={(event) => onFilter({ ...filter, q: event.target.value })}
          className="h-8 pl-7 text-xs"
        />
      </div>

      {filter.tags.length > 0 && (
        <div className="flex items-center gap-1">
          <Filter className="size-3 text-muted-foreground" />
          {filter.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => onFilter({ ...filter, tags: filter.tags.filter((item) => item !== tag) })}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] hover:bg-muted"
            >
              {tag}
              <X className="size-2.5" />
            </button>
          ))}
        </div>
      )}

      <span className="ml-auto text-xs text-muted-foreground">{resultCount} 条</span>
      {(filter.tags.length > 0 || filter.q || filter.status) && (
        <Button variant="ghost" size="sm" onClick={() => onFilter({ tags: [], q: '' })}>
          清空筛选
        </Button>
      )}
    </div>
  )
}