'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { AtlasSidebar, EMPTY_FILTER, FilterBar, type AtlasFilter } from './atlas-filters'
import { EntryGrid } from './entry-grid'
import { EntryDrawer } from './entry-drawer'
import { CaptureModal } from './capture-modal'
import { domainOf, isGallerySize, type DomainCode, type EntryDetail, type EntryStatus, type EntrySummary, type GallerySize, type Tag } from '@/types/atlas'

/**
 * Library 工作区。
 *
 * 三段式布局（照 navi 的 workspace）：左栏筛选 + 主区卡片墙 + 右侧 drawer。
 *
 * ⭐⭐ **采集不再是常驻面板，而是「全屏拖放 → 弹窗」（2026-10-07）。**
 *
 * 之前 QuickAdd 是一整条常驻在顶部的采集带。问题不是功能，是**代价先于
 * 意图**：进页面第一眼看到的是一张要填的表，而不是自己已经攒下的东西。
 * 判据是「首屏该回答我现在有什么」—— 采集入口该在需要时出现，不该占位。
 *
 * 三个入口，一个动作：
 * · **整个窗口**都是拖放区（不只是那个虚线框）
 * · 全局 Cmd/Ctrl+V 粘图
 * · 顶栏那个「+」按钮（给不用拖拽的场景留一个显式入口）
 *
 * ⚠️ **库跟着筛选走，不再是顶栏那个独立选择器。** token 的原话：「如果当前
 * 正在查看的是哪个类型就弹出对应的添加弹窗，没有查看的类型是全部，就多一个
 * 选择类型的步骤」。侧栏的 domain 筛选本来就是「我现在在看什么」，让它同时
 * 决定「新内容进哪个库」—— 同一个问题的两个答案，没必要分成两处状态。
 * 分成两处就会出现「我在看生物设计，但存进去的是另一个库」这种静默错位。
 */
