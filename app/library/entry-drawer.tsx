'use client'

import { useEffect, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { AxisRow } from './axis-control'
import { SharpImage, UPSCALE_CAP_DETAIL } from './sharp-image'
import { SourceFields } from './source-fields'
import { UNCLEAR_KEY } from '@/options/shared'
import { domainOf, STATUS_LABEL, type DesignAxis, type DesignSpace, type EntryDetail, type EntryStatus } from '@/types/atlas'

type DetailTab = 'basic' | 'source' | 'tags' | 'axis' | 'analysis'
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'basic', label: '基本信息' },
  { id: 'source', label: '来源' },
  { id: 'tags', label: 'Tags' },
  { id: 'axis', label: 'Axis' },
  { id: 'analysis', label: 'Design Analysis' },
]

/**
 * Detail 抽屉 —— 点卡片后从右侧滑出。
 *
 * ⚠️ 刻意做成「改完立刻生效、随开随存」，不设保存按钮。
 * 采集系统里每多一个「记得点保存」的步骤，就多一次数据丢失的机会。
 * 代价是打错字会立刻生效 —— 对单人来说这个交易划算。
 */
export function EntryDrawer({ entry, onClose, onChange, onDeleted }: {
  entry: EntryDetail
  onClose: () => void
  onChange: (next: EntryDetail) => void
  onDeleted: (id: string) => void
}) {
  const [draft, setDraft] = useState<EntryDetail>(entry)
  const [tagDraft, setTagDraft] = useState('')
  const [tab, setTab] = useState<DetailTab>('basic')
  const [error, setError] = useState('')

  /**
   * ⭐ 当前编辑的设计空间（2026-10-06）。
   *
   * 切空间会重新拉这条记录的坐标 —— 因为两个空间里存的是**不同的值**：
   * 「原作的移动性」与「我的移动性」是两个不同的问题。共用一份 draft 会让
   * 一边的分数显示在另一边，而那正是这套结构要消除的歧义。
   */
  const [spaces, setSpaces] = useState<DesignSpace[]>([])
  const [axes, setAxes] = useState<DesignAxis[]>([])
  const [spaceId, setSpaceId] = useState('space-mine')

  useEffect(() => setDraft(entry), [entry.id, entry.updatedAt])

  /** 空间列表只拉一次 —— 它不长在 entry 上。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch('/api/atlas/spaces')
      const body = await response.json()
      if (cancelled || !response.ok || !body.success) return
      setSpaces(body.data)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 换空间 → 重新拉该空间下的维度定义 + 这条记录在该空间的坐标。
   *
   * ⚠️ 两个请求必须一起发：坐标要按空间读，维度也要按空间取。拿「我的」的
   * 分数配「原作」的档位词，界面上会显示成「原作 · giant」，而那条记录
   * 在原作空间里根本没有这个轴 —— 分数与档位对不上。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [axesRes, entryRes] = await Promise.all([
        fetch(`/api/atlas/spaces?axesOf=${encodeURIComponent(spaceId)}`),
        fetch(`/api/atlas/entries/${entry.id}?spaceId=${encodeURIComponent(spaceId)}`),
      ])
      const [axesBody, entryBody] = await Promise.all([axesRes.json(), entryRes.json()])
      if (cancelled) return
      if (axesRes.ok && axesBody.success) setAxes(axesBody.data)
      if (entryRes.ok && entryBody.success) {
        setDraft(entryBody.data)
        onChange(entryBody.data)
      }
    })()
    return () => {
      cancelled = true
    }
    // ⚠️ onChange 不进依赖：它是父组件的回调，进依赖会在每次父级重渲染时
    // 重拉这条记录 —— 而这会触发 onChange，形成死循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, entry.id])

  const patch = async (changes: Record<string, unknown>) => {
    setError('')
    const response = await fetch(`/api/atlas/entries/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // ⚠️ spaceId 必须跟着走：坐标写到哪个空间由它决定。不传就默认写到
      // 「我的」—— 于是用户在「原作」视图里打分，分数却落进了另一个空间。
      body: JSON.stringify({ ...changes, spaceId }),
    })
    const body = await response.json()
    if (!response.ok || !body.success) return setError(body.error || '保存失败')
    setDraft(body.data)
    onChange(body.data)
  }

  /**
   * 追加标签。
   *
   * ⚠️ 传全量 tagNames（只含 origin='user' 的）。后端 updateEntry 的替换语义
   * 默认只替换 user 关系，系统 tag 原样保留 —— 所以这里必须把系统 tag
   * 过滤掉，否则它们会被当成 user 重新挂一遍。
   */
  const addTags = async () => {
    const incoming = tagDraft
      .split(/[,，\s]+/)
      .map((item) => item.replace(/^#/, '').trim())
      .filter(Boolean)
    if (incoming.length === 0) return
    const existing = draft.tags.filter((tag) => tag.origin === 'user').map((tag) => tag.name)
    const merged = [...new Set([...existing, ...incoming])]
    setTagDraft('')
    await patch({ tagNames: merged })
  }

  const setConfidence = async (tagId: string, percent: number) => {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return setError('置信度请输入 0–100')
    await patch({ tagConfidence: { tagId, confidence: percent / 100 } })
  }

  const setStatus = async (status: EntryStatus) => {
    const response = await fetch(`/api/atlas/entries/${entry.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const body = await response.json()
    if (response.ok && body.success) {
      setDraft(body.data)
      onChange(body.data)
    }
  }

  const remove = async () => {
    if (!confirm(`删除「${entry.name || entry.originalName || '这条'}」？图片文件会留下，之后用 npm run gc-media 清理。`)) return
    const response = await fetch(`/api/atlas/entries/${entry.id}`, { method: 'DELETE' })
    if (response.ok) onDeleted(entry.id)
  }

  const domain = domainOf(draft.domain)
  const currentSpace = spaces.find((space) => space.id === spaceId) ?? null
  const userTags = draft.tags.filter((tag) => tag.origin === 'user')
  const systemTags = draft.tags.filter((tag) => tag.origin === 'system')

  /**
   * ⭐ 按 group 归拢当前空间的维度。
   *
   * ⚠️ **group 只管排版**：空分组的轴不能被丢掉 —— 那会造成「这条轴不见了」
   * 的静默丢失（2026-10-06 在上一轮踩过一次同类坑）。所以无组的轴挂到
   * 一个兜底分组里，而不是被 filter 掉。
   */
  const axisGroups = axes.reduce<Map<string, DesignAxis[]>>((map, axis) => {
    const key = axis.group.labelZh || ''
    const list = map.get(key) ?? []
    list.push(axis)
    map.set(key, list)
    return map
  }, new Map())

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      {/* ⚠️ 宽度不是随手定的：6 个档位词 + 5 颗星 + 数字框 + 清除按钮并排
          需要 560px 以上，max-w-md（448）会把它们挤到换行甚至出视口。
          图片区给 max-h 而不是 aspect-square —— 正方形的大图会把下方
          所有可编辑内容顶出屏幕。 */}
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background shadow-2xl">
        {/*
          ⚠️ 高度给**固定值**，且容器是 flex 居中而不是 grid。
          两处都是上一轮踩出来的：grid 子项的 `size-full` 会让 <img> 的
          `h-full` 依赖「父元素有确定高度」，一旦不成立就静默失效，
          图被裁掉一截（表现为「只显示了一半」）。
          现在 SharpImage 内部用 `min(cap, 100%)` 自己保证不溢出，
          容器只需要负责「给它一块地方、居中」。38vh 而不是 aspect-square：
          正方形会把下方可编辑内容顶出屏幕。
        */}
        <div className="flex h-[38vh] shrink-0 items-center justify-center overflow-hidden bg-muted p-2">
          {entry.imagePath ? (
            <SharpImage
              src={`/api/atlas/entries/${entry.id}/image`}
              alt={entry.name}
              maxUp={UPSCALE_CAP_DETAIL}
              className="flex size-full items-center justify-center"
              loading="eager"
            />
          ) : (
            <span className="grid size-full place-items-center text-xs text-muted-foreground">这条没有图片</span>
          )}
        </div>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2" role="tablist" aria-label="条目详情">
          {DETAIL_TABS.map((item) => (
            <button key={item.id} type="button" role="tab" id={`entry-tab-${item.id}`}
              aria-selected={tab === item.id} aria-controls={`entry-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={`shrink-0 rounded-md px-2 py-1 text-xs ${tab === item.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div role="tabpanel" id="entry-panel-basic" aria-labelledby="entry-tab-basic" hidden={tab !== 'basic'} className="space-y-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {domain ? `${domain.labelZh} · ` : ''}{STATUS_LABEL[draft.status]}
            </p>
            <Input aria-label="名字" value={draft.name} placeholder="名字" onChange={(event) => setDraft({ ...draft, name: event.target.value })} onBlur={() => draft.name !== entry.name && void patch({ name: draft.name })} className="h-8 text-sm" />
          </div>

          <div className="flex gap-1">
            {(Object.keys(STATUS_LABEL) as EntryStatus[]).map((status) => (
              <Button key={status} size="xs" variant={draft.status === status ? 'default' : 'outline'} onClick={() => void setStatus(status)}>
                {STATUS_LABEL[status]}
              </Button>
            ))}
          </div>

          </div>

          <section role="tabpanel" id="entry-panel-source" aria-labelledby="entry-tab-source" hidden={tab !== 'source'}>
            <SourceFields source={draft.source} author={draft.author} license={draft.license} trainable={draft.trainable}
              onSourceChange={(source) => setDraft((current) => ({ ...current, source }))}
              onAuthorChange={(author) => setDraft((current) => ({ ...current, author }))}
              onLicenseChange={(license) => void patch({ license })}
              onTrainableChange={(trainable) => void patch({ trainable })}
              onSourceCommit={() => { if (draft.source !== entry.source) void patch({ source: draft.source }) }}
              onAuthorCommit={() => { if (draft.author !== entry.author) void patch({ author: draft.author.trim() || UNCLEAR_KEY }) }} />
          </section>

          {/*
            ⭐⭐ 设计空间 —— 一个 entry 在每个空间下各有一组独立坐标。

            这不是「分类归档」而是**语义分离**：「原作的移动性」与「我的移动性」
            是两个不同的问题（对原作的观察 vs 对原作的解读）。挤在一列时，
            半年后把0.70 改成 0.55 就无法判断自己在改什么 —— 于是不敢改，
            不敢改的坐标系会慢慢变成不可动的客观事实，那时 Atlas 就是 wiki 了。

            空间切换器放在这一节的标题行：它决定的是「下面这些分数在回答
            哪个问题」，所以必须在读分数之前就能看到。
          */}
          <section role="tabpanel" id="entry-panel-axis" aria-labelledby="entry-tab-axis" hidden={tab !== 'axis'}>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-xs font-semibold">设计空间</h3>
              {spaces.length > 1 && (
                <select
                  aria-label="设计空间"
                  value={spaceId}
                  onChange={(event) => setSpaceId(event.target.value)}
                  className="h-6 rounded border bg-transparent px-1 text-[11px] outline-none"
                >
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.labelZh}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {currentSpace && (
              <p className="mb-1.5 text-[10px] text-muted-foreground">{currentSpace.hintZh}</p>
            )}

            {axes.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
                这个空间还没有坐标轴。
                <br />
                <span className="opacity-70">
                  {currentSpace?.code === 'source'
                    ? '原作的坐标取决于原作是什么游戏 —— 等真的需要时按那条原作的实际字段定义'
                    : '先给它加几条轴，再开始记'}
                </span>
              </p>
            ) : (
              <>
                <p className="mb-1 text-xs leading-relaxed text-muted-foreground">
                  点档位词直接定档，星星微调。全灰 = 还没想好（不等于 0 分）。
                  <span className="ml-1">改分随时可以 —— 那是判断变了，不是记错了。</span>
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[...axisGroups.entries()].map(([groupKey, groupAxes]) => (
                  <div key={groupKey || 'ungrouped'} className="rounded-md border px-3 pb-1 pt-2">
                    <p className="text-sm font-semibold text-foreground">
                      {groupKey || '未分组'}
                    </p>
                    <div className="divide-y">
                      {groupAxes.map((axis) => (
                        <AxisRow
                          key={axis.key}
                          dimension={axis}
                          value={draft.axisValues[axis.key]}
                          onChange={(score) => {
                            const next = { ...draft.axisValues, [axis.key]: score }
                            setDraft({ ...draft, axisValues: next })
                            void patch({ axisValues: { [axis.key]: score } })
                          }}
                          onClear={() => {
                            const next = { ...draft.axisValues }
                            delete next[axis.key as keyof typeof next]
                            setDraft({ ...draft, axisValues: next })
                            void patch({ clearAxisKey: axis.key })
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                </div>
              </>
            )}
          </section>

          <section role="tabpanel" id="entry-panel-tags" aria-labelledby="entry-tab-tags" hidden={tab !== 'tags'}>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
              标签
              <span className="ml-1.5 font-normal">关联置信度按百分比编辑</span>
            </h3>
            <div className="space-y-2">
              {userTags.map((tag) => (
                <div key={tag.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <label className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    <span className="sr-only">{tag.name} 置信度</span>
                    <input type="number" min="0" max="100" step="1" defaultValue={Math.round(tag.confidence * 100)}
                      key={`${tag.id}-${tag.confidence}`} aria-label={`${tag.name} 置信度百分比`}
                      onBlur={(event) => { if (event.target.value !== '') void setConfidence(tag.id, Number(event.target.value)) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                      className="h-7 w-14 rounded border bg-background px-1 text-right text-xs text-foreground" />%
                  </label>
                  <button
                    type="button"
                    title="摘掉这个标签"
                    onClick={async () => {
                      const response = await fetch(`/api/atlas/entries/${entry.id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ detachTagId: tag.id, spaceId }),
                      })
                      const body = await response.json()
                      if (response.ok && body.success) {
                        setDraft(body.data)
                        onChange(body.data)
                      }
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* ⚠️ 系统 tag 单独一块，不可摘 —— 它们是系统按规则挂的，
                用户摘掉等于把「这条属于哪个项目」的标记抹了。要改走 ruleId。 */}
            {systemTags.length > 0 && (
              <div className="mt-2 space-y-2">
                {systemTags.map((tag) => (
                  <div key={tag.id} title={`系统 tag · 规则 ${tag.ruleId}`} className="flex items-center gap-2 rounded-md border bg-primary/5 px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">⚙ {tag.name}</span>
                    <input type="number" min="0" max="100" step="1" defaultValue={Math.round(tag.confidence * 100)}
                      key={`${tag.id}-${tag.confidence}`} aria-label={`${tag.name} 置信度百分比`}
                      onBlur={(event) => { if (event.target.value !== '') void setConfidence(tag.id, Number(event.target.value)) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                      className="h-7 w-14 rounded border bg-background px-1 text-right text-xs" />%
                  </div>
                ))}
              </div>
            )}
            {/* 就地加签是「未打标」视图的配套：欠账摊开在这里补，
                不该要求用户先回 Quick Add 重录一遍。 */}
            <div className="mt-2 flex gap-2">
              <Input
                aria-label="加标签"
                placeholder={userTags.length === 0 ? '没打标 —— 在这里补，或直接关掉' : '再加一个标签…'}
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  void addTags()
                }}
                className="h-7 text-xs"
              />
              {tagDraft.trim() && (
                <Button size="xs" onClick={() => void addTags()}>
                  加上
                </Button>
              )}
            </div>
          </section>

          <div role="tabpanel" id="entry-panel-analysis" aria-labelledby="entry-tab-analysis" hidden={tab !== 'analysis'} className="space-y-4">
          <section>
            <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
              观察 <span className="font-normal">· 我看到了什么（客观）</span>
            </h3>
            <Textarea
              aria-label="观察"
              rows={5}
              placeholder="剪影：一团圆形，占画面下半&#10;主形体：菌盖 + 短柄&#10;次形体：无&#10;识别特征：盖面斑点&#10;色结构：三色，橙主棕辅&#10;风格化：偏写实，只做了轮廓简化"
              value={draft.observed}
              onChange={(event) => setDraft({ ...draft, observed: event.target.value })}
              onBlur={() => draft.observed !== entry.observed && void patch({ observed: draft.observed })}
              className="text-xs"
            />
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
              判断 <span className="font-normal">· 我认为它为什么成立（主观）</span>
            </h3>
            <Textarea
              aria-label="判断"
              rows={4}
              placeholder="剪影够单纯，不加装饰也能一眼认出&#10;低重心 + 圆形 = 看起来不好惹，但配色又不吓人&#10;三色限制让动画成本压得住"
              value={draft.read}
              onChange={(event) => setDraft({ ...draft, read: event.target.value })}
              onBlur={() => draft.read !== entry.read && void patch({ read: draft.read })}
              className="text-xs"
            />
          </section>

          <section className="rounded-md border-2 border-foreground/15 bg-accent/30 p-3">
            <h3 className="mb-1 text-xs font-semibold">目的 <span className="font-normal text-muted-foreground">· 我为什么留着它</span></h3>
            <Textarea
              aria-label="值得存的原因"
              rows={3}
              placeholder="它身上有什么东西值得我停下来看？"
              value={draft.worthwhileBecause}
              onChange={(event) => setDraft({ ...draft, worthwhileBecause: event.target.value })}
              onBlur={() => draft.worthwhileBecause !== entry.worthwhileBecause && void patch({ worthwhileBecause: draft.worthwhileBecause })}
              className="text-xs"
            />
          </section>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t p-3">
          <span className="text-[11px] text-muted-foreground">{new Date(entry.createdAt).toLocaleString('zh-CN')}</span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void remove()} className="text-destructive">
              <Trash2 className="size-3.5" />
              删除
            </Button>
            <Button size="sm" onClick={onClose}>完成</Button>
          </div>
        </div>
      </aside>
    </>
  )
}

const EXTENSION_FIELDS = [
  { key: 'attackPattern' as const, label: '招式' },
  { key: 'behaviorPattern' as const, label: '行为模式' },
  { key: 'telegraph' as const, label: '前摇特征' },
  { key: 'reactionPattern' as const, label: '受击反应' },
]
