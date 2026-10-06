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
    domain: 'monster' as const,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [
      { id: 't1', name: 'boss', group: 'role' as const, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
      { id: 't2', name: 'ground', group: 'primitive' as const, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
      { id: 't3', name: 'flying', group: 'primitive' as const, createdAt: '', updatedAt: '', origin: 'user' as const, ruleId: '' },
    ],
    taxonomy: { scale: 0.83, form: 0.33 },
  }

  // 1. 三档都要产出对应的列宽
  for (const size of ['sm', 'md', 'lg'] as const) {
    const html = renderToStaticMarkup(<EntryGrid entries={[entry]} onSelect={() => {}} size={size} />)
    const column = GALLERY_MIN_COLUMN[size]
    check(
      `${size} 档列宽为 ${column}px`,
      html.includes(`minmax(${column}px`),
      html.includes(`minmax(${column}px`) ? '' : '实际输出里没找到',
    )
  }

  // 2. 三档的列宽必须互不相同 —— 否则「切换」是假的
  const widths = (['sm', 'md', 'lg'] as const).map((size) => {
    const html = renderToStaticMarkup(<EntryGrid entries={[entry]} onSelect={() => {}} size={size} />)
    return html.match(/minmax\((\d+)px/)?.[1]
  })
  check('三档列宽互不相同', new Set(widths).size === 3, widths.join(' / '))

  // 3. sm 档应该是最小的那个（96）—— 这是「列表太大」这个诉求的核心
  check('sm 档是最小尺寸', widths[0] === String(GALLERY_MIN_COLUMN.sm), `${widths[0]} vs ${GALLERY_MIN_COLUMN.sm}`)

  // 4. sm 档省地方：tag 只留 1 个（3 个 tag 时不该全渲染）
  const smHtml = renderToStaticMarkup(<EntryGrid entries={[entry]} onSelect={() => {}} size="sm" />)
  const shownTags = (smHtml.match(/>[a-z]+</g) ?? []).filter((t) => ['>boss<', '>ground<', '>flying<'].includes(t))
  check('sm 档 tag 只留 1 个', shownTags.length === 1, `实际渲染 ${shownTags.length} 个`)
  check('sm 档显示 +N 提示', smHtml.includes('+2'), '没找到 +2')

  // 5. md/lg 档保留 3 个 tag
  const mdHtml = renderToStaticMarkup(<EntryGrid entries={[entry]} onSelect={() => {}} size="md" />)
  const mdTags = ['>boss<', '>ground<', '>flying<'].filter((t) => mdHtml.includes(t))
  check('md 档 tag 保留 3 个', mdTags.length === 3, `实际 ${mdTags.length} 个`)

  // 6. sm 档字更小（text-[10px] -> text-[9px]）
  check('sm 档用更小字号', smHtml.includes('text-[9px]') && !smHtml.includes('min-h-16'))
  check('md 档保留 min-h-16 文字区', mdHtml.includes('min-h-16'))

  // 7. 评过的维度：小图只留圆点，大图才写数字
  check('sm 档不显示维度数字', !smHtml.includes('>2</span>'))
  check('md 档显示维度数字', mdHtml.includes('>2</span>'))

  // 8. 无图条目给占位而不是破图
  const noImage = { ...entry, imagePath: '' }
  const noHtml = renderToStaticMarkup(<EntryGrid entries={[noImage]} onSelect={() => {}} size="md" />)
  check('无图给占位文案', noHtml.includes('无图'))

  // 9. 空列表给引导文案
  const emptyHtml = renderToStaticMarkup(<EntryGrid entries={[]} onSelect={() => {}} size="md" />)
  check('空列表有引导文案', emptyHtml.includes('还没有东西'))

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
