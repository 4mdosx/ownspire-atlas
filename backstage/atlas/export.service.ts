import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveMediaPath, mediaRoot } from '@/backstage/db/database'

/**
 * 导出包格式：JSON 清单 + media 目录。
 *
 * 关键取舍：**不导出图片本体到 base64**。base64 会让 JSON 膨胀 33% 且不可读，
 * 导出包就无法 diff、无法用文本工具检查。图片走目录，JSON 只带相对路径。
 *
 * 包结构：
 * ```
 * atlas-export-20261006T154900Z/
 *   manifest.json      ← 条目 + tag + 导入机制所需信息
 *   media/<relative>   ← 图片本体
 * ```
 */
export type ExportManifest = {
  formatVersion: 1
  exportedAt: string
  collection: 'monster'
  entryCount: number
  entries: ExportEntry[]
  /** 附在包里，方便日后溯源。 */
  provenance: {
    source: 'creative-atlas'
    note: string
  }
}

export type ExportEntry = {
  id: string
  name: string
  sourceUrl: string
  sourceTitle: string
  sourceGame: string
  imagePath: string
  imageSource: string
  originalName: string
  notes: string
  bodyType: string
  scale: string
  movement: string[]
  combatRole: string[]
  attackPattern: string[]
  status: string
  createdAt: string
  updatedAt: string
  tags: string[]
}

export async function writeExport(entries: ExportEntry[], stamp: string): Promise<string> {
  const root = path.join(mediaRoot(), '..', `atlas-export-${stamp}`)
  await fs.mkdir(root, { recursive: true })

  // 先写图，缺图要报错而不是导出一个有洞的包
  const missing: string[] = []
  for (const entry of entries) {
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
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    collection: 'monster',
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