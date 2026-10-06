import { NextRequest, NextResponse } from 'next/server'
import { fetchImage, saveImage } from '@/backstage/atlas/media.service'
import type { ImageSource } from '@/types/atlas'

const message = (error: unknown) => (error instanceof Error ? error.message : '图片处理失败')

/**
 * 上传（粘图 / 拖文件 / 选文件）。
 *
 * 返回的是「已落盘的图」，不是条目 —— 前端拿到 imagePath 之后再调
 * POST /api/atlas/entries 建条目。两步是为了让「先拖一堆图再慢慢填」也能work。
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData()
    const imageSource: ImageSource = form.get('imageSource') === 'paste' ? 'paste' : 'file'

    const file = form.get('file')
    if (file instanceof File) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const saved = await saveImage(buffer, file.type, imageSource, file.name)
      return NextResponse.json({ success: true, data: saved }, { status: 201 })
    }

    const url = String(form.get('url') ?? '').trim()
    if (!url) throw new Error('没有可用的图片：请给文件或给一个 URL')
    const fetched = await fetchImage(url)
    const saved = await saveImage(fetched.buffer, fetched.contentType, imageSource, fetched.originalName)
    // 来源链接一并带回去 —— 抓图的地址就是 sourceUrl，省一次输入
    return NextResponse.json({ success: true, data: { ...saved, fetchedFrom: url } }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}