'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ImagePlus, Layers, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AxisRow } from './axis-control'
import { SourceFields } from './source-fields'
import { automaticTrainable, type LicenseKey, type Trainable } from '@/options/licensing'
import { UNCLEAR_KEY } from '@/options/shared'
import { DOMAINS, type DesignAxis, type DomainCode, type DomainDef, type EntrySummary } from '@/types/atlas'

/**
 * ⭐⭐ 采集弹窗 —— 拖进来就弹，不占常驻空间（2026-10-07）。
 *
 * ⚠️ **为什么从常驻面板改成弹窗。** 之前 QuickAdd 是一整条常驻在顶部的
 * 采集带（含度量区，默认展开）。它的问题不是功能，是**代价先于意图**：
 * 用户进页面第一眼看到的是一张要填的表，不是自己已经攒下的东西。
 * 「Atlas 首先是采集系统」这话没错，但**采集入口不该是首屏**——
 * 首屏该回答「我现在有什么」。要采的时候再叫它出来。
 *
 * ⚠️ **domain 由弹窗自己解决，而不是由外部预设。** 判据是 token 的原话：
 * 「当前正在查看的是哪个类型就弹出对应的添加弹窗，没有查看的类型是全部，
 * 就多一个选择类型的步骤」。
 *
 * 所以有两种形态，**同一段代码**：
 * · 当前筛选锁定了某个 domain → 直接进表单，域那一行只作为**可改的显示**
 * · 当前是「全部类型」→ 弹窗顶部就是选域这一步，选完才展开表单
 *
 * 这恰好是之前 `DomainGate` 的逻辑，但被搬进了弹窗内部，而不是单独一整页——
 * 因为「先选后填」只有这一次，第二次回来就该跳过。
 */

export type PendingImage = { imagePath: string; imageSource: 'paste' | 'file'; originalName: string; previewUrl: string; fetchedFrom?: string }

async function uploadImage(file: File, imageSource: 'paste' | 'file'): Promise<PendingImage> {
  const form = new FormData()
  form.append('file', file)
  form.append('imageSource', imageSource)
  const response = await fetch('/api/atlas/images', { method: 'POST', body: form })
  const body = await response.json()
  if (!response.ok || !body.success) throw new Error(body.error || '图片落盘失败')
  return { ...body.data, previewUrl: URL.createObjectURL(file) }
}

/**
 * 抓远端图。
 *
 * ⚠️ 预览不能靠 `/api/atlas/entries/pending/image` —— 那条按 entryId 取图，
 * 条目此刻还不存在，必定 404。改走 `/api/atlas/media?path=`，那是给「已落盘但
 * 还没入库」的图用的预览通道。
 */
