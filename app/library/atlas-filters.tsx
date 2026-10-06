'use client'

import { useMemo } from 'react'
import { Filter, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DOMAINS, GALLERY_SIZES, GALLERY_SIZE_LABEL, STATUS_LABEL, TAG_GROUP_HINT, TAG_GROUP_KEYS, TAG_GROUP_LABEL, type DomainCode, type EntryStatus, type EntrySummary, type GallerySize, type Tag, type TagGroup, type TagOrigin } from '@/types/atlas'

/**
 * 侧栏 + 筛选栏。
 *
 * ⚠️ **v0.2：这里没有「受控 taxonomy」分组了。** tag 是自由标签，没有维度
 * 归属，所以不存在「按维度分组显示」这回事 —— 全部平铺在「标签」一栏下。
 * taxonomy 是独立的度量体系，它的展示位置是 Detail drawer 和卡片，
 * 不是侧栏筛选。
 *
 * ⚠️ 这一栏现在多了 domain 筛选：Catalog 要能看到所有类型，所以
 * 「全部类型」是默认态。
 */

export type AtlasFilter = {
  /** undefined = 全部类型。 */
  domain?: DomainCode
  status?: EntryStatus
  tags: string[]
  /** 只看没打标签的条目。tags 不强制之后，这是补欠账的入口。 */
  untagged: boolean
  /** 只看 origin 为指定值的tag。系统 tag 可按 ruleId 整批查。 */
  origin?: TagOrigin
  /** 搜名字、笔记、来源。 */
  q: string
}

export const EMPTY_FILTER: AtlasFilter = { tags: [], q: '', untagged: false }

