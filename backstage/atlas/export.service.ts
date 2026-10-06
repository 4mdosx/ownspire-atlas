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
 * ⚠️ **formatVersion 3**（v0.1 是 1，v0.2 是 2）。相对 2 的改动：
 * · `notes` 拆成 `observed`（我看到了什么）+ `read`（我认为它为什么成立）
 * · 新增 `worthwhileBecause`（我为什么留着它）
 * · tag 带上 `group`（命名空间）
 *
 * ⚠️ **这是破坏性变更，所以升版本号而不是悄悄加字段。**
 * v0.2 建立的纪律在这里兑现：v2 的包里 `notes` 装着观察与判断的混合，
 * 导入到 v3 无法自动拆分（猜错比不猜贵）。所以 v2 的包**不兼容**，
 * 导入端明确报错—— 至少不会让人以为数据完整地过来了。
 *
 * v1 与 v2 的包同样不兼容，错误信息各不相同。
 */
export const EXPORT_FORMAT_VERSION = 3

export type ExportTag = {
  name: string
  origin: string
  ruleId: string
  /** 命名空间（formatVersion 3 起）。空串 = 还没归类。 */
  group: string
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
  /**
   * ⭐ 观察 —— 我看到了什么（客观）。
   *
   * ⚠️ `notes` 保留在导出格式里，但**只作为读入端的兼容字段**：
   * formatVersion 3 的包里不再有它，v3导入器会把它读进 observed；
   * 导出 v3 时它恒为空。理由见docs/00-scope.md ——
   * 「观察」和「判断」混在一个字段里，半年后无法分辨哪句是原作事实。
   */
  observed: string
  /** ⭐ 判断 —— 我认为它为什么成立（主观）。 */
  read: string
  /** ⭐ 我为什么留着它。 */
  worthwhileBecause: string
  /** @deprecated 读入端兼容用；v3 导出恒为空串。 */
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
  return { name: tag.name, origin: tag.origin, ruleId: tag.ruleId, group: tag.group }
}