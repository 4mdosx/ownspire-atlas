import { NextResponse } from 'next/server'
import { collectOrphanImages } from '@/backstage/atlas/media.service'

/**
 * 孤儿图片清理。
 *
 * ⚠️ 默认 dry-run。真删必须显式传 `{"apply": true}` —— 这是不可逆操作，
 * 而且「误删唯一的参考图」是这套系统里最坏的一种丢数据。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const result = await collectOrphanImages(body?.apply === true)
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : '清理失败' }, { status: 400 })
  }
}

export async function GET() {
  try {
    return NextResponse.json({ success: true, data: await collectOrphanImages(false) })
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : '清理失败' }, { status: 400 })
  }
}