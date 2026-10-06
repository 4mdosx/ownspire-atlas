import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath } from '@/backstage/db/database'
import { allScoresOf, createEntry, entriesOrderedById, rememberImportedId, resolveImportedId, setTaxonomy } from './entry.service'
import { attachSystemTag, findOrCreateTag, setEntryTags, tagsForEntries } from './tag.service'
import { createDesignAxis, createDesignSpace, findSpaceByCode, listDesignAxes, listDesignSpaces } from './space.service'
import { exportStamp, EXPORT_FORMAT_VERSION, toExportTag, writeExport, type ExportAxis, type ExportEntry, type ExportManifest } from './export.service'
import { ENTRY_STATUSES, isDomainCode, isTagGroupKey, type DomainCode, type EntryStatus, type TagGroup } from '@/types/atlas'

function toExportEntry(
  entry: Awaited<ReturnType<typeof entriesOrderedById>>[number],
  scoresBySpace: Record<string, Record<string, number>>,
): ExportEntry {
  return {
    id: entry.id,
    domain: entry.domain,
    name: entry.name,
    sourceUrl: entry.sourceUrl,
    sourceTitle: entry.sourceTitle,
    sourceGame: entry.sourceGame,
    imagePath: entry.imagePath,
    imageSource: entry.imageSource,
    originalName: entry.originalName,
    // ⚠️ notes 恒为空 —— v3 起它已经被 observed / read 取代。见 export.service.ts。
    observed: entry.observed,
    read: entry.read,
    worthwhileBecause: entry.worthwhileBecause,
    notes: '',
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags.map(toExportTag),
    scoresBySpace,
    extension: entry.extension,
  }
}

/**
 * 导出。
 *
 * @param domain 不给就导出全部。给了就只导那一个库 —— 「只把怪物这库搬过去」
 *  是个真实需求（换一个项目的库）。
 *
 * ⚠️ **空间与轴定义跟着一起导出**（v4起）。坐标是 0–1 浮点数，不带档位词的
 * 包换台机器导入就只剩「0.42」，而没人知道那代表 giant 还是 high mobility ——
 * 看着成功、实则丢掉了全部语义。
 *
 * ⚠️ **每条 entry 都要带全部空间的坐标**，不能只带「我的」：导出包的用途是
 * 「完整搬走」，只带一组等于在导出时静默丢弃另外几组。
 */
export async function exportAll(domain?: DomainCode) {
  const entries = await entriesOrderedById(domain)
  const spaces = await listDesignSpaces()

  const axes: ExportAxis[] = []
  for (const space of spaces) {
    for (const axis of await listDesignAxes(space.id)) {
      axes.push({
        spaceCode: space.code,
        key: axis.key,
        labelZh: axis.labelZh,
        labelEn: axis.labelEn,
        hintZh: axis.hintZh,
        groupLabelZh: axis.group.labelZh,
        groupLabelEn: axis.group.labelEn,
        anchors: axis.anchors,
        sortOrder: axis.sortOrder,
      })
    }
  }

  const exported: ExportEntry[] = []
  for (const entry of entries) {
    // ⚠️ allScoresOf 的 key 已经是空间 **code** —— 不用在这里再转换。
    // 一次导出里只做一次转换，就少一处可能把本地 id 漏进去的地方，
    // 而那种错误在导入时才显形（症状是「导入了但坐标全丢」）。
    exported.push(toExportEntry(entry, await allScoresOf(entry.id)))
  }

  const root = await writeExport(
    exported,
    exportStamp(),
    spaces.map((space) => ({
      code: space.code,
      labelZh: space.labelZh,
      labelEn: space.labelEn,
      hintZh: space.hintZh,
      sortOrder: space.sortOrder,
      isBuiltin: space.isBuiltin,
    })),
    axes,
  )
  return { root, count: entries.length, domain: domain ?? 'all' }
}

/**
 * 导入。
 *
 * ⚠️ 幂等是硬要求：同一个包导入两次必须得到同一条目，不能产生两份。
 * 靠 import_id_map 实现 —— 包里的 id 是外部 id，先查映射表，命中就复用本地 id。
 * 这张表不进导出包（它是导入机制的内部状态，不是数据）。
 *
 * 合并策略是「本地已有的字段优先保留」：导入只填补空字段，不覆盖已填内容。
 * 理由：导出包通常是旧快照，拿旧数据覆盖新记录是数据丢失的一种。
 */
