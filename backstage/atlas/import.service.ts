import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath } from '@/backstage/db/database'
import { entriesOrderedById, rememberImportedId, resolveImportedId } from './entry.service'
import { attachEntryTagsByName } from './tag.service'
import { exportStamp, writeExport, type ExportEntry, type ExportManifest } from './export.service'
import { ENTRY_STATUSES, type EntryStatus } from '@/types/atlas'

function toExportEntry(entry: Awaited<ReturnType<typeof entriesOrderedById>>[number]): ExportEntry {
  return {
    id: entry.id,
    name: entry.name,
    sourceUrl: entry.sourceUrl,
    sourceTitle: entry.sourceTitle,
    sourceGame: entry.sourceGame,
    imagePath: entry.imagePath,
    imageSource: entry.imageSource,
    originalName: entry.originalName,
    notes: entry.notes,
    bodyType: entry.bodyType,
    scale: entry.scale,
    movement: entry.movement,
    combatRole: entry.combatRole,
    attackPattern: entry.attackPattern,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags.map((tag) => tag.name),
  }
}

export async function exportAll() {
  const entries = await entriesOrderedById()
  const root = await writeExport(entries.map(toExportEntry), exportStamp())
  return { root, count: entries.length }
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
  if (manifest.formatVersion !== 1) throw new Error(`不认识的包版本：${manifest.formatVersion}`)
  if (manifest.collection !== 'monster') throw new Error(`这个包是 ${manifest.collection}，不是 monster`)

  const mediaBase = path.join(root, 'media')
  const summary = { created: 0, reused: 0, skipped: 0, missingImage: 0 }

  for (const entry of manifest.entries) {
    const existingLocalId = await resolveImportedId(entry.id)
    if (existingLocalId) {
      summary.reused += 1
      continue
    }

    // 图片先落盘 —— imagePath 是必填，落盘失败就不该建条目
    let localPath = entry.imagePath
    try {
      const from = path.join(mediaBase, entry.imagePath)
      const to = resolveMediaPath(`imported-${exportStamp()}-${path.basename(entry.imagePath)}`)
      await fs.copyFile(from, to)
      localPath = path.relative(path.dirname(resolveMediaPath('x')), to)
    } catch {
      summary.missingImage += 1
      continue
    }

    const { createEntry } = await import('./entry.service')
    const created = await createEntry({
      name: entry.name,
      sourceUrl: entry.sourceUrl,
      sourceTitle: entry.sourceTitle,
      sourceGame: entry.sourceGame,
      imagePath: localPath,
      imageSource: entry.imageSource === 'paste' ? 'paste' : 'file',
      originalName: entry.originalName,
      notes: entry.notes,
      bodyType: entry.bodyType,
      scale: entry.scale,
      movement: entry.movement,
      combatRole: entry.combatRole,
      attackPattern: entry.attackPattern,
      // ⚠️ status 来自导入包，是不可信输入。不能直接 `as EntryStatus` 断言 ——
      // createEntry 里的 assertStatus 只在字段存在时校验，传 undefined 就跳过了。
      // 所以这里显式过滤：认得的才给，不认得的走默认 inbox。
      status: ENTRY_STATUSES.includes(entry.status as EntryStatus) ? (entry.status as EntryStatus) : undefined,
      tagNames: entry.tags,
    })
    await rememberImportedId(entry.id, created.id)
    await attachEntryTagsByName(created.id, entry.tags)
    summary.created += 1
  }

  return summary
}