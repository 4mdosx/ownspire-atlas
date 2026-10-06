import { NextRequest, NextResponse } from 'next/server'
import { fetchImage, saveImage } from '@/backstage/atlas/media.service'
import type { ImageSource } from '@/types/atlas'

const message = (error: unknown) => (error instanceof Error ? error.message : '图片处理失败')

/**
 * 上传：粘图 / 拖文件 / 拖 URL / 选文件。
 *
 * 返回的是「已落盘的图」，不是条目 —— 前端拿到 imagePath 之后再调
 * POST /api/atlas/entries 建条目。两步是为了让「先攒一批图再慢慢填」也能work。
 *
 * ⚠️ **同时接受 JSON 与 FormData**。文件走 multipart（带二进制），URL 用 JSON 就够。
 * 两种都收是因为前端有两条入口：拖文件走 FormData，拖链接走 JSON ——
 * 统一到一种反而要在前端把 URL 包成假FormData，多一层无意义的转换。
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') ?? ''

    if (contentType.includes('application/json')) {
      const body = await request.json()
      const url = String(body?.url ?? '').trim()
      if (!url) throw new Error('没有图片 URL')
      const fetched = await fetchImage(url)
      const saved = await saveImage(fetched.buffer, fetched.contentType, 'paste', fetched.originalName)
      return NextResponse.json({ success: true, data: { ...saved, fetchedFrom: url } }, { status: 201 })
    }

    const form = await request.formData()
    const imageSource: ImageSource = form.get('imageSource') === 'paste' ? 'paste' : 'file'

    const file = form.get('file')
    if (file instanceof File) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const saved = await saveImage(buffer, file.type, imageSource, file.name)
      return NextResponse.json({ success: true, data: saved }, { status: 201 })
    }

    // FormData 传 url 的旧路径仍然留着 —— 命令行脚本与 curl 调用可能还在用。
    const url = String(form.get('url') ?? '').trim()
    if (!url) throw new Error('没有可用的图片：请给文件或给一个 URL')
    const fetched = await fetchImage(url)
    const saved = await saveImage(fetched.buffer, fetched.contentType, imageSource, fetched.originalName)
    return NextResponse.json({ success: true, data: { ...saved, fetchedFrom: url } }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}