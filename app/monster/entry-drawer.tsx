'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { STATUS_LABEL, type EntryStatus, type EntrySummary } from '@/types/atlas'

/**
 * Detail 抽屉 —— 点卡片后从右侧滑出。
 *
 * ⚠️ 刻意做成「改完立刻生效、随开随存」，不设保存按钮。
 * 采集系统里每多一个「记得点保存」的步骤，就多一次数据丢失的机会。
 * 代价是打错字会立刻生效 —— 对单人来说这个交易划算。
 */
export function EntryDrawer({ entry, onClose, onChange, onDeleted }: {
  entry: EntrySummary
  onClose: () => void
  onChange: (next: EntrySummary) => void
  onDeleted: (id: string) => void
}) {
  const [draft, setDraft] = useState(entry)
  const [tagDraft, setTagDraft] = useState('')
  const [error, setError] = useState('')

  useEffect(() => setDraft(entry), [entry.id, entry.updatedAt])

  /**
   * 追加标签。
   *
   * ⚠️ 传全量 tagNames：updateEntry → attachEntryTagsByName 走的是**合并**语义
   * （只加不摘），所以传全量与传增量结果一样 —— 但传全量是显式的，将来若改成
   * 替换语义这里也不会突然丢掉原有标签。
   */
  const addTags = async () => {
    const incoming = tagDraft
      .split(/[,，\s]+/)
      .map((item) => item.replace(/^#/, '').trim())
      .filter(Boolean)
    if (incoming.length === 0) return
    const merged = [...new Set([...draft.tags.map((tag) => tag.name), ...incoming])]
    setTagDraft('')
    await patch({ tagNames: merged })
  }

  const patch = async (changes: Partial<EntrySummary> & { tagNames?: string[] }) => {
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

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-background shadow-2xl">
        <div className="aspect-square shrink-0 bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/atlas/entries/${entry.id}/image`} alt={entry.name} className="size-full object-contain" />
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{STATUS_LABEL[entry.status]}</p>
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
              <Input aria-label="来源游戏" placeholder="来源游戏" value={draft.sourceGame} onChange={(event) => setDraft({ ...draft, sourceGame: event.target.value })} onBlur={() => draft.sourceGame !== entry.sourceGame && void patch({ sourceGame: draft.sourceGame })} className="h-8 w-32 text-xs" />
            </div>
            <a href={draft.sourceUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ExternalLink className="size-3" />
              打开来源
            </a>
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">标签</h3>
            <div className="flex flex-wrap items-center gap-1">
              {draft.tags.map((tag) => (
                <span key={tag.id} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                  {tag.name}
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
            {/* ⚠️ 就地加签是「未打标」视图的配套：欠账摊开在这里补，
                不该要求用户先回Quick Add 重录一遍。没有它，欠就永远欠着。 */}
            <div className="mt-2 flex gap-2">
              <Input
                aria-label="加标签"
                placeholder={draft.tags.length === 0 ? '没打标 —— 在这里补，或直接关掉' : '再加一个标签…'}
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

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">笔记</h3>
            <Textarea
              aria-label="笔记"
              rows={6}
              placeholder="想到什么就写什么。死后爆炸 / 前摇很明显 / 会绕后 —— 这些先写在这儿，攒够 100 条再决定要不要变成字段"
              value={draft.notes}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
              onBlur={() => draft.notes !== entry.notes && void patch({ notes: draft.notes })}
              className="text-xs"
            />
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
              Monster 设计 · <span className="font-normal">全部可空，不填也不影响</span>
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label="体型" placeholder="bodyType" value={draft.bodyType} onChange={(event) => setDraft({ ...draft, bodyType: event.target.value })} onBlur={() => draft.bodyType !== entry.bodyType && void patch({ bodyType: draft.bodyType })} className="h-8 text-xs" />
              <Input aria-label="尺寸" placeholder="scale" value={draft.scale} onChange={(event) => setDraft({ ...draft, scale: event.target.value })} onBlur={() => draft.scale !== entry.scale && void patch({ scale: draft.scale })} className="h-8 text-xs" />
            </div>
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