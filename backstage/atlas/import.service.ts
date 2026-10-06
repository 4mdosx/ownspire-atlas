import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath } from '@/backstage/db/database'
import { createEntry, entriesOrderedById, rememberImportedId, resolveImportedId } from './entry.service'
import { attachSystemTag, findOrCreateTag, setEntryTags, tagsForEntries } from './tag.service'
import { exportStamp, toExportTag, writeExport, type ExportEntry, type ExportManifest } from './export.service'
import { dimensionKeysOf, ENTRY_STATUSES, isDomainCode, type DomainCode, type EntryStatus, type TaxonomyDimensionKey } from '@/types/atlas'

function toExportEntry(entry: Awaited<ReturnType<typeof entriesOrderedById>>[number]): ExportEntry {
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
    notes: entry.notes,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags.map(toExportTag),
    taxonomy: entry.taxonomy,
    extension: entry.extension,
  }
}

/**
 * 导出。
 *
 * @param domain 不给就导出全部。给了就只导那一个库 —— 「只把怪物这库搬过去」
 *  是个真实需求（换一个项目的库）。
 */
export async function exportAll(domain?: DomainCode) {
  const entries = await entriesOrderedById(domain)
  const root = await writeExport(entries.map(toExportEntry), exportStamp())
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
  if (manifest.formatVersion !== 2) {
    throw new Error(
      manifest.formatVersion === 1
        ? '这是 v0.1 的老导出包（formatVersion 1），当前版本是 2。老包没有 domain / taxonomy / tag 来源信息，无法无损导入。'
        : `不认识的包版本：${manifest.formatVersion}`,
    )
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

    const allowed = new Set<string>(dimensionKeysOf(entry.domain))
    const taxonomy: Partial<Record<TaxonomyDimensionKey, number>> = {}
    for (const [key, value] of Object.entries(entry.taxonomy ?? {})) {
      if (allowed.has(key) && typeof value === 'number' && !Number.isNaN(value)) {
        taxonomy[key as TaxonomyDimensionKey] = value
      }
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
      notes: entry.notes,
      // ⚠️ status 来自导入包，是不可信输入。不能直接 `as EntryStatus` 断言 ——
      // createEntry 里的 assertStatus 只在字段存在时校验，传 undefined 就跳过了。
      // 所以这里显式过滤：认得的才给，不认得的走默认 inbox。
      status: ENTRY_STATUSES.includes(entry.status as EntryStatus) ? (entry.status as EntryStatus) : undefined,
      taxonomy,
      extension: entry.extension ?? undefined,
    })
    await rememberImportedId(entry.id, created.id)

    // ⚠️ tag 分两批挂：origin='system' 的走 attachSystemTag（要求 ruleId 非空，
    // 且保住 origin）。混在一起批量挂会把系统 tag 降级成 user —— origin 就白存了。
    const userNames = (entry.tags ?? []).filter((tag) => tag.origin !== 'system').map((tag) => tag.name)
    if (userNames.length > 0) {
      const resolved = await Promise.all(userNames.map(findOrCreateTag))
      const current = (await tagsForEntries([created.id])).get(created.id) ?? []
      const merged = [...current.map((item) => item.id)]
      for (const tag of resolved) if (!merged.includes(tag.id)) merged.push(tag.id)
      await setEntryTags(created.id, merged, true)
    }
    for (const tag of entry.tags ?? []) {
      if (tag.origin === 'system' && tag.ruleId) await attachSystemTag(created.id, tag.name, tag.ruleId)
    }

    summary.created += 1
    summary.byDomain[entry.domain] = (summary.byDomain[entry.domain] ?? 0) + 1
  }

  return summary
}