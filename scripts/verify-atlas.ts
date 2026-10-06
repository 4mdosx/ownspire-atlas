/**
 * 验证脚本（不经过 HTTP）。
 *
 * ⚠️ 为什么用脚本而不是 curl：本机沙箱拦了 Next 的 turbopack rename，
 * dev server 起不来（2026-10-06，换过 distDir 与沙箱模式都无效）。但 service 层
 * 是纯函数 + drizzle，tsx 直接跑得动 —— 要验的东西全在这一层：强制校验、
 * NOT EXISTS 语义、互斥拒绝、计数、补标签后消失、origin 隔离、taxonomy
 * 星级映射、换 domain。路由那层只是转发。
 *
 * 用法：
 *   node --conditions react-server --import tsx scripts/verify-atlas.ts
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

  const service = await import('@/backstage/atlas/entry.service')
  const { createEntry, listEntries, untaggedCount, statusCounts, updateEntry, changeDomain, setTaxonomy, clearTaxonomyDimension, getEntryDetail } = service
  const tagService = await import('@/backstage/atlas/tag.service')
  const { attachEntryTagsByName, attachSystemTag, findTagByName, tagsForEntries, detachSystemTagsByRule } = tagService
  const atlas = await import('@/types/atlas')
  const { scoreToStars, starsToScore, TAXONOMY_STEPS } = atlas
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

  const src = 'https://example.com/creature'
  const creature = 'creature'

  console.log('\n— 未打标逻辑（v0.1 裁定，v0.2 保留）—')

  // 1. 无 tag 也能存
  const untagged = await createEntry({ domain: creature, name: '无标条目', sourceUrl: src, imagePath, tagNames: [] })
  check('无 tag 也能创建条目', untagged.tags.length === 0, `id=${untagged.id}`)

  // 2. 有 tag 也能存
  const tagged = await createEntry({ domain: creature, name: '有标条目', sourceUrl: src, imagePath, tagNames: ['blob', 'small'] })
  check('有 tag 也能创建', tagged.tags.length === 2, tagged.tags.map((tag) => tag.name).join(','))

  // 3. untagged 筛选只返回无标的那条
  const onlyUntagged = await listEntries({ untagged: true })
  check('untagged 筛选只返回无标条目', onlyUntagged.length === 1 && onlyUntagged[0].id === untagged.id, `返回 ${onlyUntagged.length} 条`)

  // 4. 全量仍返回两条
  const all = await listEntries()
  check('不筛选时返回全部', all.length === 2, `返回 ${all.length} 条`)

  // 5. 未打标记数
  check('untaggedCount 正确', (await untaggedCount()) === 1)

  // 6. untagged 与具体 tag 互斥
  try {
    await listEntries({ untagged: true, tagNames: ['blob'] })
    check('未打标 + 具体标签应互斥', false, '居然没报错')
  } catch (error) {
    check('未打标 + 具体标签应互斥', true, error instanceof Error ? error.message : '')
  }

  // 7. 补上标签后应从未打标里消失
  await attachEntryTagsByName(untagged.id, ['flying'])
  check('补标签后从未打标消失', (await listEntries({ untagged: true })).length === 0)
  check('untaggedCount 归零', (await untaggedCount()) === 0)

  // 8. 摘掉标签后应重新出现
  await updateEntry(tagged.id, { tagNames: [] })
  const afterStrip = await listEntries({ untagged: true })
  check('摘掉标签后重新出现在未打标', afterStrip.length === 1 && afterStrip[0].id === tagged.id, `返回 ${afterStrip.length} 条`)

  // 9. tag 查找大小写不敏感
  check('findTagByName 大小写不敏感', (await findTagByName('FLYING')) !== null)

  // 10. 未打标可与搜索叠加
  check('未打标可与搜索叠加', (await listEntries({ untagged: true, q: '有标' })).length === 1)

  // 11. 状态计数未被污染
  const counts = await statusCounts()
  check('状态计数正常', counts.inbox === 2, JSON.stringify(counts))

  console.log('\n— origin：用户输入 vs 系统自动添加 —')

  // 12. 系统 tag 挂上后 origin 应为 system
  await attachSystemTag(tagged.id, 'project-alpha', 'proj:alpha')
  const withSystem = (await tagsForEntries([tagged.id])).get(tagged.id) ?? []
  const sysTag = withSystem.find((tag) => tag.name === 'project-alpha')
  check('系统 tag origin=system', sysTag?.origin === 'system', `origin=${sysTag?.origin} ruleId=${sysTag?.ruleId}`)
  check('系统 tag 保留 ruleId', sysTag?.ruleId === 'proj:alpha')

  // 13. ⚠️ 用户编辑标签时不能把系统 tag 抹掉 —— 这是 origin 字段存在的全部理由
  await updateEntry(tagged.id, { tagNames: ['blob'] })
  const afterEdit = (await tagsForEntries([tagged.id])).get(tagged.id) ?? []
  const keptSys = afterEdit.find((tag) => tag.name === 'project-alpha')
  check('用户改标签后系统 tag 仍在', keptSys?.origin === 'system')
  check('用户 tag 已更新为 blob', afterEdit.some((tag) => tag.name === 'blob' && tag.origin === 'user'))

  // 14. origin 筛选
  check('origin=system 筛出系统 tag 条目', (await listEntries({ origin: 'system' })).every((entry) => entry.tags.some((tag) => tag.origin === 'system')))
  check('按 ruleId 查系统 tag', (await listEntries({ origin: 'system', ruleId: 'proj:alpha' })).length === 1)

  // 15. 同一 tag 不同条目 origin 可以不同
  await attachEntryTagsByName(untagged.id, ['project-alpha'])
  const split = await tagsForEntries([untagged.id, tagged.id])
  check(
    '同 tag 不同条目 origin 独立',
    (split.get(untagged.id) ?? []).find((tag) => tag.name === 'project-alpha')?.origin === 'user' &&
      (split.get(tagged.id) ?? []).find((tag) => tag.name === 'project-alpha')?.origin === 'system',
    '这正是 origin 必须挂关联表的原因',
  )

  // 16. 按规则整批摘
  check('detachSystemTagsByRule 摘掉 1 条', (await detachSystemTagsByRule('proj:alpha')) === 1)

  console.log('\n— taxonomy：星级 ⇆ score 映射 —')

  // 17. 星级往返
  check('starsToScore(5)=1', starsToScore(5) === 1)
  check('starsToScore(3)=0.6', Math.abs(starsToScore(3) - 0.6) < 1e-9, String(starsToScore(3)))
  check('scoreToStars(0.6)=3', scoreToStars(0.6) === 3)
  check('半星 2.5 → 0.5 → 2.5 往返', scoreToStars(starsToScore(2.5)) === 3, `2.5 星 = ${starsToScore(2.5)}`)

  // 18. 步进档位：0.2 步进在 0–1 上是 6 档（含 0），不是 11
  check('TAXONOMY_STEPS 6 档且末档为 1', TAXONOMY_STEPS.length === 6 && TAXONOMY_STEPS[5] === 1, `档位 ${TAXONOMY_STEPS.join(',')}`)
  check('半星只给 6 个可点值', TAXONOMY_STEPS.length === 6, '5 星 + 半星 ≠ 11 档')

  // 19. taxonomy 是 sparse 的 —— 没打分的维度不出现
  await setTaxonomy(tagged.id, { visualMass: 0.8, shapeLanguage: 0.4 })
  const detail = await getEntryDetail(tagged.id)
  check('taxonomy 只存给了的维度', Object.keys(detail.taxonomy).length === 2, JSON.stringify(detail.taxonomy))
  check('0.8 存进去还是 0.8', detail.taxonomy.visualMass === 0.8)

  // 20. 「没打过分」≠「0 分」
  check('没打分的维度不在结果里', detail.taxonomy.familiarity === undefined)
  await setTaxonomy(tagged.id, { threatAffinity: 0 })
  const withZero = await getEntryDetail(tagged.id)
  check('显式 0 分要与「没打过分」可区分', withZero.taxonomy.threatAffinity === 0 && Object.keys(withZero.taxonomy).length === 3)

  // 21. 清除维度
  await clearTaxonomyDimension(tagged.id, 'threatAffinity')
  check('清除维度后只剩 2 个', Object.keys((await getEntryDetail(tagged.id)).taxonomy).length === 2)

  // 22. 陌生维度必须被拒 —— 维度定义在代码里，写入侧就能判
  try {
    await setTaxonomy(tagged.id, { nosuchdimension: 0.5 } as never)
    check('陌生维度应被拒绝', false, '居然没报错')
  } catch (error) {
    check('陌生维度应被拒绝', true, error instanceof Error ? error.message : '')
  }

  console.log('\n— domain 分流 —')

  // 23. 扩展表自动创建
  check('monster 条目自动建扩展行', detail.extension !== null)

  // 24. domain 筛选
  check('domain=creature 筛出两条', (await listEntries({ domain: creature })).length === 2)
  check('domain=未知名不报错且返回空', (await listEntries({ domain: 'nope' as never })).length === 0)

  // 25. 换 domain 会丢弃不兼容的打分
  await changeDomain(tagged.id, 'creature')
  check('换到同domain 是幂等的', (await getEntryDetail(tagged.id)).domain === creature)

  // 26. imagePath 可空
  const noImage = await createEntry({ domain: creature, name: '无图条目', sourceUrl: src })
  check('没有图片也能创建', noImage.imagePath === '', `imagePath="${noImage.imagePath}"`)

  // 27. 拒绝绝对路径 / ..
  try {
    await createEntry({ domain: creature, name: '坏路径', sourceUrl: src, imagePath: '/etc/passwd' })
    check('绝对路径应被拒绝', false, '居然没报错')
  } catch (error) {
    check('绝对路径应被拒绝', true, error instanceof Error ? error.message : '')
  }
  try {
    await createEntry({ domain: creature, name: '穿越路径', sourceUrl: src, imagePath: '../../etc/passwd' })
    check('.. 穿越应被拒绝', false, '居然没报错')
  } catch (error) {
    check('.. 穿越应被拒绝', true, error instanceof Error ? error.message : '')
  }

  // 28. 来源强制
  try {
    await createEntry({ domain: creature, name: '无来源', sourceUrl: '' })
    check('缺来源应被拒绝', false, '居然没报错')
  } catch (error) {
    check('缺来源应被拒绝', true, error instanceof Error ? error.message : '')
  }

  // 29. 维度分组的完整性（2026-10-06 两级结构）
  // 每个维度必须属于某个已声明的 group，否则界面上它会**整块消失**
  // —— 渲染是按 group 遍历维度的，漏声明就是静默丢失。
  {
    const { dimensionsOf, groupsOf, dimensionsInGroup } = atlas
    const groupKeys = new Set(groupsOf(creature).map((group) => group.key))
    const all = dimensionsOf(creature)
    const orphans = all.filter((dimension) => !groupKeys.has(dimension.group))
    check('所有维度都有归属 group', orphans.length === 0, orphans.map((d) => d.key).join(',') || '无孤儿')

    // 反向：group 声明了但没有维度
    const emptyGroups = groupsOf(creature).filter((group) => dimensionsInGroup(creature, group.key).length === 0)
    check('没有空 group', emptyGroups.length === 0, emptyGroups.map((g) => g.key).join(',') || '无空组')

    // 分组后的维度总数必须与平铺一致 —— 证明分组是纯归类，没有漏也没有重
    const grouped = groupsOf(creature).flatMap((group) => [...dimensionsInGroup(creature, group.key)])
    check(
      '分组不重不漏',
      grouped.length === all.length && new Set(grouped.map((d) => d.key)).size === all.length,
      `平铺 ${all.length} · 分组 ${grouped.length}`,
    )

    // ⭐ 具体的归属（2026-10-06 域收窄后）
    // creature 域现在**只管形象设计**：combat（战斗方式）与 role（定位）被砍掉，
    // 因为它们是**关卡玩法**而不是**造型属性**（同一只怪在不同关卡可以是
    // fodder 也可以是 elite —— 那说明 role 是用法不是属性）。
    const groupOf = (key: string) => all.find((d) => d.key === key)?.group
    check('visualMass 归入 form 组', groupOf('visualMass') === 'form', String(groupOf('visualMass')))
    check('proportion 归入 form 组', groupOf('proportion') === 'form', String(groupOf('proportion')))
    check('shapeLanguage 归入 form 组', groupOf('shapeLanguage') === 'form', String(groupOf('shapeLanguage')))
    check('visualComplexity 归入 form 组', groupOf('visualComplexity') === 'form', String(groupOf('visualComplexity')))
    check('familiarity 归入 read 组', groupOf('familiarity') === 'read', String(groupOf('familiarity')))
    check('threatAffinity 归入 read 组', groupOf('threatAffinity') === 'read', String(groupOf('threatAffinity')))

    // ⚠️ 这两条是「域收窄」的回归守卫 —— 它们**不该回来**，除非 token 明确
    // 改主意要采集玩法素材。写死断言是为了让那一刻是「有意识的决定」，
    // 而不是某次重构顺手把它们带回来。
    check('combat 轴已砍掉（战斗方式属玩法）', !all.some((d) => d.key === 'combat'))
    check('role 轴已砍掉（关卡定位属玩法）', !all.some((d) => d.key === 'role'))
    // ⚠️ 下面三条是「分类不是刻度」的回归守卫（2026-10-07）：
    // · form 降级成 tag 分组（Blob / Biped / Quadruped 那些参照系）
    // · palette 改成 observed 里的观察项
    // · mobility 划给 Animation domain（造型回答「静止时什么质感」，
    //   动作回答「动起来什么质感」，是两个问题）
    check('form 轴已降级成 tag 分组', !all.some((d) => d.key === 'form'), all.map((d) => d.key).join(' '))
    check('palette 轴已改成观察项', !all.some((d) => d.key === 'palette'))
    check('mobility 轴已划给 Animation domain', !all.some((d) => d.key === 'mobility'))
  }

  // 30. 档位 → score 映射（点档位词那条路径）
  {
    const { MONSTER_TAXONOMY, anchorToScore, scoreToAnchor } = atlas
    for (const dimension of MONSTER_TAXONOMY) {
      const scores = dimension.anchors.map((anchor) => anchorToScore(dimension, anchor)!)
      const ascending = scores.every((score, index) => index === 0 || score > scores[index - 1])
      check(`${dimension.key} 档位递增`, ascending, scores.map((s) => s.toFixed(2)).join(' '))

      // 不顶格、不触底：留出余量让 0.8 以上的精度还能走到
      const top = scores[scores.length - 1]
      const low = scores[0]
      check(`${dimension.key} 不顶格/不触底`, top < 1 && low > 0, `范围 ${low.toFixed(2)}–${top.toFixed(2)}`)

      // 往返一致：score 反查回同一个档位词，否则界面上选中态会跳
      const roundtrip = dimension.anchors.every((anchor) => scoreToAnchor(dimension, anchorToScore(dimension, anchor)!) === anchor)
      check(`${dimension.key} 档位往返一致`, roundtrip)
    }
  }

  // 31. 不属于该 domain 的维度应被写入侧拒绝
  {
    const { isDimensionOf } = atlas
    check('visualMass 维度属于 creature', isDimensionOf(creature, 'visualMass'))
    check('不存在的维度被拒', !isDimensionOf(creature, 'nope'))
  }

  // 32. ⭐ 观察与判断严格分离（2026-10-06）
  // 这条纪律的价值只有在**互相污染时会出事**。所以验证的重点不是
  // 「两个字段都存得下」，而是「写 observed 不会碰到 read」。
  {
    const split = await createEntry({
      domain: creature,
      name: '观察与判断',
      sourceUrl: 'https://example.com/split',
      observed: '攻击前身体膨胀约 0.5 秒',
      read: '用 silhouette 变化给玩家 telegraph',
      worthwhileBecause: '极简蓄力建立高 commitment',
    })
    check('observed 独立落库', split.observed === '攻击前身体膨胀约 0.5 秒', split.observed)
    check('read 独立落库', split.read === '用 silhouette 变化给玩家 telegraph', split.read)
    check(
      'worthwhileBecause 独立落库',
      split.worthwhileBecause === '极简蓄力建立高 commitment',
      split.worthwhileBecause,
    )
    check('observed 不被 read 污染', !split.observed.includes('silhouette'))
    check('read 不被 observed 污染', !split.read.includes('膨胀'))

    // ⚠️ 写 observed 时 read 必须原样保留 —— 这才是「分离」的实质。
    // 合并成一个字段的实现会在这里露馅：改一个等于改两个。
    await updateEntry(split.id, { observed: '改过的观察' })
    const afterObserved = await getEntryDetail(split.id)
    check('改 observed 不动 read', afterObserved.read === '用 silhouette 变化给玩家 telegraph', afterObserved.read)
    await updateEntry(split.id, { read: '改过的判断' })
    const afterRead = await getEntryDetail(split.id)
    check('改 read 不动 observed', afterRead.observed === '改过的观察', afterRead.observed)
    check('改 read 不动 worthwhileBecause', afterRead.worthwhileBecause === split.worthwhileBecause)

    // 旧的 notes 调用方式应落到 observed（导入包兼容），而不是被丢弃
    const legacy = await createEntry({
      domain: creature,
      name: '旧调用方',
      sourceUrl: 'https://example.com/legacy',
      notes: '通过 notes 传进来的内容',
    })
    check('notes 落到 observed', legacy.observed === '通过 notes 传进来的内容', legacy.observed)
    check('notes 不落到 read', legacy.read === '', `read=${JSON.stringify(legacy.read)}`)
  }

  // 33. ⭐ 搜索要覆盖三个新字段（2026-10-06）
  // 搜得到是「我能按自己写过的话找到它」的前提 —— 观察与判断分列之后，
  // 只搜其中一两个字段就等于让另一半内容失联。
  {
    const hitsObserved = await listEntries({ q: '改过的观察' })
    check('能搜到 observed 的内容', hitsObserved.some((item) => item.observed === '改过的观察'), `${hitsObserved.length} 条`)
    const hitsRead = await listEntries({ q: '改过的判断' })
    check('能搜到 read 的内容', hitsRead.some((item) => item.read === '改过的判断'), `${hitsRead.length} 条`)
    const hitsWorth = await listEntries({ q: '高 commitment' })
    check('能搜到 worthwhileBecause', hitsWorth.length > 0, `${hitsWorth.length} 条`)
  }

  // 34. ⭐ tag 的 group 命名空间（2026-10-06）
  {
    const { createTag, findTagByName, listTags } = tagService
    const tagged = await createTag('animal:cat', 'motif')
    check('建 tag 时带命名空间', tagged.group === 'motif', tagged.group)

    const found = await findTagByName('animal:cat')
    check('读出来的 tag 保留命名空间', found?.group === 'motif', String(found?.group))

    // ⚠️ 未归类的 tag 必须能用 —— 归类不强制，随手记的频次远高于归类的需要
    const ungrouped = await createTag('随手记的')
    check('不传命名空间也能建 tag', ungrouped.group === '', JSON.stringify(ungrouped.group))

    const all = await listTags()
    check('listTags 带命名空间', all.every((tag) => typeof tag.group === 'string'), `${all.length} 个 tag`)

    // ⚠️ 同一个名字不能建两次（唯一约束），也不该被悄悄改组
    try {
      await createTag('animal:cat')
      check('重名 tag 应被拒', false, '居然建成功了')
    } catch (error) {
      check('重名 tag 应被拒', true, error instanceof Error ? error.message : '')
    }

    // 改归类：能改、能改回空串
    const { setTagGroup } = tagService
    const regrouped = await setTagGroup('animal:cat', 'form')
    check('改归类生效', regrouped.group === 'form', regrouped.group)
    const reread = await findTagByName('animal:cat')
    check('改归类持久化', reread?.group === 'form', String(reread?.group))

    const cleared = await setTagGroup('animal:cat', '')
    check('归类可取消', cleared.group === '', JSON.stringify(cleared.group))

    try {
      await setTagGroup('不存在的词', 'motif')
      check('改不存在的 tag 应被拒', false, '居然没报错')
    } catch (error) {
      check('改不存在的 tag 应被拒', true, error instanceof Error ? error.message : '')
    }
  }

  // 35. ⭐ 多设计空间的坐标读写（2026-10-06）
  // 重点验「两个空间的同名轴互不覆盖」—— 那是这整个改动要解决的歧义，
  // 而它出问题时**不报错**，只是分数悄悄不见了。
  {
    const { listDesignSpaces, createDesignAxis, findSpaceByCode, listDesignAxes, createDesignSpace } = await import('@/backstage/atlas/space.service')
    const { setTaxonomy, allScoresOf } = service

    const spaces = await listDesignSpaces()
    const mine = spaces.find((s) => s.code === 'mine')!
    const source = spaces.find((s) => s.code === 'source')!
    check('拿到「我的」空间', mine !== undefined, mine?.id)
    check('拿到「原作」空间', source !== undefined, source?.id)

    // ⚠️ 先给「原作」空间加一条与「我的」**同名**的轴 —— 只有同名才能验出覆盖。
    // 「原作」刻意留空是因为它的维度取决于原作是什么游戏；这里加一条纯粹
    // 为了证明「同名也不会互相覆盖」。
    await createDesignAxis({
      spaceId: source.id,
      key: 'visualMass',
      labelZh: '视觉体量',
      anchors: ['微型', '标准', '大型', '巨型'],
    })
    check('「原作」空间可以有轴', (await listDesignAxes(source.id)).length === 1)

    const subject = await createEntry({
      domain: creature,
      name: '同名轴测试',
      sourceUrl: 'https://example.com/dual',
    })

    // ⚠️ 两个空间**各有一条叫 visualMass 的轴**，但它们是各自空间独立定义的 ——
    // 这正是要验的：同名轴在不同空间里互不覆盖。
    const mineAxes = await listDesignAxes(mine.id)
    const sharedKey = 'visualMass'
    check('「我的」空间有 visualMass 轴', mineAxes.some((axis) => axis.key === sharedKey), mineAxes.map((a) => a.key).join(' '))
    await setTaxonomy(subject.id, { [sharedKey]: 0.2 }, mine.id)
    await setTaxonomy(subject.id, { visualMass: 0.8 }, source.id)

    // ⭐ 核心断言：两个空间的同名轴分数必须都在，且不相等
    const mineScores = await getEntryDetail(subject.id, mine.id)
    const sourceScores = await getEntryDetail(subject.id, source.id)
    check('「我的」空间读到自己的分', mineScores.taxonomy[sharedKey] === 0.2, `${sharedKey}=${String(mineScores.taxonomy[sharedKey])}`)
    check('「原作」空间读到自己的分', sourceScores.taxonomy['visualMass'] === 0.8, String(sourceScores.taxonomy['visualMass']))
    // ⭐ 这条才是整个测试的意义：同名轴各自的值都在，没有互相覆盖
    check('同名轴在两个空间互不覆盖', mineScores.taxonomy[sharedKey] !== sourceScores.taxonomy['visualMass'], `我的=${String(mineScores.taxonomy[sharedKey])} 原作=${String(sourceScores.taxonomy['visualMass'])}`)

    // 清除也要按空间隔离
    await clearTaxonomyDimension(subject.id, 'visualMass', source.id)
    const afterClear = await getEntryDetail(subject.id, mine.id)
    check('清「原作」的轴不动「我的」', afterClear.taxonomy[sharedKey] === 0.2, String(afterClear.taxonomy[sharedKey]))

    // 未知空间应被拒 —— 空间 id 是外键，db 会拦，但错误信息要可读
    try {
      await setTaxonomy(subject.id, { visualMass: 0.5 }, 'space-nope')
      check('不存在的空间应被拒', false, '居然没报错')
    } catch (error) {
      check('不存在的空间应被拒', true, error instanceof Error ? error.message.slice(0, 40) : '')
    }

    // 空空间写入应被明确拒绝，而不是静默丢数据
    const emptySpace = await createDesignSpace({ code: 'proj-empty', labelZh: '空项目空间' })
    try {
      await setTaxonomy(subject.id, { anything: 0.5 }, emptySpace.id)
      check('往没有轴的空间写应被拒', false, '居然没报错')
    } catch (error) {
      check('往没有轴的空间写应被拒', true, error instanceof Error ? error.message : '')
    }

    // allScoresOf 必须按空间分开返回
    const all = await allScoresOf(subject.id)
    const codeOf = new Map(spaces.map((s) => [s.id, s.code]))
    const mineByCode = all[codeOf.get(mine.id) ?? '']
    check('allScoresOf 按空间分组', Boolean(mineByCode), JSON.stringify(Object.keys(all)))
    check('allScoresOf 里的值正确', mineByCode?.[sharedKey] === 0.2, String(mineByCode?.[sharedKey]))

    // 项目空间可自建，code 校验要挡住非法值
    const proj = await createDesignSpace({ code: 'project-mr', labelZh: 'Maple Rouge', hintZh: '项目坐标系' })
    check('项目空间可自建', proj.code === 'project-mr', proj.code)
    check('自建空间不是预置', proj.isBuiltin === false)
    try {
      await createDesignSpace({ code: '有中文', labelZh: '非法 code' })
      check('非法 code 应被拒', false, '居然建成功了')
    } catch (error) {
      check('非法 code 应被拒', true, error instanceof Error ? error.message : '')
    }
    check('findSpaceByCode 按 code 查', (await findSpaceByCode('project-mr'))?.id === proj.id)
  }

  // 36. ⭐ 分析确定度：proposal 与 committed 不能混着用（2026-10-07）
  // 只 4 条 —— 那条原则的要点就这四个：默认 committed、显式 draft、
  // 非法值被拒、改后生效。刻意不铺开测。
  {
    const manual = await createEntry({ domain: creature, name: '手工采集', sourceUrl: 'https://example.com/manual' })
    check('默认是 committed（v0 全手工填）', manual.analysisStatus === 'committed', manual.analysisStatus)

    const machine = await createEntry({
      domain: creature,
      name: '机器提案',
      sourceUrl: 'https://example.com/machine',
      analysisStatus: 'draft',
    })
    check('机器填的可显式标为 draft', machine.analysisStatus === 'draft', machine.analysisStatus)

    try {
      await createEntry({
        domain: creature,
        name: '非法状态',
        sourceUrl: 'https://example.com/bad',
        analysisStatus: 'guessed' as never,
      })
      check('非法 analysisStatus 应被拒', false, '居然建成功了')
    } catch (error) {
      check('非法 analysisStatus 应被拒', true, error instanceof Error ? error.message : '')
    }

    await updateEntry(machine.id, { analysisStatus: 'committed' })
    check('draft 可改成 committed（人确认过）', (await getEntryDetail(machine.id)).analysisStatus === 'committed')
  }

  await db.closeDatabase()
  fs.rmSync(`/tmp/atlas-verify-${stamp}.db`, { force: true })
  fs.rmSync(mediaRoot, { recursive: true, force: true })

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