export function AtlasSidebar({
  entries,
  tags,
  filter,
  onFilter,
  counts,
  untaggedCount,
}: {
  entries: EntrySummary[]
  tags: Tag[]
  filter: AtlasFilter
  onFilter: (next: AtlasFilter) => void
  counts: Record<EntryStatus, number>
  untaggedCount: number
}) {
  const usage = useMemo(() => {
    const counted = new Map<string, number>()
    const byOrigin = new Map<string, TagOrigin>()
    const byGroup = new Map<string, TagGroup>()
    for (const entry of entries) {
      for (const tag of entry.tags) {
        counted.set(tag.name, (counted.get(tag.name) ?? 0) + 1)
        byOrigin.set(tag.name, tag.origin)
        // ⚠️ **同一个 tag 可能出现在不同条目上**，而 group 挂在 tag 实体上，
        // 所以这里取任一份即可 —— 真出现不一致时该去修 tag 表，不是在界面上
        // 显示一个「随机选中的组」。
        byGroup.set(tag.name, tag.group)
      }
    }
    return { counted, byOrigin, byGroup }
  }, [entries])

  /** 在当前 domain 范围内的条目数 —— 库切换时侧栏计数要跟着变。 */
  const inScope = useMemo(() => entries.filter((entry) => !filter.domain || entry.domain === filter.domain), [entries, filter.domain])
  const scopeTagCount = useMemo(() => {
    const names = new Set<string>()
    for (const entry of inScope) for (const tag of entry.tags) names.add(tag.name)
    return names
  }, [inScope])

  /**
   * 把当前可见的 tag 按命名空间聚拢。
   *
   * ⚠️ 只显示**这个库里真的用过的组** —— 一个组名下没有任何 tag 时，
   * 显示它的名字只会占地方并让人以为「我应该往这里填」。
   *
   * 顺序：按 TAG_GROUP_KEYS 的声明顺序（primitive / visual / concept /
   * role / context / taxonomy），未归类的落最后。声明顺序是刻意排的——
   * 从「它用了什么套路」到「它出现在什么场合」，从具体到宽泛。
   */
  const tagGroupsInUse = useMemo(() => {
    const visible = [...scopeTagCount].filter(
      (name) => !filter.origin || usage.byOrigin.get(name) === filter.origin,
    )
    const grouped = new Map<TagGroup, string[]>()
    for (const name of visible) {
      const key = usage.byGroup.get(name) ?? ''
      const list = grouped.get(key) ?? []
      list.push(name)
      grouped.set(key, list)
    }
    return [...grouped.entries()]
      .map(([key, names]) => ({
        key,
        names: names.sort((left, right) => (usage.counted.get(right) ?? 0) - (usage.counted.get(left) ?? 0) || left.localeCompare(right)),
      }))
      .sort((left, right) => {
        // 未归类的（''）排最后，其余按声明顺序。
        if (left.key === '') return 1
        if (right.key === '') return -1
        return TAG_GROUP_KEYS.indexOf(left.key) - TAG_GROUP_KEYS.indexOf(right.key)
      })
  }, [scopeTagCount, usage, filter.origin])

  const toggleTag = (name: string) => {
    // ⚠️ 选了具体 tag 就退出「未打标」——两者互斥，后端也会拒，
    // 但前端先切掉模式，免得用户点了还得到一句报错。
    onFilter({
      ...filter,
      untagged: false,
      tags: filter.tags.includes(name) ? filter.tags.filter((item) => item !== name) : [...filter.tags, name],
    })
  }

  const total = inScope.length

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-muted/20 p-3">
      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">类型 · Domain</h2>
        <div className="space-y-0.5">
          <FilterRow label="全部类型" count={entries.length} active={!filter.domain} onClick={() => onFilter({ ...filter, domain: undefined })} />
          {DOMAINS.map((domain) => (
            <FilterRow
              key={domain.code}
              label={domain.labelZh}
              count={entries.filter((entry) => entry.domain === domain.code).length}
              active={filter.domain === domain.code}
              onClick={() => onFilter({ ...filter, domain: filter.domain === domain.code ? undefined : domain.code })}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">状态</h2>
        <div className="space-y-0.5">
          <FilterRow label="全部" count={total} active={!filter.status && !filter.untagged} onClick={() => onFilter({ ...filter, status: undefined, untagged: false })} />
          {(Object.keys(STATUS_LABEL) as EntryStatus[]).map((status) => (
            <FilterRow
              key={status}
              label={STATUS_LABEL[status]}
              count={counts[status]}
              active={filter.status === status}
              onClick={() => onFilter({ ...filter, status: filter.status === status ? undefined : status })}
            />
          ))}
          <FilterRow
            label="未打标"
            count={untaggedCount}
            active={filter.untagged}
            onClick={() => onFilter({ ...filter, untagged: !filter.untagged, status: undefined })}
          />
        </div>
        {untaggedCount > 0 && !filter.untagged && (
          <button
            type="button"
            onClick={() => onFilter({ ...filter, untagged: true, status: undefined })}
            className="mt-1.5 w-full rounded-md bg-secondary/60 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-secondary"
          >
            {untaggedCount} 条还没打标，去补 →
          </button>
        )}
      </section>

      {scopeTagCount.size > 0 && (
        <section>
          <div className="mb-1.5 flex items-baseline justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">标签</h2>
            {/* origin 筛选：用户手动打的 vs 系统打的。项目标记全在后者。 */}
            <div className="flex gap-1 text-[10px]">
              {(['user', 'system'] as TagOrigin[]).map((origin) => (
                <button
                  key={origin}
                  type="button"
                  onClick={() => onFilter({ ...filter, origin: filter.origin === origin ? undefined : origin })}
                  className={cn(
                    'rounded px-1 py-0.5 transition-colors',
                    filter.origin === origin ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {origin === 'user' ? '手动' : '系统'}
                </button>
              ))}
            </div>
          </div>
          {/* ⭐⭐ 按命名空间分组显示（2026-10-06）。
              这是给tag 加 group 的**主要目的** —— 不是为了好看，是为了让
              半年后几百个 tag 时还能用分面筛选。否则它们只能挤在一屏里，
              而人一旦找不到一个 tag 就懒得用它，那套设计词汇就废了。

              ⚠️ **未归类的排最后，且不折叠** —— 归类不强制，所以新tag 默认
              落在这里。把它们藏起来等于惩罚「随手记」，而随手记的频次远高于
              归类的需要。
          */}
          <div className="space-y-2.5">
            {tagGroupsInUse.map((group) => (
              <div key={group.key}>
                {/* ⚠️ 空串组（未归类）没有 TAG_GROUP_LABEL 条目 —— 直接索引会拿到
                    undefined，标题就渲染成空白。用兜底文案而不是让类型放宽：
                    「未归类」是给人看的话，'' 不是。 */}
                <p
                  className="mb-1 text-[10px] text-muted-foreground"
                  title={group.key === '' ? '还没归类的 tag —— 点一个能改归类' : TAG_GROUP_HINT[group.key]}
                >
                  {group.key === '' ? '未归类' : TAG_GROUP_LABEL[group.key]}
                </p>
                <div className="flex flex-wrap gap-1">
                  {group.names.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleTag(name)}
                      title={usage.byOrigin.get(name) === 'system' ? '系统 tag' : undefined}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                        filter.tags.includes(name)
                          ? 'border-transparent bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent',
                      )}
                    >
                      {usage.byOrigin.get(name) === 'system' ? '⚙ ' : ''}
                      {name}
                      <span className="ml-1 opacity-60">{usage.counted.get(name) ?? 0}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {tags.length > 0 && scopeTagCount.size === 0 && (
            <p className="text-[11px] text-muted-foreground">这个库里还没打过标。</p>
          )}
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

/**
 * 尺寸切换 —— 三档，对应三种浏览意图。
 *
 * ⚠️ 用图标而不是文字：三个字（小/中/大）在这个工具栏里会和筛选按钮
 * 混成一片，而「格子大小」这个信息本来就该是**看起来就知道**的。
 * 方形数量 = 格子大小，比「中」直观。
 */
export function SizeSwitcher({ size, onChange }: { size: GallerySize; onChange: (next: GallerySize) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label="卡片大小">
      {GALLERY_SIZES.map((option) => {
        const active = option === size
        // 三个方块从小到大排列 —— 图标本身就是当前档位的示意图。
        const count = option === 'sm' ? 3 : option === 'md' ? 2 : 1
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={active}
            title={`${GALLERY_SIZE_LABEL[option]}图`}
            className={cn(
              'flex h-6 items-center gap-0.5 rounded px-1.5 transition-colors',
              active ? 'bg-foreground text-background' : 'hover:bg-muted',
            )}
          >
            {Array.from({ length: count }, (_, index) => (
              <span
                key={index}
                className={cn('rounded-[1px] border', option === 'sm' ? 'size-1.5' : option === 'md' ? 'size-2' : 'size-2.5')}
                style={active ? { borderColor: 'currentColor' } : undefined}
              />
            ))}
          </button>
        )
      })}
    </div>
  )
}

export function FilterBar({ filter, onFilter, resultCount, size, onSizeChange }: {
  filter: AtlasFilter
  onFilter: (next: AtlasFilter) => void
  resultCount: number
  size: GallerySize
  onSizeChange: (next: GallerySize) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <div className="relative min-w-56 flex-1">
        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="搜索"
          placeholder="搜名字、笔记、来源…"
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
      {(filter.tags.length > 0 || filter.q || filter.status || filter.untagged || filter.domain || filter.origin) && (
        <Button variant="ghost" size="sm" onClick={() => onFilter({ ...EMPTY_FILTER })}>
          清空筛选
        </Button>
      )}
      <SizeSwitcher size={size} onChange={onSizeChange} />
    </div>
  )
}