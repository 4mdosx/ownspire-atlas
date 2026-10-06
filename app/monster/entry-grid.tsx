'use client'

import { STATUS_LABEL, type EntrySummary } from '@/types/atlas'

/**
 * Gallery 卡片墙 —— 「视觉浏览」是v0 的三个操作之一。
 *
 * ⚠️ 卡片上只显示最少的信息：图、名字、tag。
 * 设计字段（bodyType / scale / movement…）一律不上卡片 —— 它们是可空字段，
 * 空的时候显示一堆「—」只会让人以为漏填了。
 */
export function EntryGrid({ entries, selectedId, onSelect }: {
  entries: EntrySummary[]
  selectedId?: string
  onSelect: (entry: EntrySummary) => void
}) {
  if (entries.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm font-semibold">还没有东西</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            看到参考就把图粘到上面 —— 一次一张。建议先录20 条，再判断这套流程你受不受得了。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 p-4">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSelect(entry)}
          className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors hover:border-foreground/40 ${
            selectedId === entry.id ? 'border-foreground' : ''
          }`}
        >
          <div className="aspect-square bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/atlas/entries/${entry.id}/image`}
              alt={entry.name || entry.originalName}
              loading="lazy"
              className="size-full object-contain"
            />
          </div>
          <div className="flex min-h-16 flex-col gap-1 p-2">
            <p className="truncate text-xs font-medium">{entry.name || entry.originalName || '未命名'}</p>
            <div className="flex flex-wrap gap-1">
              {entry.tags.slice(0, 3).map((tag) => (
                <span key={tag.id} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {tag.name}
                </span>
              ))}
              {entry.tags.length > 3 && <span className="text-[10px] text-muted-foreground">+{entry.tags.length - 3}</span>}
            </div>
            {entry.status !== 'inbox' && (
              <span className="mt-auto text-[10px] text-muted-foreground">{STATUS_LABEL[entry.status]}</span>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}