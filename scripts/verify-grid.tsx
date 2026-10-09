/**
 * EntryGrid 的渲染验证 —— 用 React 服务端渲染直接看输出的 class。
 *
 * ⚠️ 为什么不用浏览器截图：本机的 agent-browser 能截图但不能交互
 * （eval 恒返回 {}、点击无响应），而 Gallery 尺寸切换是**纯客户端 state**，
 * SSR 阶段不渲染 —— 浏览器是唯一出路，但浏览器这条路不通。
 *
 * 所以退一步：**验证「给定 size 会不会产出正确的 grid 样式」**。
 * 切换动作本身（onClick → setSize → 持久化）在浏览器里跑不了，
 * 但那部分代码简单到不需要实测。
 *
 * 用法：node --import tsx scripts/verify-grid.tsx
 *
 * ⚠️ **不要**加 --conditions react-server：那个条件下 react-dom/server 会
 * 直接抛错（它与 RSC 互斥）。但 EntryGrid 是 'use client' 组件，
 * 它 import 的是 types/atlas.ts（纯类型+常量，无 server-only），
 * 所以不需要那个条件。
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { EntryGrid } from '@/app/library/entry-grid'
import { TINY_EDGE, UPSCALE_CAP_LARGE, UPSCALE_CAP_TINY } from '@/app/library/sharp-image'
import { GALLERY_MIN_COLUMN, GALLERY_SIZES, type GallerySize } from '@/types/atlas'

async function main(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const entry = {
    id: 'e1',
    domain: 'creature' as const,
    name: 'Tutorial Jr. Sentinel',
    source: 'https://example.com/x',
    author: 'unclear',
    license: 'unclear' as const,
    trainable: 'unclear' as const,
    imagePath: 'a.png',
    imageSource: 'paste' as const,
    originalName: 'a.png',
    observed: '攻击前身体膨胀约 0.5 秒',
    read: '用silhouette 变化给玩家 telegraph',
    worthwhileBecause: '极简蓄力建立高 commitment',
    status: 'inbox' as const,
    analysisStatus: 'committed' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [
      { id: 't1', name: 'biped', confidence: 1, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
      { id: 't2', name: 'animal:cat', confidence: 1, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
      { id: 't3', name: 'wing', confidence: 1, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
    ],
    axisValues: { scale: 0.83, form: 0.33 },
  }

  // ⚠️ 这个脚本测的是**渲染后的字符串**，因为那些约定在界面上「看不出来」：
  // 列宽差几像素、tag 少渲染一个、字号小一号 —— 没有断言就会静默回退，
  // 而看截图只会觉得「好像有点挤」。
  //
  // 所以每条断言都必须对应一个**具体的静默回退**，不为覆盖率而测。
  const render = (size: GallerySize, item = entry) =>
    renderToStaticMarkup(<EntryGrid entries={[item]} onSelect={() => {}} size={size} />)

  const TAGS = ['>biped<', '>animal:cat<', '>wing<']

  // ① 两档图墙列宽必须**不同**且 sm 最小 —— 否则「尺寸切换」是个假的开关
  const widths = (['sm', 'lg'] as const).map((size) => render(size).match(/minmax\((\d+)px/)?.[1])
  check(
    '两档图墙列宽不同且 sm 最小（否则切换是假的）',
    widths[0] === String(GALLERY_MIN_COLUMN.sm) && widths[1] === String(GALLERY_MIN_COLUMN.lg) && Number(widths[0]) < Number(widths[1]),
    widths.join(' / '),
  )

  // ⚠️ sm 是**默认档**。这条盯的是默认值本身 —— 改默认值时它会拦一下，
  // 免得「默认」在某次改动里悄悄变成了大图墙（那会让首屏一屏只有几张，
  // 而 Atlas 的库是靠「扫」来用的）。
  check('默认档是 sm（一屏能扫几十个）', GALLERY_SIZES[0] === 'sm' && GALLERY_MIN_COLUMN.sm === 96, `默认 ${GALLERY_SIZES[0]} / ${GALLERY_MIN_COLUMN.sm}px`)

  // ⚠️ `md` 档已被删除。任何它回来的迹象（枚举里、类型里）都要在这里挡住。
  check(
    'md 中间档已彻底删除（不在枚举也不在类型）',
    !(GALLERY_SIZES as readonly string[]).includes('md') && !('md' in GALLERY_MIN_COLUMN),
    GALLERY_SIZES.join('/'),
  )

  // ② sm 档必须省地方：tag 只留 1 个并给 +N 提示，否则小图还是会撑破布局
  const smHtml = render('sm')
  const shownTags = TAGS.filter((tag) => smHtml.includes(tag))
  check(
    'sm 档只渲染 1 个 tag 并显示 +N',
    shownTags.length === 1 && smHtml.includes('+2'),
    `渲染 ${shownTags.length} 个 · +2 ${smHtml.includes('+2') ? '有' : '无'}`,
  )

  // ③ 同一套内容在大档位下必须完整：tag 全留、维度数字出现
  const lgHtml = render('lg')
  check(
    'lg 档保留全部 tag 且显示维度数字',
    TAGS.every((tag) => lgHtml.includes(tag)) && lgHtml.includes('>2</span>'),
    `tag ${TAGS.filter((t) => lgHtml.includes(t)).length}/3 · 数字 ${lgHtml.includes('>2</span>') ? '有' : '无'}`,
  )

  // ④ sm 档字号更小且不留空文字区 —— 否则「小图」只是图小，卡片高度没变
  check('sm 档字号更小且不留文字区', smHtml.includes('text-[9px]') && !smHtml.includes('min-h-16') && lgHtml.includes('min-h-16'))

  // ⑤ 两个空态都不能是空白 —— 空态没提示的话，用户会以为页面坏了
  check(
    '无图给占位文案',
    render('lg', { ...entry, imagePath: '' }).includes('无图'),
  )
  check(
    '空列表有引导文案',
    renderToStaticMarkup(<EntryGrid entries={[]} onSelect={() => {}} size="sm" />).includes('还没有东西'),
  )

  // ⑤b ⭐⭐ 列表档（2026-10-07 新增）
  //
  // ⚠️ 列表档最容易退化的方式是「它其实还是图墙，只是列窄了」——
  // 那种情况下 <img> 会拿到和图墙一样的放大逻辑，32px 的行里塞一张
  // 几百 px 的图，整个行被撑开。这条断言盯住**行内结构**。
  const listHtml = render('list')
  check(
    '列表档是行式布局且缩略图不放大',
    listHtml.includes('<ul') && listHtml.includes('size-8') && !listHtml.includes('aspect-square'),
    `ul ${listHtml.includes('<ul') ? '有' : '无'} · 32px ${listHtml.includes('size-8') ? '有' : '无'} · aspect-square ${listHtml.includes('aspect-square') ? '还在（说明是图墙）' : '无'}`,
  )
  check(
    '列表档显示状态标签（图墙上没有的地方）',
    listHtml.includes('Inbox') && !smHtml.includes('>Inbox<'),
    `列表 ${listHtml.includes('Inbox') ? '有' : '无'} · sm ${smHtml.includes('>Inbox<') ? '也有（那就重复了）' : '无'}`,
  )

  // ⑥ ⭐ 图片放大上限（2026-10-07）
  //
  // ⚠️ 这条断言盯的是**「卡片不自己算放大倍数」**这件事。SSR 阶段拿不到
  // naturalWidth，所以 style 一定还没有 maxWidth —— 这是预期状态，不是缺陷。
  //
  // 如果哪天有人「顺手优化」成用 CSS 的 w-full + 一个写死的 max-width，
  // 这条会静默通过而功能已经回退（上限变成常量，小图照样被拉成马赛克）。
  // 所以这里断言的是**结构**：图片走SharpImage 组件，且没被写死尺寸。
  const gridHtml = render('lg')
  check(
    '卡片图走 SharpImage 且没有被写死的尺寸',
    gridHtml.includes('/api/atlas/entries/e1/image') && !/style="[^"]*max-width:\s*\d/.test(gridHtml),
    gridHtml.match(/<img[^>]*>/)?.[0]?.slice(0, 120) ?? '没有 img',
  )

  // ⚠️⭐ **最关键的一条**：图片必须用 `min(cap, 100%)` 而不是 `size-full`。
  //
  // 2026-10-07 真的出过一次这个 bug：卡片里图只显示了一半（底下的球被裁掉）。
  // 原因是 `size-full` 的 `h-full` 依赖「父元素有确定高度」，前提不成立时
  // 静默失效 → 退回自然高度 → 又被放大上限撑到几百 px → 溢出被裁。
  //
  // SSR 阶段 onLoad 还没跑，所以 style 是 undefined —— 这条断言盯的是
  // **class 里不含 size-full**：那是「靠容器高度缩放」的写法，只要它回来，
  // 裁图就会回来。min() 那套写法要 onLoad 之后才出现在 style 里，
  // 浏览器里才断言得了；SSR 这里只能守住 class 这一半。
  check(
    '图片不用 size-full（那是「被裁掉一半」的根因）',
    !gridHtml.includes('size-full object-contain'),
    gridHtml.match(/class="[^"]*object-contain[^"]*"/)?.[0] ?? '找不到 class',
  )

  // ⚠️ 数字是 CSS 像素，不是「几倍」—— 写死它等于把判据挪出代码。
  // 这里只钉住「上限存在」这个事实，倍数由 sharp-image.tsx 的常量决定。
  check(
    '放大上限常量已定义（倍数不在界面里写死）',
    UPSCALE_CAP_TINY > 1 && UPSCALE_CAP_LARGE > 1 && UPSCALE_CAP_TINY > UPSCALE_CAP_LARGE && TINY_EDGE > 0,
    `tiny ${UPSCALE_CAP_TINY}× / large ${UPSCALE_CAP_LARGE}× / 阈值 ${TINY_EDGE}px`,
  )

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('\n失败项：')
    for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
