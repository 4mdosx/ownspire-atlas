/**
 * 未打标逻辑的验证脚本（不经过 HTTP）。
 *
 * ⚠️ 为什么用脚本而不是 curl：本机沙箱拦了 Next 的 turbopack rename，
 * dev server 起不来（2026-10-06，换过 distDir 与沙箱模式都无效）。但 service 层
 * 是纯函数 + drizzle，tsx 直接跑得动 —— 要验的东西全在这一层：强制校验、
 * NOT EXISTS 语义、互斥拒绝、计数、补标签后消失。路由那层只是转发。
 *
 * 用法：
 *   node --conditions react-server --import tsx scripts/verify-untagged.ts
 *
 * ⚠️ 两个 flag 的由来：
 *   --conditions react-server → 让 `import 'server-only'` 解析到空模块。
 *     那个包用 exports 条件区分服务端 / 客户端，react-server 分支就是官方
 *     给的服务端桩。保护本身是对的，不该为了跑脚本把它摘掉。
 *   --import tsx               → 让 tsconfig 里的 paths（`@/*`）生效。
 *
 * ⚠️ tsx 以 CJS 输出，不支持 top-level await —— 所以全部包在 main() 里。
 * ⚠️ 环境变量必须在 database.ts 被加载之前设好，所以先写再动态 import。
 */
import fs from 'node:fs'
import path from 'node:path'

async function main(): Promise<void> {
  const stamp = Date.now()
  process.env.DB_FILE_NAME = `file:/tmp/atlas-verify-${stamp}.db`
  const mediaRoot = `/tmp/atlas-verify-media-${stamp}`
  process.env.MEDIA_ROOT = mediaRoot

  const { createEntry, listEntries, untaggedCount, statusCounts, updateEntry } = await import('@/backstage/atlas/entry.service')
  const { attachEntryTagsByName, findTagByName } = await import('@/backstage/atlas/tag.service')
  const db = await import('@/backstage/db/database')

  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  db.pingDatabase()

  // 最小合法 PNG（1×1 透明像素）。service 层只校验路径形状，不看字节内容。
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const imagePath = 'verify/1.png'
  fs.mkdirSync(path.join(mediaRoot, 'verify'), { recursive: true })
  fs.writeFileSync(path.join(mediaRoot, imagePath), png)

  const src = 'https://example.com/monster'

  // 1. 无 tag 也能存 —— 本次裁定的核心
  const untagged = await createEntry({ name: '无标条目', sourceUrl: src, imagePath, tagNames: [] })
  check('无 tag 也能创建条目', untagged.tags.length === 0, `id=${untagged.id}`)

  // 2. 有 tag 也能存
  const tagged = await createEntry({ name: '有标条目', sourceUrl: src, imagePath, tagNames: ['blob', 'small'] })
  check('有 tag 也能创建', tagged.tags.length === 2, tagged.tags.map((tag) => tag.name).join(','))

  // 3. untagged 筛选只返回无标的那条
  const onlyUntagged = await listEntries({ untagged: true })
  check(
    'untagged 筛选只返回无标条目',
    onlyUntagged.length === 1 && onlyUntagged[0].id === untagged.id,
    `返回 ${onlyUntagged.length} 条`,
  )

  // 4. 全量仍返回两条
  const all = await listEntries()
  check('不筛选时返回全部', all.length === 2, `返回 ${all.length} 条`)

  // 5. 未打标记数
  const count = await untaggedCount()
  check('untaggedCount 正确', count === 1, `count=${count}`)

  // 6. untagged 与具体 tag 互斥
  try {
    await listEntries({ untagged: true, tagNames: ['blob'] })
    check('未打标 + 具体标签应互斥', false, '居然没报错')
  } catch (error) {
    check('未打标 + 具体标签应互斥', true, error instanceof Error ? error.message : '')
  }

  // 7. 补上标签后应从未打标里消失
  await attachEntryTagsByName(untagged.id, ['flying'])
  const afterTag = await listEntries({ untagged: true })
  check('补标签后从未打标消失', afterTag.length === 0, `剩 ${afterTag.length} 条`)
  check('untaggedCount 归零', (await untaggedCount()) === 0)

  // 8. 摘掉标签后应重新出现
  await updateEntry(tagged.id, { tagNames: [] })
  const afterStrip = await listEntries({ untagged: true })
  check('摘掉标签后重新出现在未打标', afterStrip.length === 1 && afterStrip[0].id === tagged.id, `返回 ${afterStrip.length} 条`)

  // 9. tag 查找大小写不敏感
  const flying = await findTagByName('FLYING')
  check('findTagByName 大小写不敏感', flying !== null, flying?.name ?? 'null')

  // 10. 未打标可与搜索叠加
  const combined = await listEntries({ untagged: true, q: '有标' })
  check('未打标可与搜索叠加', combined.length === 1, `含关键词「有标」得 ${combined.length} 条`)

  // 11. 状态计数未被污染
  const counts = await statusCounts()
  check('状态计数正常', counts.inbox === 2, JSON.stringify(counts))

  await db.closeDatabase()
  fs.rmSync(`/tmp/atlas-verify-${stamp}.db`, { force: true })
  fs.rmSync(mediaRoot, { recursive: true, force: true })

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