export async function importFrom(root: string) {
  const manifestPath = path.join(root, 'manifest.json')
  let manifest: ExportManifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('这个目录里没有可读的 manifest.json')
  }
  // ⚠️ **不猜，不兼容就报错。** 每个旧版本都因为**不同的**原因无法无损
  // 导入，错误信息必须说清是哪一种 —— 笼统说「版本不对」会让人以为是文件坏了。
  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    const current = EXPORT_FORMAT_VERSION
    throw new Error(
      manifest.formatVersion === 1
        ? `这是 v0.1 的老导出包（formatVersion 1），当前是 ${current}。老包没有 domain / 坐标 / tag 来源信息，无法无损导入。`
        : manifest.formatVersion === 2
          ? `这是 v0.2 的导出包（formatVersion 2），当前是 ${current}。老包的 notes 里观察与判断混在一起，`
            + '自动拆分只能靠猜 —— 猜错等于把我的判断当原作事实存下来。要导入请先把 notes 手工拆成 observed / read。'
          : manifest.formatVersion === 3
            ? `这是 v0.3 的导出包（formatVersion 3），当前是 ${current}。老包只有**单一空间**的坐标，`
              + '导进多空间模型会被当成「我的」那一组 —— 原作与项目坐标会被静默丢弃，那比报错糟得多。'
            : `不认识的包版本：${manifest.formatVersion}（当前 ${current}）`,
    )
  }

  // ⚠️ **先建空间与坐标轴，再导条目。** 顺序反了会得到「有坐标但没轴定义」
  // 的数据 —— 那正是「看着成功、实则语义全丢」的状态。
  const spaceIdsByCode = new Map<string, string>()
  for (const space of manifest.spaces ?? []) {
    const existing = await findSpaceByCode(space.code)
    // ⚠️ 已存在就**复用**，不覆盖。本机的空间可能已经被编辑过（加了轴、改了
    // 描述），用包里的定义盖掉等于丢掉本机状态。
    spaceIdsByCode.set(space.code, existing?.id ?? (await createDesignSpace(space)).id)
  }
  for (const axis of manifest.axes ?? []) {
    const spaceId = spaceIdsByCode.get(axis.spaceCode)
    if (!spaceId) continue
    const existingAxes = await listDesignAxes(spaceId)
    if (existingAxes.some((item) => item.key === axis.key)) continue
    await createDesignAxis({
      spaceId,
      key: axis.key,
      labelZh: axis.labelZh,
      labelEn: axis.labelEn,
      hintZh: axis.hintZh,
      groupLabelZh: axis.groupLabelZh,
      groupLabelEn: axis.groupLabelEn,
      anchors: axis.anchors,
    })
  }

  const mediaBase = path.join(root, 'media')
  const stamp = exportStamp()
  const summary = { created: 0, reused: 0, missingImage: 0, byDomain: {} as Record<string, number> }

  for (const entry of manifest.entries) {
    const existingLocalId = await resolveImportedId(entry.id)
    if (existingLocalId) {
      summary.reused += 1
      continue
    }

    // ⚠️ domain 来自导入包，是不可信输入。认不出的 domain 直接跳过 ——
    // 硬塞会造出一条「domain 存在但没有扩展表」的数据，比不导更糟。
    if (!isDomainCode(entry.domain)) continue

    // 图片先落盘 —— 有图的才落。
    // ⚠️ imagePath 从 v0.2 起可空：没有图的条目照样导入，别因为缺图丢掉整条记录。
    let localPath = ''
    if (entry.imagePath) {
      try {
        const from = path.join(mediaBase, entry.imagePath)
        const relative = `imported-${stamp}-${path.basename(entry.imagePath)}`
        const to = resolveMediaPath(relative)
        await fs.copyFile(from, to)
        localPath = relative
      } catch {
        summary.missingImage += 1
      }
    }

    // ⚠️ **坐标在 createEntry 之后单独写** —— 因为它按空间分组，而 createEntry
    // 只接受一个空间。逐空间写才不至于把「原作」与「我的」混成一组。
    const mineScores = entry.scoresBySpace?.['mine'] ?? {}
    // ⚠️ 只取该空间**实际定义过**的轴 —— 包里的坐标是不可信输入，塞一条
    // 不存在的轴会得到「有分数但界面上没有那一行」的幽灵数据。
    const mineAxes = new Set((await listDesignAxes(spaceIdsByCode.get('mine') ?? 'space-mine')).map((axis) => axis.key))
    const mineValid: Record<string, number> = {}
    for (const [key, value] of Object.entries(mineScores)) {
      if (mineAxes.has(key) && typeof value === 'number' && !Number.isNaN(value)) mineValid[key] = value
    }

    const created = await createEntry({
      domain: entry.domain,
      name: entry.name,
      sourceUrl: entry.sourceUrl,
      sourceTitle: entry.sourceTitle,
      sourceGame: entry.sourceGame,
      imagePath: localPath,
      imageSource: entry.imageSource === 'paste' ? 'paste' : 'file',
      originalName: entry.originalName,
      // ⚠️ observed 同时接受 notes：v3 的包里 notes 恒为空，但手工编辑过的
      // 包可能有。observed 优先，两者都给时以 observed 为准。
      observed: entry.observed || entry.notes || '',
      read: entry.read ?? '',
      worthwhileBecause: entry.worthwhileBecause ?? '',
      // ⚠️ status 来自导入包，是不可信输入。不能直接 `as EntryStatus` 断言 ——
      // createEntry 里的 assertStatus 只在字段存在时校验，传 undefined 就跳过了。
      // 所以这里显式过滤：认得的才给，不认得的走默认 inbox。
      status: ENTRY_STATUSES.includes(entry.status as EntryStatus) ? (entry.status as EntryStatus) : undefined,
      taxonomy: Object.keys(mineValid).length > 0 ? mineValid : undefined,
      taxonomySpaceId: 'space-mine',
      extension: entry.extension ?? undefined,
    })
    await rememberImportedId(entry.id, created.id)

    // 其余空间（原作 / 项目）逐个写。⚠️ 每个空间都要按它自己的轴表过滤。
    for (const [code, scores] of Object.entries(entry.scoresBySpace ?? {})) {
      if (code === 'mine') continue // 已在 createEntry 里写掉
      const spaceId = spaceIdsByCode.get(code)
      if (!spaceId) continue // 空间没建出来（包坏了或本机已有同 code 的不同空间）
      const axisKeys = new Set((await listDesignAxes(spaceId)).map((axis) => axis.key))
      const valid: Record<string, number> = {}
      for (const [key, value] of Object.entries(scores)) {
        if (axisKeys.has(key) && typeof value === 'number' && !Number.isNaN(value)) valid[key] = value
      }
      if (Object.keys(valid).length > 0) await setTaxonomy(created.id, valid, spaceId)
    }

    // ⚠️ tag 分两批挂：origin='system' 的走 attachSystemTag（要求 ruleId 非空，
    // 且保住 origin）。混在一起批量挂会把系统 tag 降级成 user —— origin 就白存了。
    // ⚠️ group 同样来自导入包，是不可信输入：认得的才给，不认得的走空串。
    const groups = new Map<string, TagGroup>()
    for (const tag of entry.tags ?? []) {
      groups.set(tag.name, isTagGroupKey(tag.group) ? tag.group : '')
    }

    const userNames = (entry.tags ?? []).filter((tag) => tag.origin !== 'system').map((tag) => tag.name)
    if (userNames.length > 0) {
      const resolved = await Promise.all(userNames.map((name) => findOrCreateTag(name, groups.get(name) ?? '')))
      const current = (await tagsForEntries([created.id])).get(created.id) ?? []
      const merged = [...current.map((item) => item.id)]
      for (const tag of resolved) if (!merged.includes(tag.id)) merged.push(tag.id)
      await setEntryTags(created.id, merged, true)
    }
    for (const tag of entry.tags ?? []) {
      if (tag.origin === 'system' && tag.ruleId) {
        // 系统 tag 也补group —— 它同样是 tag，命名空间对它一视同仁。
        await attachSystemTag(created.id, tag.name, tag.ruleId, groups.get(tag.name) ?? '')
      }
    }

    summary.created += 1
    summary.byDomain[entry.domain] = (summary.byDomain[entry.domain] ?? 0) + 1
  }

  return summary
}