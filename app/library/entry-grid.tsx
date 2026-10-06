'use client'

import { GALLERY_MIN_COLUMN, STATUS_LABEL, type EntrySummary, type GallerySize } from '@/types/atlas'

/**
 * Gallery 卡片墙 —— 「视觉浏览」是三个操作之一。
 *
 * ⚠️ 卡片上只显示最少的信息：图、名字、tag。
 * taxonomy 一律不上卡片 —— 它是 sparse 的，没打分的维度显示「—」只会
 * 让人以为漏填了，而那正是设计意图（没评过 ≠ 0 分）。
 *
 * ⚠️ 但**打了分的维度显示为小圆点**，一眼能看出这条评过没。
 *
 * ⚠️ 三档尺寸的差别不只是图大小：sm 档连文字区都收窄、tag 只留 1 个。
 * 90px 的格子里塞 3 个 tag 只会变成一团糊 —— 那时候「显示数量」这个
 * 信息本身就不可读了，不如不给。
 */
export function EntryGrid({ entries, selectedId, onSelect, size = 'md' }: {
  entries: EntrySummary[]
  selectedId?: string
  onSelect: (entry: EntrySummary) => void
  size?: GallerySize
}) {
  if (entries.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm font-semibold">还没有东西</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            看到参考就把图粘到上面 —— 一次一张。建议先录 20 条，再判断这套流程你受不受得了。
          </p>
        </div>
      </div>
    )
  }

  const column = GALLERY_MIN_COLUMN[size]
  const dense = size === 'sm'
  const tagLimit = dense ? 1 : 3

  return (
    // ⚠️ 用 inline style 传 minmax 宽度：Tailwind 的任意值语法
    // `minmax(96px,1fr)` 里那个逗号会被当成类名分隔符，写成类一定失败。
    <div
      className="grid gap-3 p-4"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${column}px, 1fr))` }}
    >
      {entries.map((entry) => {
        const scored = Object.keys(entry.taxonomy).length
        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(entry)}
            title={entry.name || entry.originalName || '未命名'}
            className={`group flex flex-col overflow-hidden rounded-lg border text-left transition-colors hover:border-foreground/40 ${
              selectedId === entry.id ? 'border-foreground' : ''
            }`}
          >
            <div className="aspect-square bg-muted">
              {entry.imagePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/atlas/entries/${entry.id}/image`}
                  alt={entry.name || entry.originalName}
                  loading="lazy"
                  className="size-full object-contain"
                />
              ) : (
                // ⚠️ imagePath 从 v0.2 起可空。没有图的条目给占位而不是
                // 破图图标 —— 破图图标看着像加载失败，不像「这条本来就没图」。
                <span className="grid size-full place-items-center text-[10px] text-muted-foreground">无图</span>
              )}
            </div>
            {/* ⚠️ sm 档去掉 min-h-16 与 padding-x 上的冗余：格子只有 96px，
                文字区再占 64px 高，图就只剩屏幕的三分之一。 */}
            <div className={dense ? 'flex flex-col gap-0.5 p-1.5' : 'flex min-h-16 flex-col gap-1 p-2'}>
              <p className={`truncate font-medium ${dense ? 'text-[10px]' : 'text-xs'}`}>
                {entry.name || entry.originalName || '未命名'}
              </p>
              {entry.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {entry.tags.slice(0, tagLimit).map((tag) => (
                    <span
                      key={tag.id}
                      className={`rounded px-1.5 py-0.5 ${dense ? 'text-[9px]' : 'text-[10px]'} ${tag.origin === 'system' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {entry.tags.length > tagLimit && (
                    <span className={`text-muted-foreground ${dense ? 'text-[9px]' : 'text-[10px]'}`}>+{entry.tags.length - tagLimit}</span>
                  )}
                </div>
              )}
              {/* 评过的维度数。sm 档只留那个点，不写数字 —— 96px 宽放不下
                  两位数字加标签，留个点就够了。 */}
              {(scored > 0 || entry.status !== 'inbox') && (
                <div className="mt-auto flex items-center gap-1 text-muted-foreground">
                  {scored > 0 && (
                    <span title={`评过 ${scored} 个维度`} className="flex items-center gap-0.5">
                      <span className="size-1 rounded-full bg-foreground/50" />
                      {!dense && <span className="text-[10px]">{scored}</span>}
                    </span>
                  )}
                  {entry.status !== 'inbox' && (
                    <span className={`ml-auto ${dense ? 'text-[9px]' : 'text-[10px]'}`}>{STATUS_LABEL[entry.status]}</span>
                  )}
                </div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
