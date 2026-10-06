import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath, mediaRoot } from '@/backstage/db/database'
import type { DomainCode, EntryTag, MonsterExtension, TaxonomyDimensionKey } from '@/types/atlas'

/**
 * 导出包格式：JSON 清单 + media 目录。
 *
 * 关键取舍：**不导出图片本体到 base64**。base64 会让 JSON 膨胀 33% 且不可读，
 * 导出包就无法 diff、无法用文本工具检查。图片走目录，JSON 只带相对路径。
 *
 * 包结构：
 * ```
 * atlas-export-20261006T154900Z/
 *   manifest.json      ← 条目 + tag + taxonomy + domain 扩展 + 导入机制所需信息
 *   media/<relative>   ← 图片本体
 * ```
 *
 * ⚠️ **formatVersion 2**（v0.1 是 1）。改动：
 * · `collection: 'monster'` 换成每条自带 `domain`
 * · 新增 `taxonomy`（0–1 连续分）
 * · 新增 `extension`（domain 专属结构化字段）
 * · tag 从 `string[]` 变成 `{name, origin, ruleId}` —— origin 是关联的属性，
 *   导成裸名字就丢了「这个 tag 是系统打还是手动加」
 * · `imagePath` 允许为空
 *
 * v0.1 的包不兼容 —— 导入端会明确报错而不是猜。
 */
export const EXPORT_FORMAT_VERSION = 2

export type ExportTag = {
  name: string
  origin: string
  ruleId: string
}

export type ExportEntry = {
  id: string
  domain: DomainCode
  name: string
  sourceUrl: string
  sourceTitle: string
  sourceGame: string
  imagePath: string
  imageSource: string
  originalName: string
  notes: string
  status: string
  createdAt: string
  updatedAt: string
  tags: ExportTag[]
  /** 部分 Record：只出现打过分且该 domain 有定义的维度。 */
  taxonomy: Partial<Record<TaxonomyDimensionKey, number>>
  /** domain 专属结构化字段。非 monster 为 null。 */
  extension: MonsterExtension | null
}

export type ExportManifest = {
  formatVersion: number
  exportedAt: string
  /** 本包里出现的 domain 列表。 */
  domains: DomainCode[]
  entryCount: number
  entries: ExportEntry[]
  /** 附在包里，方便日后溯源。 */
  provenance: {
    source: 'creative-atlas'
    note: string
  }
}

export async function writeExport(entries: ExportEntry[], stamp: string): Promise<string> {
  const root = path.join(mediaRoot(), '..', `atlas-export-${stamp}`)
  await fs.mkdir(root, { recursive: true })

  // 先写图，缺图要报错而不是导出一个有洞的包。
  // ⚠️ imagePath 从 v0.2 起可空 —— 没有图的条目直接跳过，不算 missing。
  const missing: string[] = []
  for (const entry of entries) {
    if (!entry.imagePath) continue
    try {
      const from = resolveMediaPath(entry.imagePath)
      const to = path.join(root, 'media', entry.imagePath)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(from, to)
    } catch {
      missing.push(entry.imagePath)
    }
  }
  if (missing.length > 0) {
    throw new Error(`有 ${missing.length} 张图片在磁盘上找不到，先跑 gc-media 看看：${missing.slice(0, 3).join(', ')}`)
  }

  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    domains: [...new Set(entries.map((entry) => entry.domain))],
    entryCount: entries.length,
    entries,
    provenance: {
      source: 'creative-atlas',
      note: '个人创意采集库导出。图片以相对路径随包携带，可整体拷贝。',
    },
  }
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return root
}

export function exportStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** EntryTag（service 层形态）→ ExportTag（落盘形态）。 */
export function toExportTag(tag: EntryTag): ExportTag {
  return { name: tag.name, origin: tag.origin, ruleId: tag.ruleId }
}