export function LibraryWorkspace() {
  const [entries, setEntries] = useState<EntrySummary[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [counts, setCounts] = useState<Record<EntryStatus, number>>({ pending_ai: 0, inbox: 0, reviewed: 0 })
  const [untagged, setUntagged] = useState(0)
  const [filter, setFilter] = useState<AtlasFilter>(EMPTY_FILTER)
  const [size, setSize] = useState<GallerySize>('sm')
  const [selected, setSelected] = useState<EntryDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  /** 采集弹窗开不开。false = 关着。 */
  const [capturing, setCapturing] = useState(false)
  /** 全屏拖放的高亮态。⚠️ 深度计数，见 workspace 里的注释。 */
  const [dragDepth, setDragDepth] = useState(0)

  /**
   * 筛选条件持久化 —— **只存 domain 与 size**，不存 q / tags / status。
   *
   * ⚠️ 这两个是「我在哪个视角里工作」，每次进来重选一遍是纯摩擦。
   * 而搜索词和筛选是**一次性的动作**，持久化它会让人回到一个自己都忘了
   * 为什么空白的列表上（这是所有「保存筛选条件」功能的通病）。
   */
  useEffect(() => {
    const savedDomain = window.localStorage.getItem('atlas:domain')
    if (savedDomain) setFilter((current) => ({ ...current, domain: savedDomain as DomainCode }))
    const savedSize = window.localStorage.getItem('atlas:gallerySize')
    /**
     * ⚠️ 存的值要**校验**再用：localStorage 可以手改，坏值会让
     * `gridTemplateColumns` 拿到 NaN，整个列表塌掉。
     *
     * ⚠️ 2026-10-07 删掉 `md` 档之后，这里**故意**不加迁移分支：
     * 旧值 `md` 过不了 `isGallerySize`，静默落回默认的 `sm`。
     * 一个 160px 的中间档本来就不该被记住 —— 迁移它等于承认那一档
     * 是合法选择，而它不是。真要迁移也只有一种正确做法：落回默认。
     */
    if (savedSize && isGallerySize(savedSize)) setSize(savedSize)
  }, [])

  /**
   * 库选择（= domain 筛选）写回 localStorage。
   *
   * ⚠️ 存的值要**校验**再用：localStorage 可以手改，坏值会让筛选永不命中
   * （界面表现是「列表空了但我明明有东西」）。
   */
  const pickFilter = useCallback((next: AtlasFilter) => {
    setFilter(next)
    if (next.domain) window.localStorage.setItem('atlas:domain', next.domain)
  }, [])

  const pickSize = useCallback((next: GallerySize) => {
    setSize(next)
    window.localStorage.setItem('atlas:gallerySize', next)
  }, [])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/atlas/entries')
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || '加载失败')
      setEntries(body.data)
      setCounts(body.counts)
      setUntagged(body.untagged ?? 0)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // tag 列表随条目一起刷新 —— 不单独开一个接口，v0 不值得
  useEffect(() => {
    const seen = new Map<string, Tag>()
    for (const entry of entries) for (const tag of entry.tags) if (!seen.has(tag.name)) seen.set(tag.name, tag)
    setTags([...seen.values()].sort((left, right) => left.name.localeCompare(right.name)))
  }, [entries])

  const visible = useMemo(() => {
    return entries.filter((entry) => {
      if (filter.domain && entry.domain !== filter.domain) return false
      if (filter.status && entry.status !== filter.status) return false
      if (filter.untagged && entry.tags.length > 0) return false
      if (filter.origin && !entry.tags.some((tag) => tag.origin === filter.origin)) return false
      if (filter.tags.length > 0 && !filter.tags.every((tag) => entry.tags.some((item) => item.name === tag))) return false
      if (filter.q.trim()) {
        const needle = filter.q.trim().toLowerCase()
        // ⚠️ 客户端这份要和服务端 listEntries 的搜索字段**保持一致** ——
        // 两边不一样会出现「筛出来 N 条、点进去搜却是 0 条」的鬼故事。
        const haystack = [
          entry.name,
          entry.observed,
          entry.read,
          entry.worthwhileBecause,
          entry.sourceGame,
          entry.sourceTitle,
          ...entry.tags.map((tag) => tag.name),
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [entries, filter])

  /**
   * 点卡片开 drawer 时拉完整详情。
   *
   * ⚠️ 必须单独拉：列表返回的是 EntrySummary，不含 extension。
   */
  const openDetail = async (summary: EntrySummary) => {
    const response = await fetch(`/api/atlas/entries/${summary.id}`)
    const body = await response.json()
    if (response.ok && body.success) setSelected(body.data)
  }

  /**
   * ⭐ 全屏拖放。
   *
   * ⚠️ **dragenter / dragleave 在层级里每穿过一个子元素就触发一对**，所以
   * 直接 `setDragging(boolean)` 会疯狂闪烁（鼠标从卡片移到卡片之间的空隙
   * 就算「离开」）。必须用**深度计数**：>0 才是拖拽中，归零才是离开。
   *
   * ⚠️ **不读 dataTransfer、不上传任何东西** —— 这一层只负责「用户在拖东西
   * 进来」这件事，然后叫出弹窗。真正的读取在弹窗里做。
   * 理由：拖放可能来自一个**根本没有图片也没有 URL** 的地方（从别的应用
   * 拖一段文字过来），在打开弹窗之前就报错等于「用户什么都没做却弹了个
   * 错误框」。先接住，再问。
   */
  const onDragEnter = (event: React.DragEvent) => {
    event.preventDefault()
    setDragDepth((depth) => depth + 1)
  }
  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault()
    setDragDepth((depth) => Math.max(0, depth - 1))
  }
  const onDragOver = (event: React.DragEvent) => {
    // ⚠️ 不 preventDefault 的话浏览器会走它自己的默认行为（打开那个文件 /
    // 跳到那个链接），整个应用被换掉。这是「能拖进来」的前提。
    event.preventDefault()
  }
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragDepth(0)
    setCapturing(true)
  }

  /**
   * 全局粘贴 → 打开采集弹窗。
   *
   * ⚠️ 焦点在输入框里时**不拦截** —— 用户在搜索框里 Cmd+V 粘一段 URL 是
   * 「搜索这个」，不是「存一条」。这个区分是粘贴处理器最容易写错的地方：
   * 之前版本在 QuickAdd 里挂了全局 paste，输入框一聚焦就静默失效，
   * 表现是「有时粘上去了有时没有」。
   *
   * 弹窗自己接管粘贴（它有 onPaste），所以这里只负责「弹窗没开的时候」。
   */
  useEffect(() => {
    const onPaste = () => {
      const target = document.activeElement
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      setCapturing(true)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  /** 采集弹窗开着时按 Esc 关掉它。 */
  useEffect(() => {
    if (!capturing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCapturing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capturing])

  const activeDomain = filter.domain ? domainOf(filter.domain) : null

  return (
    <div
      className="relative flex h-svh flex-col bg-background"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <h1 className="text-sm font-semibold">Creative Atlas</h1>
        <span className="text-muted-foreground">/</span>
        {/*
          ⚠️ 顶栏的「库选择器」被**删除**了（2026-10-07）。原来这里有一个
          DomainSwitcher 下拉，与侧栏的「类型 · DOMAIN」筛选指向同一件事 ——
          两处状态各改各的，迟早出现「我在看生物设计，存的却是别的库」。
          现在库就是侧栏那一项，一处状态，采集时直接读它。
        */}
        <span className="text-sm text-muted-foreground">
          {activeDomain ? activeDomain.labelZh : '全部类型'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{entries.length} 条</span>
          {/* 不用拖拽时的显式入口。⭐ 没有它，整套采集就只剩一条隐形的
              鼠标路径 —— 触屏、键盘用户、以及「我知道有这功能但找不到」的
              人都只能放弃。图标按钮不够，必须有 title 说明。 */}
          <button
            type="button"
            onClick={() => setCapturing(true)}
            title="添加一条（也可以直接把图或图片链接拖进窗口）"
            className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent"
          >
            <Plus className="size-3.5" />
            添加
          </button>
        </span>
      </header>

      {error && <div className="border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div>}

      {/*
        ⭐ 全屏拖放高亮。覆盖整个视口而不是一个小框——
        用户拖东西进来时，**鼠标在屏幕哪里**就说明他对准了哪里，
        提示框就该铺满那里。「松手就抓」如果只出现在顶部那条窄带里，
        而用户正在屏幕中央拖图，视觉上完全看不到自己在拖。
      */}
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center border-4 border-dashed border-primary bg-background/80">
          <div className="text-center">
            <p className="text-lg font-medium">松手就存进 {activeDomain ? activeDomain.labelZh : '你选的库'}</p>
            <p className="mt-1 text-xs text-muted-foreground">图片文件或图片链接都行</p>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <AtlasSidebar entries={entries} tags={tags} filter={filter} onFilter={pickFilter} counts={counts} untaggedCount={untagged} />

        <main className="flex min-w-0 flex-1 flex-col">
          <FilterBar filter={filter} onFilter={setFilter} resultCount={visible.length} size={size} onSizeChange={pickSize} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-8 text-sm text-muted-foreground">载入中…</p>
            ) : (
              <EntryGrid entries={visible} selectedId={selected?.id} onSelect={(entry) => void openDetail(entry)} size={size} />
            )}
          </div>
        </main>
      </div>

      {capturing && (
        /* ⭐ 「我在看哪个库」就是「新内容进哪个库」。全部类型时传 null，
           弹窗会先问一步 —— 那一步不可跳，因为它决定不可事后推断的归属。
           ⚠️ 这条注释必须写在 JSX 表达式容器**外面**。写成 JSX 注释插在
           组件属性之间会报 TS1005：属性表里只接受属性和展开运算符。
           ⚠️ 而且 JSX 注释里绝不能出现「斜杠星号 + 星号斜杠」这个序列，
           它会当场把注释闭合并让后面的文本变成代码 —— 报出来是 TS1109，
           指向的位置离真正的原因差好几行。 */
        <CaptureModal
          scopedDomain={filter.domain ?? null}
          knownTags={tags.map((tag) => tag.name)}
          onClose={() => setCapturing(false)}
          onSaved={() => void load()}
        />
      )}

      {selected && (
        <EntryDrawer
          entry={selected}
          onClose={() => setSelected(null)}
          onChange={(next) => {
            setSelected(next)
            void load()
          }}
          onDeleted={(id) => {
            setSelected(null)
            setEntries((current) => current.filter((item) => item.id !== id))
            void load()
          }}
        />
      )}
    </div>
  )
}
