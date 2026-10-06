'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { EntrySummary } from '@/types/atlas'

/**
 * Quick Add —— v0 最重要的一个界面。
 *
 * 设计目标只有一个：**从看到参考到存进去不超过 30 秒**。
 *
 * 具体取舍：
 * - 名字可以空。空名字在 Gallery 里显示图片文件名对应的 sourceTitle 第一段，
 *   事后在 drawer 里补。强制填名字会让「先存下来再说」变成「先想好再说」。
 * - 来源链接用一次粘贴完成（浏览器剪贴板里的 URL），不要求用户手动选中复制。
 *   用户真正的动作是「复制图片地址」——那已经在剪贴板里了。
 * - tag 输入框自动聚焦。整条链路是：Cmd+V 粘图 → 打字打 tag → Enter。
 * - 存完不清空输入框形状，只清空内容并重新聚焦 —— 上一条和下一条往往是同一批参考。
 */

type PendingImage = { imagePath: string; imageSource: 'paste' | 'file'; originalName: string; previewUrl: string; fetchedFrom?: string }

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
 * 条目此刻还不存在，必定404。改走 `/api/atlas/media?path=`，那是给「已落盘但
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

const URL_IN_CLIPBOARD = /^(https?:\/\/\S+)$/

export function QuickAdd({
  knownTags,
  onSaved,
}: {
  knownTags: string[]
  onSaved: (entry: EntrySummary) => void
}) {
  const [image, setImage] = useState<PendingImage | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [name, setName] = useState('')
  const [sourceGame, setSourceGame] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  const reset = useCallback(() => {
    if (image?.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl)
    setImage(null)
    setSourceUrl('')
    setName('')
    setSourceGame('')
    setTagInput('')
    setTags([])
    setError('')
  }, [image])

  /** 收到剪贴板里的图片或 URL 时自动落盘。这是最高频的入口，所以挂在全局。 */
  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      const items = event.clipboardData?.items ?? []
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          event.preventDefault()
          const file = item.getAsFile()
          if (!file) return
          setUploading(true)
          setError('')
          try {
            setImage(await uploadImage(file, 'paste'))
            setSourceUrl((current) => current || window.location.href)
            tagInputRef.current?.focus()
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '图片落盘失败')
          } finally {
            setUploading(false)
          }
          return
        }
      }
      const text = event.clipboardData?.getData('text')?.trim()
      if (text && URL_IN_CLIPBOARD.test(text)) {
        setSourceUrl(text)
        if (!image) tagInputRef.current?.focus()
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [image])

  const handleFiles = async (files: FileList | File[]) => {
    const file = Array.from(files).find((item) => item.type.startsWith('image/'))
    if (!file) return
    setUploading(true)
    setError('')
    try {
      setImage(await uploadImage(file, 'file'))
      if (!sourceUrl) setSourceUrl(window.location.href)
      tagInputRef.current?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片落盘失败')
    } finally {
      setUploading(false)
    }
  }

  /**
   * 拖进来的是 URL 时走这条：服务端抓图落盘，然后把 URL 同时填进来源。
   *
   * ⚠️ 来源自动填是故意的：从浏览器地址栏拖过来的那个 URL 本身就是出处，
   * 让用户再手动敲一遍是纯摩擦。「拖 URL = 图 + 来源一次到手」。
   */
  const handleUrl = async (raw: string) => {
    const url = raw.trim()
    if (!URL_IN_CLIPBOARD.test(url)) {
      return setError('拖进来的既不是图片也不是 http(s) 链接 —— 试试直接拖图片文件，或拖图片地址')
    }
    setUploading(true)
    setError('')
    try {
      const saved = await uploadImageFromUrl(url)
      setImage(saved)
      setSourceUrl((current) => current || url)
      tagInputRef.current?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '抓图失败')
    } finally {
      setUploading(false)
    }
  }

  /**
   * 拖放入口。
   *
   * ⚠️ **必须同时读 files 和文本**。从浏览器标签页/地址栏拖过来的是纯文本，
   * `dataTransfer.files` 是空的 —— 只读 files 会让这类拖放**静默无反应**，
   * 用户完全看不出发生了什么（2026-10-06 踩到：拖 URL 拖不进去，
   * 必须先存到桌面再拖文件）。
   *
   * 另外从别的应用拖图（比如 Finder、Figma）时 files 里有；从 Chrome 拖链接
   * 时 files 空、text/plain 里有 URL。两条路都得接。
   */
  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.some((item) => item.type.startsWith('image/'))) {
      await handleFiles(files)
      return
    }
    // uri-list 是浏览器拖链接时的标准格式；text/plain 是从纯文本编辑器拖过来的。
    const uriList = event.dataTransfer.getData('text/uri-list')
    const plain = event.dataTransfer.getData('text/plain')
    const candidate = (uriList || plain).split('\n').map((line) => line.trim()).find((line) => URL_IN_CLIPBOARD.test(line))
    if (candidate) {
      await handleUrl(candidate)
      return
    }
    if (files.length > 0) return setError('拖进来的文件不是图片')
  }

  const commitTag = (raw: string) => {
    const cleaned = raw.trim().replace(/^#/, '').replace(/\s+/g, ' ')
    if (!cleaned) return
    if (tags.some((item) => item.toLowerCase() === cleaned.toLowerCase())) {
      setTagInput('')
      return
    }
    setTags([...tags, cleaned.slice(0, 40)])
    setTagInput('')
  }

  const suggestions = knownTags
    .filter((tag) => tagInput.trim() && tag.toLowerCase().includes(tagInput.trim().toLowerCase()) && !tags.includes(tag))
    .slice(0, 6)

  const submit = async () => {
    if (!image) return setError('还没有图片 —— 粘贴截图、拖文件进来，或选一个文件')
    const url = sourceUrl.trim()
    if (!url) return setError('需要来源链接 —— 没有出处的东西不进 Atlas')
    // ⚠️ tags 不强制（2026-10-06 裁定）。空标签照样能存 —— 欠账用侧栏
    // 的「未打标」视图去补，不在采集入口拦。拦在这里等于逼人「先想好再存」。
    const finalTags = [...tags]
    if (tagInput.trim()) finalTags.push(...[tagInput.trim()])

    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/atlas/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          sourceUrl: url,
          sourceGame: sourceGame.trim(),
          sourceTitle: document.title,
          imagePath: image.imagePath,
          imageSource: image.imageSource,
          originalName: image.originalName,
          status: 'inbox',
          tagNames: finalTags,
        }),
      })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || '保存失败')
      onSaved(body.data)
      reset()
      tagInputRef.current?.focus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

