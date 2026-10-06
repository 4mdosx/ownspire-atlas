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
import { GALLERY_MIN_COLUMN } from '@/types/atlas'

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
    sourceUrl: 'https://example.com/x',
    sourceTitle: '',
    sourceGame: '',
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
      { id: 't1', name: 'biped', group: 'form' as const, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
      { id: 't2', name: 'animal:cat', group: 'motif' as const, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
      { id: 't3', name: 'wing', group: 'feature' as const, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
    ],
    taxonomy: { scale: 0.83, form: 0.33 },
  }

  // ⚠️ 这个脚本测的是**渲染后的字符串**，因为那些约定在界面上「看不出来」：
  // 列宽差几像素、tag 少渲染一个、字号小一号 —— 没有断言就会静默回退，
  // 而看截图只会觉得「好像有点挤」。
  //
  // 所以每条断言都必须对应一个**具体的静默回退**，不为覆盖率而测。
  const render = (size: 'sm' | 'md' | 'lg', item = entry) =>
    renderToStaticMarkup(<EntryGrid entries={[item]} onSelect={() => {}} size={size} />)

  const TAGS = ['>biped<', '>animal:cat<', '>wing<']

  // ① 三档列宽必须**互不相同**且 sm 最小 —— 否则「尺寸切换」是个假的开关
  const widths = (['sm', 'md', 'lg'] as const).map((size) => render(size).match(/minmax\((\d+)px/)?.[1])
  check(
    '三档列宽互不相同且 sm 最小（否则切换是假的）',
    new Set(widths).size === 3 && widths[0] === String(GALLERY_MIN_COLUMN.sm) && widths[1] === String(GALLERY_MIN_COLUMN.md),
    widths.join(' / '),
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
  const mdHtml = render('md')
  check(
    'md 档保留全部 tag 且显示维度数字',
    TAGS.every((tag) => mdHtml.includes(tag)) && mdHtml.includes('>2</span>'),
    `tag ${TAGS.filter((t) => mdHtml.includes(t)).length}/3 · 数字 ${mdHtml.includes('>2</span>') ? '有' : '无'}`,
  )

  // ④ sm 档字号更小且不留空文字区 —— 否则「小图」只是图小，卡片高度没变
  check('sm 档字号更小且不留文字区', smHtml.includes('text-[9px]') && !smHtml.includes('min-h-16') && mdHtml.includes('min-h-16'))

  // ⑤ 两个空态都不能是空白 —— 空态没提示的话，用户会以为页面坏了
  check(
    '无图给占位文案',
    render('md', { ...entry, imagePath: '' }).includes('无图'),
  )
  check(
    '空列表有引导文案',
    renderToStaticMarkup(<EntryGrid entries={[]} onSelect={() => {}} size="md" />).includes('还没有东西'),
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
