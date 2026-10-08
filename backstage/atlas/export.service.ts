import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath, mediaRoot } from '@/backstage/db/database'
import type { DomainCode, EntryTag, MonsterExtension } from '@/types/atlas'

/**
 * 导出包格式：JSON 清单 + media 目录。
 *
 * 关键取舍：**不导出图片本体到 base64**。base64 会让 JSON 膨胀 33% 且不可读，
 * 导出包就无法 diff、无法用文本工具检查。图片走目录，JSON 只带相对路径。
 *
 * 包结构：
 * ```
 * atlas-export-20261006T154900Z/
 *   manifest.json      ← 条目 + tag + axisValues + domain 扩展 + 导入机制所需信息
 *   media/<relative>   ← 图片本体
 * ```
 *
 * formatVersion 6 carries `axisValuesBySpace`, `spaces`, `axes`, and tag confidence using only
 * current field names. Older formats require explicit conversion.
 *
 * ⚠️ **为什么必须带上轴的定义**：坐标是 0–1 的浮点数，不带档位词的话
 * 换台机器导入就只剩「0.42」，而没人知道它代表「giant」还是「high mobility」。
 * 那样的导出包**看着成功、实则丢掉了全部语义**。
 *
 * 导入只接受当前格式，避免在读入时猜测历史字段的含义。
 */
export const EXPORT_FORMAT_VERSION = 6

export type ExportTag = {
  name: string
  origin: string
  ruleId: string
  confidence: number
}

/** 设计空间（formatVersion 4 起）。⚠️ 用 code 而非 id 做身份。 */
export type ExportSpace = {
  code: string
  labelZh: string
  labelEn: string
  hintZh: string
  sortOrder: number
  isBuiltin: boolean
}

/** 一条坐标轴（formatVersion 4 起）。 */
export type ExportAxis = {
  spaceCode: string
  key: string
  labelZh: string
  labelEn: string
  hintZh: string
  groupLabelZh: string
  groupLabelEn: string
  anchors: string[]
  sortOrder: number
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
   */
  observed: string
  /** ⭐ 判断 —— 我认为它为什么成立（主观）。 */
  read: string
  /** ⭐ 我为什么留着它。 */
  worthwhileBecause: string
  status: string
  createdAt: string
  updatedAt: string
  tags: ExportTag[]
  /**
   * ⭐ 全部设计空间的坐标（formatVersion 4 起）。
   *
   * ⚠️ **是全部空间，不是当前那个。** 导出时只带「我的」等于把原作坐标
   * 和项目坐标悄悄丢掉 —— 而导出包的用途就是「完整搬走」。
   *
   * ⚠️ key 是空间 `code`（不是 id）：id 是本地数据，code 才是跨机器稳定的
   * 标识。用 id 的话，导出到另一台机器上就对不上了。
   */
  axisValuesBySpace: Record<string, Record<string, number>>
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
  /**
   * 空间与轴定义（formatVersion 4 起）。
   *
   * ⚠️ 这是**全局**的，不在每条 entry 里重复 —— 空间是库级的东西，
   * 而坐标轴的数量会随着采集增长。放全局让包小，也让「这个库里有哪些轴」
   * 一眼可查（而那正是「导出包能不能被读懂」的关键）。
   */
  spaces: ExportSpace[]
  axes: ExportAxis[]
  /** 附在包里，方便日后溯源。 */
  provenance: {
    source: 'creative-atlas'
    note: string
  }
}

export async function writeExport(
  entries: ExportEntry[],
  stamp: string,
  spaces: ExportSpace[] = [],
  axes: ExportAxis[] = [],
): Promise<string> {
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
    spaces,
    axes,
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
  return { name: tag.name, origin: tag.origin, ruleId: tag.ruleId, confidence: tag.confidence }
}