return (
    <section
      className={cn('relative rounded-xl border-2 border-dashed transition-colors', dragging ? 'border-primary bg-accent/40' : 'border-border')}
      onDragOver={(event) => {
event.preventDefault()
     setDragging(true)
   }}
      onDragLeave={() => setDragging(false)}
onDrop={(event) => void handleDrop(event)}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl bg-background/80">
          <p className="text-sm font-medium">松手就抓 —— 图片文件或图片链接都行</p>
        </div>
      )}
      <div className="flex gap-4 p-4">
        <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {uploading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : image ? (
            // 预览有两种来源：本地文件给的是 blob: URL，拖链接给的是 /api/atlas/media?path=
            // 两者都要显示图 —— 之前只认 blob，拖链接进来的图会一直显示占位图标，
            // 让人以为没抓成功。
            image.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image.previewUrl} alt="" className="size-full object-contain" />
            ) : (
              <ImagePlus className="size-5 text-muted-foreground" />
            )
          ) : (
            <button type="button" onClick={() => fileInput.current?.click()} className="flex flex-col items-center gap-1 text-muted-foreground hover:text-foreground">
              <ImagePlus className="size-5" />
              <span className="text-[10px]">粘图 / 拖入</span>
            </button>
          )}
          {image && (
            <button type="button" onClick={reset} className="absolute right-2 top-2 rounded-full bg-background/80 p-1 hover:bg-background" title="清除">
              <X className="size-3" />
            </button>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <Input
            aria-label="来源链接"
            placeholder="来源链接（粘贴即可，自动识别）"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex gap-2">
            <Input aria-label="名字（可空）" placeholder="名字（可空，事后补）" value={name} onChange={(event) => setName(event.target.value)} className="h-8 text-xs" />
            <Input aria-label="来源游戏（可空）" placeholder="来源（可空）" value={sourceGame} onChange={(event) => setSourceGame(event.target.value)} className="h-8 w-32 text-xs" />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {tags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                {tag}
                <button type="button" onClick={() => setTags(tags.filter((item) => item !== tag))} className="text-muted-foreground hover:text-foreground">
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
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
              className="h-7 w-44 text-xs"
            />
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

        <div className="flex flex-col justify-between">
          <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(event) => event.target.files && void handleFiles(event.target.files)} />
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
            选文件
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || uploading}>
            {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Check className="mr-1 size-3.5" />}
            存
          </Button>
        </div>
      </div>

      {error && (
        <p className="border-t bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error} —— 图片来源在上方（可粘贴），标签在下方。两者齐了就能存。
        </p>
      )}
    </section>
  )
}