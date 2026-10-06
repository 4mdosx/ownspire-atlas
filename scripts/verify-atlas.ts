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
  const { attachEntryTagsByName, attachSystemTag, detachEntryTag, findTagByName, tagsForEntries, detachSystemTagsByRule } = tagService
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

  console.log('\n— 未打标 · 来源可选 · 图片可选 —')

  // ① 未打标：强制 tag 的反面 ——「先存下来、标签回头补」必须是可行的
  {
    const untagged = await createEntry({ domain: creature, name: '无标条目', sourceUrl: src })
    const tagged = await createEntry({ domain: creature, name: '有标条目', sourceUrl: src, tagNames: ['bird', 'plant'] })

    check('无 tag 也能创建（tags 不强制）', untagged.tags.length === 0)
    check('有 tag 也能创建', tagged.tags.length === 2, tagged.tags.map((t) => t.name).join(' '))

    // 收口靠视图而不是纪律：欠账要能在界面上被看见
    const onlyUntagged = await listEntries({ untagged: true })
    check('untagged 筛选只返回无标条目', onlyUntagged.length === 1 && onlyUntagged[0].id === untagged.id, `${onlyUntagged.length} 条`)
    check('untaggedCount 与筛选一致', (await untaggedCount()) === 1)

    // ⚠️ 未打标与具体标签**互斥** —— 两者同时给会让「筛选没生效」还是
    // 「筛选太严」说不清。前端已先切模式，但后端也必须拒。
    try {
      await listEntries({ untagged: true, tagNames: ['bird'] })
      check('untagged 与具体 tag 应互斥', false, '居然没报错')
    } catch (error) {
      check('untagged 与具体 tag 应互斥', true, error instanceof Error ? error.message : '')
    }

    // ⚠️ 给**无标那条**补标签 —— `untagged` 与 `tagNames` 互斥，所以一次只能测一侧。
    // attachEntryTagsByName 是**只加不删**的（凡叫 attach* 的都这样）。
    await attachEntryTagsByName(untagged.id, ['insect'])
    check('补标签后从未打标消失', (await listEntries({ untagged: true })).length === 0)
    check('untaggedCount 归零', (await untaggedCount()) === 0)

    // 摘标 → 欠账回来。**往返**才是完整闭环，只测单向会漏掉「摘标后状态
    // 没同步」这类 bug。
    await detachEntryTag(untagged.id, (await findTagByName('insect'))!.id)
    check('摘掉标签后重新出现在未打标', (await listEntries({ untagged: true })).some((e) => e.id === untagged.id))

    // updateEntry 的 tagNames 是**替换**语义 —— 给空数组等于摘光全部用户标签
    const replaced = await updateEntry(tagged.id, { tagNames: ['bird'] })
    check('tagNames 是替换语义（给新列表= 只剩它）', replaced.tags.length === 1 && replaced.tags[0].name === 'bird', replaced.tags.map((t) => t.name).join(' '))

    check('findTagByName 大小写不敏感', (await findTagByName('BIRD')) !== null)
    check('未打标可与搜索叠加', (await listEntries({ untagged: true, q: '无标' })).length === 1)
    check('状态计数正常', (await statusCounts()).inbox === 2, JSON.stringify(await statusCounts()))
  }

  console.log('\n— origin：系统 tag 与用户 tag 的边界 —')

  // ② origin 存在的全部理由：用户编辑标签时**不能把系统 tag 抹掉**
  {
    const entry = await createEntry({ domain: creature, name: '来源标记', sourceUrl: src, tagNames: ['blob'] })
    await attachSystemTag(entry.id, 'boss', 'proj:alpha')
    await attachSystemTag(entry.id, 'elite', 'proj:beta')

    const sysTag = (await getEntryDetail(entry.id)).tags.find((t) => t.ruleId === 'proj:alpha')
    check('系统 tag origin=system 且保留 ruleId', sysTag?.origin === 'system' && sysTag?.ruleId === 'proj:alpha', `origin=${sysTag?.origin}`)

    // ⚠️ **这条是本组存在的理由**。updateEntry 的 tagNames 是替换语义，
    // 而它**只该替换 origin=user 的那些** —— 漏了这个 includeSystem 的实现
    // 会在用户改一次标签后把项目标记悄悄抹掉，而症状是「筛选结果少了东西」。
    const edited = await updateEntry(entry.id, { tagNames: ['blob', 'newtag'] })
    check('用户改标签后系统 tag 仍在', edited.tags.some((t) => t.origin === 'system' && t.ruleId === 'proj:alpha'), JSON.stringify(edited.tags.map((t) => `${t.name}:${t.origin}`)))
    check('用户 tag 已按替换语义更新', edited.tags.some((t) => t.name === 'newtag'))

    check('origin=system 筛出系统 tag 条目', (await listEntries({ origin: 'system' })).some((e) => e.id === entry.id))
    check('按 ruleId 精确查', (await listEntries({ origin: 'system', ruleId: 'proj:beta' })).some((e) => e.id === entry.id))

    // 同一个 tag 在不同条目上origin 可以不同 —— origin 挂在关联上，不在词上
    const other = await createEntry({ domain: creature, name: '另一条', sourceUrl: src, tagNames: ['boss'] })
    const otherTag = (await getEntryDetail(other.id)).tags.find((t) => t.name === 'boss')
    check('同一 tag 在不同条目 origin 可不同', otherTag?.origin === 'user', `origin=${otherTag?.origin}`)

    check('detachSystemTagsByRule 按 ruleId 摘（不接 entryId）', (await detachSystemTagsByRule('proj:alpha')) === 1)
    check('另一条规则的没被波及（全局删只碰该 ruleId）', (await getEntryDetail(entry.id)).tags.some((t) => t.ruleId === 'proj:beta'))
  }

  console.log('\n— 星级 ⇆ score 映射 —')

  // ③ 星级是**显示编码**，不是数据
  {
    const { starsToScore, scoreToStars, TAXONOMY_STEPS } = atlas
    check('starsToScore(3)=0.6', Math.abs(starsToScore(3) - 0.6) < 1e-9, String(starsToScore(3)))
    check('往返一致（半星可点）', scoreToStars(starsToScore(2.5)) === 3, `2.5 星 → ${starsToScore(2.5)} → ${scoreToStars(starsToScore(2.5))} 星`)
    // ⚠️ 5 星 + 半星 = **6 个可点值**，不是 11 档。11 档对应 0.1 步进，
    // 那是滑杆的精度 —— 两个概念混了就会出现「11 个星星」的界面。
    check('半星只给 6 个可点值（≠ 11 档）', TAXONOMY_STEPS.length === 6, `${TAXONOMY_STEPS.length} 档：${TAXONOMY_STEPS.join(' ')}`)
  }

  console.log('\n— 坐标：sparse · 0 分与未打分的区别 —')

  // ④ 「没打过分」≠「打了 0 分」—— **这是 sparse 表存在的全部理由**
  {
    const entry = await createEntry({ domain: creature, name: '打分测试', sourceUrl: src })
    await setTaxonomy(entry.id, { visualMass: 0.8, shapeLanguage: 0.4 })
    const detail = await getEntryDetail(entry.id)
    check('taxonomy 只存给了的维度（sparse）', Object.keys(detail.taxonomy).length === 2, JSON.stringify(detail.taxonomy))
    check('0.8 存进去还是 0.8', detail.taxonomy.visualMass === 0.8)
    check('没打分的维度不出现在结果里', detail.taxonomy.familiarity === undefined)

    await setTaxonomy(entry.id, { threatAffinity: 0 })
    const withZero = await getEntryDetail(entry.id)
    check(
      '显式 0 分要与「没打过分」可区分',
      withZero.taxonomy.threatAffinity === 0 && Object.keys(withZero.taxonomy).length === 3,
      `${Object.keys(withZero.taxonomy).length} 个维度`,
    )

    await clearTaxonomyDimension(entry.id, 'shapeLanguage')
    check('清除维度后只剩 2 个', Object.keys((await getEntryDetail(entry.id)).taxonomy).length === 2)

    try {
      await setTaxonomy(entry.id, { nosuchdimension: 0.5 } as never)
      check('陌生维度应被拒绝', false, '居然没报错')
    } catch (error) {
      check('陌生维度应被拒绝', true, error instanceof Error ? error.message : '')
    }
  }

  console.log('\n— domain 分流 · 图片路径安全 —')

  // ⑤ domain 分流 + 媒体路径
  {
    const entry = await createEntry({ domain: creature, name: '分流测试', sourceUrl: src })
    check('creature 条目自动建扩展行', (await getEntryDetail(entry.id)).extension !== null)
    check('domain=creature 筛出条目', (await listEntries({ domain: creature })).some((e) => e.id === entry.id))
    check('domain=未知名返回空而不报错', (await listEntries({ domain: 'nope' as never })).length === 0)
    check('换到同 domain 是幂等的', (await changeDomain(entry.id, creature)).domain === creature)

    // imagePath 从 v0.2 起可空 —— 没有图的条目照样能存（缺失图不该阻塞采集）
    const noImage = await createEntry({ domain: creature, name: '无图条目', sourceUrl: src })
    check('没有图片也能创建', noImage.imagePath === '', `imagePath="${noImage.imagePath}"`)

    // ⚠️ **路径逃逸必须在写入侧被拒**。`imagePath` 来自用户输入（粘贴、
    // 手工填写），`../` 能写到 media 根之外 —— 那是任意文件写。
    for (const bad of ['/etc/passwd', '../../escape.png', 'verify/../../../escape.png']) {
      try {
        await updateEntry(noImage.id, { imagePath: bad })
        check(`路径逃逸应被拒：${bad.slice(0, 24)}`, false, '居然成功了')
      } catch {
        check(`路径逃逸应被拒：${bad.slice(0, 24)}`, true)
      }
    }

    try {
      await createEntry({ domain: creature, name: '无来源', sourceUrl: '' })
      check('来源应必填（它是唯一的硬约束）', false, '居然建成功了')
    } catch (error) {
      check('来源应必填（它是唯一的硬约束）', true, error instanceof Error ? error.message : '')
    }
  }

  // 29. 维度分组的完整性
  //
  // ⚠️ 守的是**静默丢失**：渲染按 group 遍历维度，漏声明 group 的维度会在
  // 界面上整块消失而不报错。所以要验「不重不漏」，而不是逐个点名。
  {
    const { dimensionsOf, groupsOf, dimensionsInGroup } = atlas
    const all = dimensionsOf(creature)
    const groupKeys = new Set(groupsOf(creature).map((group) => group.key))

    check(
      '每个维度都有归属 group（漏声明 = 界面上整块消失）',
      all.every((dimension) => groupKeys.has(dimension.group)),
      all.filter((d) => !groupKeys.has(d.group)).map((d) => d.key).join(',') || '无孤儿',
    )
    check(
      '没有空 group',
      groupsOf(creature).every((group) => dimensionsInGroup(creature, group.key).length > 0),
      groupsOf(creature)
        .filter((g) => dimensionsInGroup(creature, g.key).length === 0)
        .map((g) => g.key)
        .join(','),
    )

    const grouped = groupsOf(creature).flatMap((group) => [...dimensionsInGroup(creature, group.key)])
    check(
      '分组不重不漏（分组是纯归类）',
      grouped.length === all.length && new Set(grouped.map((d) => d.key)).size === all.length,
      `平铺 ${all.length} · 分组 ${grouped.length}`,
    )
  }

  // 29b. ⭐ 退役轴的回归守卫（2026-10-07）
  //
  // ⚠️ **这五条守的是不可逆的架构决定**。它们回来必须是有意识的决定，
  // 而不是某次重构顺手带回来的：
  //
  // · combat / role —— 属关卡玩法，不属造型（同一只怪第 3 关是 fodder、
  //   第 40 关是 elite，那说明 role 是用法不是属性）
  // · form —— 它是**归类**不是刻度，已降级成 tag 分组
  // · palette —— 它是特征描述，改成 observed 里的观察项
  // · mobility —— 它是动作语言，划给 Animation domain
  //
  // ⚠️ 一条断言顶五条：只验「这五个 key 一个都不在轴列表里」，不逐个点名 ——
  // 逐个点名的代价是每加一根新轴都要改测试，而那会让人懒得加轴。
  {
    const retired = ['combat', 'role', 'form', 'palette', 'mobility']
    const keys = new Set(atlas.dimensionsOf(creature).map((d: { key: string }) => d.key))
    const back = retired.filter((key) => keys.has(key))
    check('退役的五根轴都不该回来', back.length === 0, back.join(' '))
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

  // 35. ⭐ 多设计空间的坐标读写
  //
  // ⚠️ 核心只有一件事：**同名轴在不同空间里互不覆盖**。那是整个多空间设计
  // 要消除的歧义，而它出问题时**不报错**，只是分数悄悄不见了。
  // 所以下面只围绕它组织，其余是必要的边界。
  {
    const { listDesignSpaces, createDesignAxis, findSpaceByCode, listDesignAxes, createDesignSpace } =
      await import('@/backstage/atlas/space.service')
    const { setTaxonomy, clearTaxonomyDimension, allScoresOf } = service

    const spaces = await listDesignSpaces()
    const mine = spaces.find((s) => s.code === 'mine')!
    const source = spaces.find((s) => s.code === 'source')!
    check('预置两个空间且「我的」排在前面（采集时最常写它）', mine !== undefined && source !== undefined && mine.sortOrder < source.sortOrder)

    // ⚠️ 先给「原作」加一条与「我的」**同名**的轴 —— 只有同名才能验出覆盖。
    //「原作」刻意留空是因为它的维度取决于原作是什么游戏；这里加一条纯粹
    // 为了证明「同名也不覆盖」。
    await createDesignAxis({
      spaceId: source.id,
      key: 'visualMass',
      labelZh: '视觉体量',
      anchors: ['微型', '标准', '大型', '巨型'],
    })

    const subject = await createEntry({ domain: creature, name: '同名轴测试', sourceUrl: 'https://example.com/dual' })
    const shared = 'visualMass'
    await setTaxonomy(subject.id, { [shared]: 0.2 }, mine.id)
    await setTaxonomy(subject.id, { [shared]: 0.8 }, source.id)

    // ⭐ 三条断言就是这一组的全部意义
    const mineScores = await getEntryDetail(subject.id, mine.id)
    const sourceScores = await getEntryDetail(subject.id, source.id)
    check('「我的」读到 0.2', mineScores.taxonomy[shared] === 0.2, String(mineScores.taxonomy[shared]))
    check('「原作」读到 0.8', sourceScores.taxonomy[shared] === 0.8, String(sourceScores.taxonomy[shared]))
    check(
      '同名轴互不覆盖（这一组的核心）',
      mineScores.taxonomy[shared] !== sourceScores.taxonomy[shared],
      `我的=${String(mineScores.taxonomy[shared])} 原作=${String(sourceScores.taxonomy[shared])}`,
    )

    // 清除要按空间隔离 —— 否则在「原作」视图点清除会删掉「我的」那一行
    await clearTaxonomyDimension(subject.id, shared, source.id)
    const afterClear = await getEntryDetail(subject.id, mine.id)
    check('清「原作」不动「我的」', afterClear.taxonomy[shared] === 0.2, String(afterClear.taxonomy[shared]))

    // ⚠️ 非法输入必须被拒，而**不是因为外键约束报错** —— 错误信息要能指到
    // 「你传了个不存在的空间」。所以这里验的是被拒，不是崩了。
    const emptySpace = await createDesignSpace({ code: 'proj-empty', labelZh: '空项目空间' })
    const rejects: Array<[string, () => Promise<unknown>]> = [
      ['不存在的空间', () => setTaxonomy(subject.id, { [shared]: 0.5 }, 'space-nope')],
      ['往没有轴的空间写', () => setTaxonomy(subject.id, { anything: 0.5 }, emptySpace.id)],
      ['非法的空间 code', () => createDesignSpace({ code: '有中文', labelZh: '非法 code' })],
    ]
    for (const [label, run] of rejects) {
      try {
        await run()
        check(`${label}应被拒`, false, '居然没报错')
      } catch (error) {
        check(`${label}应被拒`, true, error instanceof Error ? error.message : '')
      }
    }

    // allScoresOf 是导出用的：它返回的 key 必须是空间 **code**（跨机器稳定），
    // 而不是 id（本地数据）。用错会让导出的包换台机器就对不上。
    const all = await allScoresOf(subject.id)
    check('allScoresOf 的 key 是空间 code 而非 id', Boolean(all.mine) && all['space-mine'] === undefined, Object.keys(all).join(' '))
    check('allScoresOf 的值正确', all.mine?.[shared] === 0.2, String(all.mine?.[shared]))

    // 项目空间可自建 —— 「按项目再放坐标」是设计空间存在的理由之一
    const proj = await createDesignSpace({ code: 'project-mr', labelZh: 'Maple Rouge' })
    check('项目空间可自建且非预置', proj.code === 'project-mr' && proj.isBuiltin === false, proj.code)
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