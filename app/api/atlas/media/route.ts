import fs from 'node:fs/promises'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { resolveMediaPath } from '@/backstage/db/database'

/**
 * 按 imagePath 预览**尚未入库**的图。
 *
 * ⚠️ 为什么需要这条：条目创建之前，imagePath 只存在于一次上传响应里——
 * 走 `/api/atlas/entries/[id]/image` 查不到（那时还没有 id）。Quick Add
 * 的预览就靠这条路由。
 *
 * 用 `?path=` 而不是 catch-all 路径参数：path 里含 `/`（`<entryId>/<hash>-<name>`），
 * 放进 catch-all 还得额外 encode，而 query 参数直接传原始相对路径最省事。
 *
 * 安全边界与 entries/[id]/image 一致：路径来自不可信输入，必须过 resolveMediaPath，
 * 越界检查是同一个函数。⚠️ 这条比那条宽松 —— 它能取库里任何已落盘的图，不要求
 * 「有对应条目」。它是预览通道，不是公开读取通道。
 */
export async function GET(request: NextRequest) {
  try {
    const relative = request.nextUrl.searchParams.get('path')?.trim()
    if (!relative) return NextResponse.json({ success: false, error: '缺少 path' }, { status: 400 })

    const absolute = resolveMediaPath(relative)
    const data = await fs.readFile(absolute)
    const ext = path.extname(absolute).toLowerCase()
    const type = ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/png'

    return new NextResponse(new Uint8Array(data), {
      headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=300' },
    })
  } catch {
    return NextResponse.json({ success: false, error: '图片不存在' }, { status: 404 })
  }
}