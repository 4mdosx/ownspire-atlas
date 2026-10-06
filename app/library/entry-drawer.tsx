'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { TaxonomyRow } from './taxonomy-stars'
import { dimensionsInGroup, dimensionsOf, domainOf, groupsOf, STATUS_LABEL, TAG_GROUP_HINT, TAG_GROUP_KEYS, TAG_GROUP_LABEL, type DomainCode, type EntryDetail, type EntryStatus, type TaxonomyDimensionKey } from '@/types/atlas'

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
  /** 正在打开归类选择器的 tag id。null = 没打开。 */
  const [grouping, setGrouping] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => setDraft(entry), [entry.id, entry.updatedAt])

  const patch = async (changes: Record<string, unknown>) => {
    setError('')
    const response = await fetch(`/api/atlas/entries/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
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

  /**
   * 改 tag 的归类。
   *
   * ⚠️ 归类挂在 **tag 实体**上，不是这条关联上 —— 所以改一次全局生效，
   * 同名 tag 在别的条目上也会跟着变组。这是对的：「jumper 属于行为原型」
   * 是这个词的性质，不是「这条记录里 jumper 的性质」。
   *
   * 所以**不用走 /api/atlas/entries/:id**（那是改这条记录的），
   * 直接打tags 端点，然后本地同步 —— 别的条目下次刷新时自然带上新组。
   */
  const regroup = async (tagId: string, group: string) => {
    const tag = draft.tags.find((item) => item.id === tagId)
    if (!tag) return
    const response = await fetch('/api/atlas/tags', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tag.name, group }),
    })
    const body = await response.json()
    if (!response.ok || !body.success) {
      setGrouping(null)
      return setError(body.error || '改归类失败')
    }
    setDraft({ ...draft, tags: draft.tags.map((item) => (item.id === tagId ? { ...item, group: body.data.group } : item)) })
    setGrouping(null)
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
  const dimensions = dimensionsOf(draft.domain)
  const userTags = draft.tags.filter((tag) => tag.origin === 'user')
  const systemTags = draft.tags.filter((tag) => tag.origin === 'system')

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      {/* ⚠️ 宽度不是随手定的：6 个档位词 + 5 颗星 + 数字框 + 清除按钮并排
          需要 560px 以上，max-w-md（448）会把它们挤到换行甚至出视口。
          图片区给 max-h 而不是 aspect-square —— 正方形的大图会把下方
          所有可编辑内容顶出屏幕。 */}
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background shadow-2xl">
        <div className="max-h-[38vh] shrink-0 overflow-hidden bg-muted">
          {entry.imagePath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/atlas/entries/${entry.id}/image`} alt={entry.name} className="mx-auto max-h-[38vh] w-auto object-contain" />
          ) : (
            <span className="grid size-full place-items-center text-xs text-muted-foreground">这条没有图片</span>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {domain ? `${domain.labelZh} · ` : ''}{STATUS_LABEL[entry.status]}
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

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">来源</h3>
            <Input
              aria-label="来源链接"
              value={draft.sourceUrl}
              onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })}
              onBlur={() => draft.sourceUrl !== entry.sourceUrl && void patch({ sourceUrl: draft.sourceUrl })}
              className="h-8 text-xs"
            />
            <div className="mt-2 flex gap-2">
              <Input aria-label="来源标题" placeholder="来源标题" value={draft.sourceTitle} onChange={(event) => setDraft({ ...draft, sourceTitle: event.target.value })} onBlur={() => draft.sourceTitle !== entry.sourceTitle && void patch({ sourceTitle: draft.sourceTitle })} className="h-8 text-xs" />
              <Input aria-label="来源游戏" placeholder="来源" value={draft.sourceGame} onChange={(event) => setDraft({ ...draft, sourceGame: event.target.value })} onBlur={() => draft.sourceGame !== entry.sourceGame && void patch({ sourceGame: draft.sourceGame })} className="h-8 w-32 text-xs" />
            </div>
            <a href={draft.sourceUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ExternalLink className="size-3" />
              打开来源
            </a>
          </section>

          {/* ⭐ taxonomy —— 连续打分，与 tag 无关。维度由 domain 决定，
              按 group 分块：形态 / 战斗。分组是为了让「哪几个轴在问同一件事」
              一眼可见，不是为了好看。 */}
          {dimensions.length > 0 && (
            <section>
              {/*
                ⭐⭐ 标题从「度量」改成「我的设计空间」—— 这不是文案调整，
                是语义纠正（2026-10-06）。

                原来的读法是「这个怪有多大的体量」，那是在记录**它的属性**——
                照搬原游戏的坐标系，做出来就是 wiki。而这里记的是
                **「在我的设计语言里，我把它放在哪」**：Reference 是输入，
                坐标是我的解读。

                差别的实际后果：半年后把 0.70 改成 0.55，若按「属性」读就只能
                理解成「之前记错了」；按「我的判断」读，它是「我对怪物设计的
                理解变了」—— 不是错误，是成长。后一种读法才敢改分。
              */}
              <h3 className="mb-0.5 text-xs font-semibold">
                我的设计空间
                <span className="ml-1.5 font-normal text-muted-foreground">
                  不是我设计它多强，是我认为它在哪
                </span>
              </h3>
              <p className="mb-1 text-[10px] text-muted-foreground">
                点档位词直接定档，星星微调。全灰 = 还没想好（不等于 0 分），数字框可填到 0.01。
                <span className="ml-1">改分随时可以 —— 那是判断变了，不是记错了。</span>
              </p>
              {groupsOf(draft.domain).map((group) => {
                const groupDimensions = dimensionsInGroup(draft.domain, group.key)
                if (groupDimensions.length === 0) return null
                return (
                  <div key={group.key} className="mt-2 rounded-md border px-3 pb-1 pt-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {group.labelZh} <span className="font-normal normal-case tracking-normal">{group.labelEn}</span>
                      <span className="ml-1.5 font-normal normal-case tracking-normal">{group.hintZh}</span>
                    </p>
                    <div className="divide-y">
                      {groupDimensions.map((dimension) => (
                        <TaxonomyRow
                          key={dimension.key}
                          dimension={dimension}
                          value={draft.taxonomy[dimension.key]}
                          onChange={(score) => {
                            const next = { ...draft.taxonomy, [dimension.key]: score }
                            setDraft({ ...draft, taxonomy: next })
                            void patch({ taxonomy: { [dimension.key]: score } })
                          }}
                          onClear={() => {
                            const next = { ...draft.taxonomy }
                            delete next[dimension.key as TaxonomyDimensionKey]
                            setDraft({ ...draft, taxonomy: next })
                            void patch({ clearDimension: dimension.key })
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </section>
          )}

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
              标签
              <span className="ml-1.5 font-normal">
                {userTags.length > 0 ? '点名字能改归类' : '自由输入，归类可跳过'}
              </span>
            </h3>
            <div className="flex flex-wrap items-center gap-1">
              {userTags.map((tag) => (
                <span key={tag.id} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                  {/*
                    ⭐ 点名字 → 打开归类选择。
                    ⚠️ 加了 group 字段却没有改它的入口，等于只做了一半 ——
                    那时归类只能用代码改，而半年后没人记得哪个词属于哪组，
                    分组筛选就成了摆设。
                  */}
                  <button
                    type="button"
                    onClick={() => setGrouping(tag.id)}
                    title={tag.group ? `${TAG_GROUP_LABEL[tag.group]} · 点一下改归类` : '还没归类 · 点一下归类'}
                    className="hover:text-foreground"
                  >
                    {tag.name}
                  </button>
                  <button
                    type="button"
                    title="摘掉这个标签"
                    onClick={async () => {
                      const response = await fetch(`/api/atlas/entries/${entry.id}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ detachTagId: tag.id }),
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
                </span>
              ))}
            </div>

            {/* 归类选择：分组下拉。用原生 select 而不是自建菜单 —— 选项只有 7 个，
                自建菜单要处理键盘导航与焦点管理，成本远大于收益。 */}
            {grouping && (
              <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
                <span className="text-[11px] text-muted-foreground">
                  {draft.tags.find((tag) => tag.id === grouping)?.name} 属于：
                </span>
                <select
                  autoFocus
                  aria-label="tag 归类"
                  value={draft.tags.find((tag) => tag.id === grouping)?.group ?? ''}
                  onChange={(event) => void regroup(grouping, event.target.value)}
                  onBlur={() => setGrouping(null)}
                  className="h-6 rounded border bg-background px-1 text-[11px] outline-none"
                >
                  {/* ⚠️ 空串选项 = 取消归类。必须留着 —— 归类是可选的，
                      误归类之后要能退回去。 */}
                  <option value="">未归类</option>
                  {TAG_GROUP_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {TAG_GROUP_LABEL[key]}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-muted-foreground">
                  {/* ⚠️ 空串（未归类）没有 HINT 条目 —— 直接索引会拿到 undefined。 */}
                  {TAG_GROUP_HINT[draft.tags.find((tag) => tag.id === grouping)?.group || 'taxonomy']}
                </span>
              </div>
            )}
            {/* ⚠️ 系统 tag 单独一块，不可摘 —— 它们是系统按规则挂的，
                用户摘掉等于把「这条属于哪个项目」的标记抹了。要改走 ruleId。 */}
            {systemTags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {systemTags.map((tag) => (
                  <span key={tag.id} title={`系统 tag · 规则 ${tag.ruleId}`} className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">
                    ⚙ {tag.name}
                  </span>
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

          {draft.extension && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
                怪物设计 · <span className="font-normal">taxonomy 表达不了的才放这里</span>
              </h3>
              <div className="space-y-2">
                {EXTENSION_FIELDS.map((field) => (
                  <Textarea
                    key={field.key}
                    aria-label={field.label}
                    rows={2}
                    placeholder={`${field.label} · 每行一条`}
                    value={draft.extension![field.key].join('\n')}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        extension: { ...draft.extension!, [field.key]: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) },
                      })
                    }
                    onBlur={() => void patch({ extension: { ...draft.extension!, [field.key]: draft.extension![field.key] } })}
                    className="text-xs"
                  />
                ))}
              </div>
            </section>
          )}

          {/*
            ⭐⭐「我为什么留着它」放在观察与判断**之前**，而且样式更重。
            这一句才是 Creative Atlas 区别于收藏夹与 wiki 的地方：前两者存
            「这是什么」，这里存「这值得我留着的理由是什么」。

            位置是刻意的：它是每条记录半年后最值钱的一句，应该在滚动时
            第一个撞进眼睛，而不是排在最后当补充说明。
          */}
          <section className="rounded-md border-2 border-foreground/15 bg-accent/30 p-3">
            <h3 className="mb-1 text-xs font-semibold">
              我为什么留着它
              <span className="ml-1.5 font-normal text-muted-foreground">半年后回看，这句最值钱</span>
            </h3>
            <Textarea
              aria-label="值得存的原因"
              rows={3}
              placeholder="它身上有什么东西值得我停下来看？&#10;「非常简单地用蓄力→冲刺建立了一种高 commitment / 高 readability 的攻击」"
              value={draft.worthwhileBecause}
              onChange={(event) => setDraft({ ...draft, worthwhileBecause: event.target.value })}
              onBlur={() => draft.worthwhileBecause !== entry.worthwhileBecause && void patch({ worthwhileBecause: draft.worthwhileBecause })}
              className="text-xs"
            />
          </section>

          {/*
            ⭐ 观察与判断严格分区（2026-10-06）。
            分开不是洁癖：混在一个字段里，半年后无法分辨哪句是原作事实、
            哪句是我的解读 —— 而混在一起的判断等于没有判断（不敢改，
            因为改了对= 承认之前在编）。
          */}
          <section>
            <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
              观察 <span className="font-normal">· 我看到了什么（客观）</span>
            </h3>
            <Textarea
              aria-label="观察"
              rows={5}
              placeholder="攻击前身体膨胀约 0.5 秒&#10;轮廓是圆形菌盖，占据大部分视觉&#10;移动方式是周期性跳跃"
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
              placeholder="用 silhouette 变化给玩家 telegraph&#10;移动方式本身就是角色性格"
              value={draft.read}
              onChange={(event) => setDraft({ ...draft, read: event.target.value })}
              onBlur={() => draft.read !== entry.read && void patch({ read: draft.read })}
              className="text-xs"
            />
          </section>

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