import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mediaRoot, resolveMediaPath } from '@/backstage/db/database'
import { listEntries } from './entry.service'
import type { ImageSource } from '@/types/atlas'

/** 允许的图片类型。v0 只收这几种——其余格式在浏览器里也画不出来。 */
const ALLOWED = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpeg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
])

const MAX_BYTES = 20 * 1024 * 1024

/**
 * 占位与隐藏文件不算孤儿。
 *
 * ⚠️ `media/.gitkeep` 必须留着 —— 它的作用就是让 media 目录能进 git。
 * 被当孤儿清掉的话，一次gc 就会让仓库失去这个目录，下一次 clone 出来空目录都没有。
 */
const IGNORED_NAMES = new Set(['.gitkeep', '.gitignore', '.DS_Store'])

function sanitize(name: string): string {
  // 只留基名，去掉目录跳转字符。原名另存进 originalName 字段。
  const base = path.basename(name).replace(/[^\w.\-]+/g, '_').slice(-80)
  return base || 'image'
}

async function persist(buffer: Buffer, contentType: string, entryId: string, originalName: string, imageSource: ImageSource) {
  const ext = ALLOWED.get(contentType)
  if (!ext) throw new Error(`不支持的图片类型：${contentType || '未知'}`)
  if (buffer.length === 0) throw new Error('图片是空的')
  if (buffer.length > MAX_BYTES) throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB`)

  // 目录名用条目 id —— 一条目一目录，删条目时目录可直接整体移除。
  // 文件名带一个内容哈希前缀：同一张图重复粘贴不会互相覆盖。
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8)
  const relative = path.posix.join(entryId, `${hash}-${sanitize(originalName)}`)
  const absolute = resolveMediaPath(relative)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, buffer)
  return { imagePath: relative, imageSource, originalName: sanitize(originalName), bytes: buffer.length }
}

/**
 * 粘图 / 拖文件落盘。
 *
 * ⚠️ 目录用临时 id，落盘后才随条目一起定名。原因是条目 id 由 nanoid 在
 * insert 时生成 —— 而落盘必须在 insert 之前完成（imagePath 是必填字段）。
 * 所以先用一个占位目录名写进去，创建条目后不改名：内容寻址的哈希前缀已经
 * 保证不会撞名，目录名一致性由 resolveMediaPath 保证安全。
 */
export async function saveImage(buffer: Buffer, contentType: string, imageSource: ImageSource, originalName = '') {
  const placeholderDir = `up-${randomUUID().slice(0, 8)}`
  const name = originalName || `pasted.${ALLOWED.get(contentType) ?? 'png'}`
  return persist(buffer, contentType, placeholderDir, name, imageSource)
}

/** 从远端 URL 抓图（粘 URL 时的兜底：只抓图，不抓整页）。 */
export async function fetchImage(url: string): Promise<{ buffer: Buffer; contentType: string; originalName: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('不是合法的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http / https')
  const response = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`抓图失败：HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.split(';')[0].trim() ?? ''
  if (!ALLOWED.has(contentType)) throw new Error(`这个 URL 返回的不是图片（${contentType || '未知类型'}）`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_BYTES) throw new Error('远程图片过大')
  const name = decodeURIComponent(parsed.pathname.split('/').pop() ?? '') || `remote.${ALLOWED.get(contentType)}`
  return { buffer, contentType, originalName: name }
}

/**
 * 孤儿图片清理 —— 删条目时留下的图片由此回收。
 *
 * ⚠️ 走 dry-run 默认。要真删必须显式传 apply，这是不可逆操作。
 */
export async function collectOrphanImages(apply = false) {
  const entries = await listEntries({ limit: 500 })
  const live = new Set(entries.map((entry) => entry.imagePath))
  const root = mediaRoot()
  const orphans: Array<{ relative: string; bytes: number }> = []

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const absolute = path.join(dir, item.name)
      const relative = prefix ? path.posix.join(prefix, item.name) : item.name
      if (item.isDirectory()) {
        await walk(absolute, relative)
        continue
      }
      if (IGNORED_NAMES.has(item.name) || item.name.startsWith('.')) continue
      if (!live.has(relative)) {
        const stat = await fs.stat(absolute)
        orphans.push({ relative, bytes: stat.size })
      }
    }
  }

  await walk(root, '')
  if (apply) {
    for (const orphan of orphans) {
      await fs.rm(resolveMediaPath(orphan.relative), { force: true })
    }
    // 清掉空目录
    for (const entry of await listEntries({ limit: 500 })) {
      const dir = path.dirname(resolveMediaPath(entry.imagePath))
      await fs.rmdir(dir).catch(() => undefined)
    }
  }
  return { dryRun: !apply, count: orphans.length, bytes: orphans.reduce((sum, item) => sum + item.bytes, 0), orphans }
}