import { NextRequest, NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import { resolveMediaPath } from '@/backstage/db/database'
import { listEntries } from '@/backstage/atlas/entry.service'

/**
 * 按 entry id 返回图片。
 *
 * ⚠️ 不做 `/media/<path>` 这种静态直出。理由：路径来自 db，而 db 可以被导入包
 * 改写（`../../etc/passwd` 之类的相对路径）。走 entry id 查库再 resolveMediaPath，
 * 越界检查才有唯一入口 —— resolveMediaPath 里那道 `startsWith(root + sep)` 断言。
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const entry = await listEntries({ limit: 500 })
    const found = entry.find((item) => item.id === id)
    if (!found) return NextResponse.json({ success: false, error: '条目不存在' }, { status: 404 })

    const absolute = resolveMediaPath(found.imagePath)
    const data = await fs.readFile(absolute)
    const ext = absolute.split('.').pop() ?? 'png'
    const type = ext === 'jpeg' || ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': type,
        // 图片内容随条目变化，重新采集时不该拿到旧缓存
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    })
  } catch {
    return NextResponse.json({ success: false, error: '图片不存在' }, { status: 404 })
  }
}