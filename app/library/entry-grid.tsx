'use client'

import { GALLERY_MIN_COLUMN, STATUS_LABEL, type EntrySummary, type GallerySize } from '@/types/atlas'
import { SharpImage } from './sharp-image'

/**
 * Gallery —— 三种布局，共用一份数据。
 *
 * ⚠️ **图墙（sm / lg）回答「认得出是什么」，列表（list）回答「库里有什么」。**
 * 这是两种不同的浏览动作，扫一行文字比扫一张缩略图快得多 —— 所以列表档
 * 不是「更密的图墙」，它是另一个控件。区别体现在**信息密度与图的比例**：
 * 图墙里图是主角，列表里图只是行首的一个定位符。
 *
 * ⚠️ **sm / lg 档的卡片上只显示最少的信息**：图、名字、tag。
 * axisValues 一律不上卡片 —— 它是 sparse 的，没打分的维度显示「—」只会
 * 让人以为漏填了，而那正是设计意图（没评过 ≠ 0 分）。
 * 但**打了分的维度显示为小圆点**，一眼能看出这条评过没。
 *
 * ⚠️ **列表档是唯一显示状态与来源的地方**。图墙上不放状态是因为
 * 一个 96px 的格子塞不下「Inbox + 1 个 tag + 已评数」而还能扫；
 * 列表行的横向空间是白给的，不用白不用。
 */
export function EntryGrid({ entries, selectedId, onSelect, size = 'sm' }: {
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
            把图或图片链接拖进窗口就能存一条 —— 一次一张。建议先录 20 条，再判断这套流程你受不受得了。
          </p>
        </div>
      </div>
    )
  }

  if (size === 'list') {
    return (
      <ul
        className="grid gap-1.5 p-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${GALLERY_MIN_COLUMN.list}px, 1fr))` }}
      >
        {entries.map((entry) => {
          const scored = Object.keys(entry.axisValues).length
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onSelect(entry)}
                title={entry.name || entry.originalName || '未命名'}
                className={`flex w-full items-center gap-2 rounded-md border px-1.5 py-1 text-left transition-colors hover:border-foreground/40 ${
                  selectedId === entry.id ? 'border-foreground bg-accent/40' : ''
                }`}
              >
                {/* 缩略图只做「定位符」：固定 32px，不参与放大逻辑 ——
                    在列表里它的职责是「这条有图 / 长这样」，不是「看清细节」。 */}
                <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded bg-muted">
                  {entry.imagePath ? (
                    <SharpImage
                      src={`/api/atlas/entries/${entry.id}/image`}
                      alt=""
                      maxUp={1}
                      className="flex size-full items-center justify-center"
                    />
                  ) : (
                    <span className="text-[9px] text-muted-foreground">无图</span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">
                    {entry.name || entry.originalName || '未命名'}
                  </span>
                  {/*
                    ⚠️ 副行放来源而不是 tag：列表是「读」的场景，来源是
                    「这条从哪来」的第一顺位信息，tag 在图墙里已经看得到。
                  */}
                  {entry.source ? (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {entry.source}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {scored > 0 && (
                    <span title={`评过 ${scored} 个维度`} className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                      <span className="size-1 rounded-full bg-foreground/50" />
                      {scored}
                    </span>
                  )}
                  {entry.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag.id}
                      className={`max-w-16 truncate rounded px-1 py-0.5 text-[10px] ${tag.origin === 'system' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}
                    >
                      {tag.name}
                    </span>
                  ))}
                  {entry.tags.length > 2 && (
                    <span className="text-[10px] text-muted-foreground">+{entry.tags.length - 2}</span>
                  )}
                  <span className="w-14 text-right text-[10px] text-muted-foreground">{STATUS_LABEL[entry.status]}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    )
  }

  const column = GALLERY_MIN_COLUMN[size]
  // ⚠️ sm 档是**默认档**（v0.2 起），所以它是唯一需要「省地方」的档位：
  // 96px 的格子里塞 3 个 tag 只会变成一团糊 —— 那时候「显示数量」这个
  // 信息本身就不可读了，不如不给。
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
        const scored = Object.keys(entry.axisValues).length
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
            <div className="flex aspect-square items-center justify-center bg-muted p-1">
              {entry.imagePath ? (
                // ⚠️ 卡片负责「认得出是什么」，不负责「看清每个像素」。
                // 小图（像素画 / 老游戏截图）放大超过原生分辨率只会变马赛克，
                // 所以 SharpImage 给它一个放大上限 + 禁止插值。详见 sharp-image.tsx。
                <SharpImage
                  src={`/api/atlas/entries/${entry.id}/image`}
                  alt={entry.name || entry.originalName}
                  className="flex size-full items-center justify-center"
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