async function uploadImageFromUrl(url: string): Promise<PendingImage> {
  const response = await fetch('/api/atlas/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const body = await response.json()
  if (!response.ok || !body.success) throw new Error(body.error || '抓图失败')
  return {
    ...body.data,
    imageSource: 'paste',
    previewUrl: `/api/atlas/media?path=${encodeURIComponent(body.data.imagePath)}`,
    fetchedFrom: body.data.fetchedFrom ?? url,
  }
}

const URL_LIKE = /^(https?:\/\/\S+)$/

/**
 * 猜域 —— 「全部类型」时给一个默认值。
 *
 * ⚠️ 这不是「默认域」，是**首选项的初值**：弹窗顶部仍然把域选择摆在明面上，
 * 选错了一键能改。偷偷给一个默认域但不显示，等于用「用户的条目进了哪个库」
 * 这种不可见的状态去污染数据。
 */
function firstDomain(): DomainDef {
  return DOMAINS[0]
}

export function CaptureModal({
  /** 当前筛选里的 domain。null = 「全部类型」，需要先选一步。 */
  scopedDomain,
  knownTags,
  onClose,
  onSaved,
}: {
  scopedDomain: DomainCode | null
  knownTags: string[]
  onClose: () => void
  onSaved: (entry: EntrySummary) => void
}) {
  /**
   * 域状态。⚠️ 初值来自筛选，但**用户可以在弹窗里改** —— 筛选是他正在
   * 「看」的范围，不必然是这条新内容该去的库（他可能正在筛「生物设计」
   * 但顺手存一条别的东西）。把两件事绑死是过度约束。
   */
  const [domain, setDomain] = useState<DomainCode | null>(scopedDomain)
  const [tab, setTab] = useState<'basic' | 'source' | 'tags' | 'axis' | 'analysis'>('basic')
  const [axisValues, setAxisValues] = useState<Partial<Record<string, number>>>({})
  const [image, setImage] = useState<PendingImage | null>(null)
  const [source, setSource] = useState('')
  const [author, setAuthor] = useState<string>(UNCLEAR_KEY)
  const [license, setLicense] = useState<LicenseKey>(UNCLEAR_KEY)
  const [trainable, setTrainable] = useState<Trainable>(UNCLEAR_KEY)
  const [name, setName] = useState('')
  const [observed, setObserved] = useState('')
  const [read, setRead] = useState('')
  const [worthwhileBecause, setWorthwhileBecause] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagConfidence, setTagConfidence] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragDepth, setDragDepth] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  const [axes, setAxes] = useState<DesignAxis[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch('/api/atlas/spaces?axesOf=space-mine')
      const body = await response.json()
      if (!cancelled && response.ok && body.success) setAxes(body.data)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const axisGroups = useMemo(() => {
    const grouped = new Map<string, DesignAxis[]>()
    for (const axis of axes) {
      const key = axis.group.labelZh || ''
      const list = grouped.get(key) ?? []
      list.push(axis)
      grouped.set(key, list)
    }
    return [...grouped.entries()]
  }, [axes])

  const activeDomain = domain ? DOMAINS.find((item) => item.code === domain) ?? null : null

  const clear = useCallback(() => {
    if (image?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl)
    setImage(null)
    setSource('')
    setAuthor(UNCLEAR_KEY)
    setLicense(UNCLEAR_KEY)
    setTrainable(UNCLEAR_KEY)
    setName('')
    setObserved('')
    setRead('')
    setWorthwhileBecause('')
    setTab('basic')
    setTagInput('')
    setTags([])
    setTagConfidence({})
    setAxisValues({})
    setError('')
  }, [image])

  const handleFiles = async (files: FileList | File[]) => {
    const file = Array.from(files).find((item) => item.type.startsWith('image/'))
    if (!file) return
    setUploading(true)
    setError('')
    try {
      setImage(await uploadImage(file, 'file'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片落盘失败')
    } finally {
      setUploading(false)
    }
  }

  const handleUrl = async (raw: string) => {
    const url = raw.trim()
    if (!URL_LIKE.test(url)) return setError('拖进来的既不是图片也不是 http(s) 链接 —— 试试直接拖图片文件，或拖图片地址')
    setUploading(true)
    setError('')
    try {
      setImage(await uploadImageFromUrl(url))
      setSource((current) => current || url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '抓图失败')
    } finally {
      setUploading(false)
    }
  }

  /**
   * ⚠️ **必须同时读 files 和文本。** 从浏览器标签页/地址栏拖过来的是纯文本，
   * `dataTransfer.files` 是空的 —— 只读 files 会让这类拖放**静默无反应**。
   * uri-list 是浏览器拖链接时的标准格式；text/plain 覆盖从纯文本编辑器拖来的。
   */
  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDragDepth(0)
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.some((item) => item.type.startsWith('image/'))) return void (await handleFiles(files))
    const uriList = event.dataTransfer.getData('text/uri-list')
    const plain = event.dataTransfer.getData('text/plain')
    const candidate = (uriList || plain).split('\n').map((line) => line.trim()).find((line) => URL_LIKE.test(line))
    if (candidate) return void (await handleUrl(candidate))
    if (files.length > 0) setError('拖进来的文件不是图片')
  }

  const commitTag = (raw: string) => {
    const cleaned = raw.trim().replace(/^#/, '').replace(/\s+/g, ' ')
    if (!cleaned) return
    if (tags.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
      setTagInput('')
      return
    }
    setTags([...tags, cleaned.slice(0, 40)])
    setTagConfidence((current) => ({ ...current, [cleaned.slice(0, 40)]: 100 }))
    setTagInput('')
  }

  const suggestions = knownTags
    .filter((tag) => tagInput.trim() && tag.toLowerCase().includes(tagInput.trim().toLowerCase()) && !tags.includes(tag))
    .slice(0, 6)

  const submit = async () => {
    if (!domain) return setError('先选一个库')
    const finalSource = source.trim()
    if (!finalSource) { setTab('source'); return setError('需要填写来源（网址或出版物）') }
    const finalTags = [...tags]
    const pendingTag = tagInput.trim().replace(/^#/, '').replace(/\s+/g, ' ').slice(0, 40)
    if (pendingTag && !finalTags.some((tag) => tag.toLowerCase() === pendingTag.toLowerCase())) finalTags.push(pendingTag)
    const invalidConfidence = Object.entries(tagConfidence).find(([, value]) => !Number.isFinite(value) || value < 0 || value > 100)
    if (invalidConfidence) { setTab('tags'); return setError('标签置信度请输入 0–100') }

    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/atlas/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain,
          name: name.trim(),
          source: finalSource,
          author: author.trim() || UNCLEAR_KEY,
          license,
          trainable,
          imagePath: image?.imagePath ?? '',
          imageSource: image?.imageSource ?? 'file',
          originalName: image?.originalName ?? '',
          status: 'pending_ai',
          tagNames: finalTags,
          tagConfidenceByName: Object.fromEntries(finalTags.map((tag) => [tag, (tagConfidence[tag] ?? 100) / 100])),
          axisValues,
          axisSpaceId: 'space-mine',
          observed: observed.trim(),
          read: read.trim(),
          worthwhileBecause: worthwhileBecause.trim(),
        }),
      })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || '保存失败')
      onSaved(body.data)
      clear()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const paste = async (event: React.ClipboardEvent) => {
    const items = Array.from(event.clipboardData?.items ?? [])
    const item = items.find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'))
    if (item) {
      event.preventDefault()
      const file = item.getAsFile()
      if (file) await handleFiles([file])
      return
    }
    const text = event.clipboardData?.getData('text')?.trim()
    if (text && URL_LIKE.test(text)) {
      event.preventDefault()
      setSource(text)
    }
  }

  /** 还在选域那一屏时，回车 = 选第一个库。少一次鼠标。 */
  useEffect(() => {
    if (domain) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        setDomain(firstDomain().code)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [domain])

  const modalDrag = (event: React.DragEvent, over: boolean) => {
    event.preventDefault()
    event.stopPropagation()
    // ⚠️ dragenter/dragleave 在**层级里每穿过一个子元素就触发一对**，
    // 直接 setState(布尔) 会闪。用深度计数：只有归零才算离开。
    setDragDepth((depth) => (over ? depth + 1 : depth - 1))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-10"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="添加一条"
        onClick={(event) => event.stopPropagation()}
        onPaste={paste}
        onDragEnter={(event) => modalDrag(event, true)}
        onDragOver={(event) => modalDrag(event, true)}
        onDragLeave={(event) => modalDrag(event, false)}
        onDrop={(event) => void handleDrop(event)}
        className={cn(
          'relative my-auto w-full max-w-3xl rounded-xl border bg-background shadow-2xl transition-colors',
          dragDepth > 0 && 'border-primary ring-2 ring-primary/20',
        )}
      >
        {dragDepth > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl bg-background/85">
            <p className="text-sm font-medium">松手就存 —— 图片文件或图片链接都行</p>
          </div>
        )}

        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Layers className="size-3.5 text-muted-foreground" />
          {domain ? (
            <button
              type="button"
              onClick={() => setDomain(null)}
              className="group inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-sm font-semibold hover:bg-accent"
              title="换个库"
            >
              {activeDomain?.labelZh}
              <span className="text-[11px] font-normal text-muted-foreground">{activeDomain?.labelEn}</span>
              <span className="text-[10px] font-normal text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">换</span>
            </button>
          ) : (
            <span className="text-sm font-semibold text-muted-foreground">选一个库</span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">Esc 关闭 · 粘图 / 拖入</span>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-accent" aria-label="关闭">
            <X className="size-4" />
          </button>
        </div>

        {/* ⚠️ 「全部类型」时这一屏是**必过的一步**，不是可跳过的装饰：
            它决定条目进哪个库，而库是采集里唯一不可事后推断的东西。 */}
        {!domain && (
          <div className="p-4">
            <p className="text-xs text-muted-foreground">
              现在在看全部类型，先说这条要进哪个库 —— 一个 domain 研究一种创作问题。
            </p>
            <div className="mt-3 space-y-1.5">
              {DOMAINS.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => setDomain(item.code)}
                  className="flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:border-foreground/40 hover:bg-accent/40"
                >
                  <Layers className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {item.labelZh} <span className="text-xs font-normal text-muted-foreground">{item.labelEn}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-foreground/80">研究{item.creativeQuestion}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{item.hintZh}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">回车直接选第一个。</p>
          </div>
        )}

        {domain && (
          <div className="space-y-3 p-4">
            <div className="flex gap-1 overflow-x-auto border-b pb-2" role="tablist" aria-label="新建条目">
              {([{ id: 'basic', label: '基本信息' }, { id: 'source', label: '来源' }, { id: 'tags', label: 'Tags' }, { id: 'axis', label: 'Axis' }, { id: 'analysis', label: 'Design Analysis' }] as const).map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}
                  className={cn('shrink-0 rounded-md px-2 py-1 text-xs', tab === item.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}>
                  {item.label}
                </button>
              ))}
            </div>
            <section role="tabpanel" hidden={tab !== 'basic'} className="space-y-3">
            <div className="flex gap-4">
              <div className="relative grid h-32 w-32 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
                {uploading ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : image ? (
                  // 预览有两种来源：本地文件给的是 blob: URL，拖链接给的是
                  // /api/atlas/media?path= —— 两者都要显示图。
                  image.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={image.previewUrl} alt="" className="size-full object-contain" />
                  ) : (
                    <ImagePlus className="size-5 text-muted-foreground" />
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="flex flex-col items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <ImagePlus className="size-5" />
                    <span className="text-[10px]">粘图 / 拖入</span>
                  </button>
                )}
                {image && (
                  <button type="button" onClick={() => setImage(null)} className="absolute right-1.5 top-1.5 rounded-full bg-background/80 p-1 hover:bg-background" title="清除">
                    <X className="size-3" />
                  </button>
                )}
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <Input aria-label="名字（可空）" placeholder="名字（可空，事后补）" value={name} onChange={(event) => setName(event.target.value)} className="h-8 text-xs" />
              </div>
            </div>
            </section>

            <section role="tabpanel" hidden={tab !== 'source'}>
              <SourceFields source={source} author={author} license={license} trainable={trainable}
                onSourceChange={setSource}
                onAuthorChange={setAuthor}
                onLicenseChange={(value) => { setLicense(value); setTrainable(automaticTrainable(value)) }}
                onTrainableChange={setTrainable} />
            </section>

            <section role="tabpanel" hidden={tab !== 'tags'}>
              <div className="space-y-2">
                <p className="text-xs font-semibold">标签 <span className="font-normal text-muted-foreground">关联置信度按百分比编辑</span></p>
                <div className="space-y-2">
                  {tags.map((tag) => (
                    <div key={tag} className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-xs">
                      <span className="min-w-0 flex-1 truncate">{tag}</span>
                      <label className="flex items-center gap-1 text-muted-foreground">
                        <span className="sr-only">{tag} 置信度</span>
                        <input type="number" min="0" max="100" step="1" value={tagConfidence[tag] ?? 100}
                          onChange={(event) => setTagConfidence((current) => ({ ...current, [tag]: Number(event.target.value) }))}
                          aria-label={`${tag} 置信度百分比`}
                          className="h-7 w-14 rounded border bg-background px-1 text-right text-xs text-foreground" />%
                      </label>
                      <button type="button" aria-label={`移除 ${tag}`} onClick={() => { setTags(tags.filter((item) => item !== tag)); setTagConfidence((current) => { const next = { ...current }; delete next[tag]; return next }) }} className="text-muted-foreground hover:text-foreground">
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    ref={tagInputRef}
                    aria-label="加标签"
                    placeholder={tags.length === 0 ? '标签（可空，回头补）' : '再加一个…'}
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    onBlur={() => commitTag(tagInput)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        commitTag(tagInput)
                      }
                      if (event.key === 'Backspace' && !tagInput && tags.length > 0) setTags(tags.slice(0, -1))
                    }}
                    className="h-8 flex-1 text-xs"
                  />
                  {tagInput.trim() && <Button size="xs" onClick={() => commitTag(tagInput)}>加上</Button>}
                </div>

                {suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {suggestions.map((tag) => (
                      <button key={tag} type="button" onClick={() => commitTag(tag)} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent">
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section role="tabpanel" hidden={tab !== 'axis'}>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {axisGroups.map(([groupKey, groupAxes]) => (
                  <div key={groupKey || 'ungrouped'} className="rounded-md border bg-muted/30 px-3 py-2">
                    <p className="text-sm font-semibold text-foreground">
                      {groupKey || '未分组'}
                    </p>
                    <div className="divide-y">
                      {groupAxes.map((axis) => (
                        <AxisRow
                          key={axis.key}
                          dimension={axis}
                          value={axisValues[axis.key]}
                          onChange={(score) => setAxisValues((current) => ({ ...current, [axis.key]: score }))}
                          onClear={() =>
                            setAxisValues((current) => {
                              const next = { ...current }
                              delete next[axis.key]
                              return next
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {axisGroups.length === 0 && (
                  <p className="py-2 text-center text-[11px] text-muted-foreground">
                    「我的设计空间」还没有坐标轴 —— 跳过这里，事后在详情里补。
                  </p>
                )}
              </div>
            </section>

            <section role="tabpanel" hidden={tab !== 'analysis'} className="space-y-3">
              <label className="block text-xs font-medium">观察 · 我看到了什么（客观）<Textarea value={observed} onChange={(event) => setObserved(event.target.value)} className="mt-1" /></label>
              <label className="block text-xs font-medium">判断 · 我认为它为什么成立（主观）<Textarea value={read} onChange={(event) => setRead(event.target.value)} className="mt-1" /></label>
              <label className="block text-xs font-medium">目的 · 我为什么留着它<Textarea value={worthwhileBecause} onChange={(event) => setWorthwhileBecause(event.target.value)} className="mt-1" /></label>
            </section>

            {error && (
              <p className="rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error} —— 来源是唯一必填项，其余都能事后补。
              </p>
            )}

            <div className="flex items-center gap-2">
              <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(event) => event.target.files && void handleFiles(event.target.files)} />
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                选文件
              </Button>
              <p className="text-[11px] text-muted-foreground">存完不关窗口，可以连续录</p>
              <Button size="sm" className="ml-auto" onClick={() => void submit()} disabled={busy || uploading}>
                {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Check className="mr-1 size-3.5" />}
                存
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
