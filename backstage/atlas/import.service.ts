import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath } from '@/backstage/db/database'
import { allScoresOf, createEntry, entriesOrderedById, rememberImportedId, resolveImportedId, setAxisValues } from './entry.service'
import { attachSystemTag, findOrCreateTag, setEntryTagConfidence, setEntryTags, tagsForEntries } from './tag.service'
import { createDesignAxis, createDesignSpace, findSpaceByCode, listDesignAxes, listDesignSpaces } from './space.service'
import { exportStamp, EXPORT_FORMAT_VERSION, toExportTag, writeExport, type ExportAxis, type ExportEntry, type ExportManifest } from './export.service'
import { ENTRY_STATUSES, isDomainCode, type DomainCode, type EntryStatus } from '@/types/atlas'
import { isLicenseKey, isTrainable } from '@/options/licensing'

function toExportEntry(
  entry: Awaited<ReturnType<typeof entriesOrderedById>>[number],
  axisValuesBySpace: Record<string, Record<string, number>>,
): ExportEntry {
  return {
    id: entry.id,
    domain: entry.domain,
    name: entry.name,
    source: entry.source,
    author: entry.author,
    license: entry.license,
    trainable: entry.trainable,
    imagePath: entry.imagePath,
    imageSource: entry.imageSource,
    originalName: entry.originalName,
    observed: entry.observed,
    read: entry.read,
    worthwhileBecause: entry.worthwhileBecause,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags.map(toExportTag),
    axisValuesBySpace,
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
  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new Error(`导出包版本 ${manifest.formatVersion} 与当前版本 ${EXPORT_FORMAT_VERSION} 不符；请用对应版本显式转换。`)
  }
  if (!Array.isArray(manifest.spaces) || !Array.isArray(manifest.axes) || !Array.isArray(manifest.entries)) {
    throw new Error('导出包缺少当前版本必需的 spaces、axes 或 entries')
  }

  // ⚠️ **先建空间与坐标轴，再导条目。** 顺序反了会得到「有坐标但没轴定义」
  // 的数据 —— 那正是「看着成功、实则语义全丢」的状态。
  const spaceIdsByCode = new Map<string, string>()
  for (const space of manifest.spaces) {
    const existing = await findSpaceByCode(space.code)
    // ⚠️ 已存在就**复用**，不覆盖。本机的空间可能已经被编辑过（加了轴、改了
    // 描述），用包里的定义盖掉等于丢掉本机状态。
    spaceIdsByCode.set(space.code, existing?.id ?? (await createDesignSpace(space)).id)
  }
  for (const axis of manifest.axes) {
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
    if (!entry.axisValuesBySpace || typeof entry.axisValuesBySpace !== 'object' || !Array.isArray(entry.tags)) {
      throw new Error(`条目 ${entry.id ?? '未知'} 缺少 axisValuesBySpace 或 tags`)
    }
    const existingLocalId = await resolveImportedId(entry.id)
    if (existingLocalId) {
      summary.reused += 1
      continue
    }

    // ⚠️ domain 来自导入包，是不可信输入。认不出的 domain 直接跳过 ——
    // 硬塞会造出一条「domain 存在但没有扩展表」的数据，比不导更糟。
    if (!isDomainCode(entry.domain)) continue
    if (!ENTRY_STATUSES.includes(entry.status as EntryStatus)) throw new Error(`无效条目状态：${entry.status}`)
    if (!isLicenseKey(entry.license) || !isTrainable(entry.trainable)) throw new Error(`无效来源许可：${entry.id}`)
    for (const tag of entry.tags) {
      if (typeof tag.confidence !== 'number' || !Number.isFinite(tag.confidence) || tag.confidence < 0 || tag.confidence > 1) {
        throw new Error(`无效标签置信度：${tag.name}`)
      }
      if (tag.origin === 'system' && !tag.ruleId) throw new Error(`系统标签缺少规则：${tag.name}`)
    }

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
    const mineScores = entry.axisValuesBySpace['mine'] ?? {}
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
      source: entry.source,
      author: entry.author,
      license: entry.license,
      trainable: entry.trainable,
      imagePath: localPath,
      imageSource: entry.imageSource === 'paste' ? 'paste' : 'file',
      originalName: entry.originalName,
      observed: entry.observed,
      read: entry.read,
      worthwhileBecause: entry.worthwhileBecause,
      status: entry.status as EntryStatus,
      axisValues: Object.keys(mineValid).length > 0 ? mineValid : undefined,
      axisSpaceId: 'space-mine',
      extension: entry.extension ?? undefined,
    })
    await rememberImportedId(entry.id, created.id)

    // 其余空间（原作 / 项目）逐个写。⚠️ 每个空间都要按它自己的轴表过滤。
    for (const [code, scores] of Object.entries(entry.axisValuesBySpace)) {
      if (code === 'mine') continue // 已在 createEntry 里写掉
      const spaceId = spaceIdsByCode.get(code)
      if (!spaceId) continue // 空间没建出来（包坏了或本机已有同 code 的不同空间）
      const axisKeys = new Set((await listDesignAxes(spaceId)).map((axis) => axis.key))
      const valid: Record<string, number> = {}
      for (const [key, value] of Object.entries(scores)) {
        if (axisKeys.has(key) && typeof value === 'number' && !Number.isNaN(value)) valid[key] = value
      }
      if (Object.keys(valid).length > 0) await setAxisValues(created.id, valid, spaceId)
    }

    // ⚠️ tag 分两批挂：origin='system' 的走 attachSystemTag（要求 ruleId 非空，
    // 且保住 origin）。混在一起批量挂会把系统 tag 降级成 user —— origin 就白存了。
    const userNames = entry.tags.filter((tag) => tag.origin !== 'system').map((tag) => tag.name)
    if (userNames.length > 0) {
      const resolved = await Promise.all(userNames.map((name) => findOrCreateTag(name)))
      const current = (await tagsForEntries([created.id])).get(created.id) ?? []
      const merged = [...current.map((item) => item.id)]
      for (const tag of resolved) if (!merged.includes(tag.id)) merged.push(tag.id)
      await setEntryTags(created.id, merged, true)
    }
    for (const tag of entry.tags) {
      if (tag.origin === 'system' && tag.ruleId) {
        await attachSystemTag(created.id, tag.name, tag.ruleId)
      }
    }
    const savedTags = (await tagsForEntries([created.id])).get(created.id) ?? []
    for (const tag of entry.tags) {
      const saved = savedTags.find((item) => item.name === tag.name)
      if (!saved) throw new Error(`导入标签关联失败：${tag.name}`)
      await setEntryTagConfidence(created.id, saved.id, tag.confidence)
    }

    summary.created += 1
    summary.byDomain[entry.domain] = (summary.byDomain[entry.domain] ?? 0) + 1
  }

  return summary
}
