import { NextRequest, NextResponse } from 'next/server'
import { listTags, tagUsage } from '@/backstage/atlas/tag.service'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Atlas 请求失败')

export async function GET(request: NextRequest) {
  try {
    // ?usage=1 返回频次统计 —— 阶段 5「哪些 tag 高频 / 从来没用过」用
    if (request.nextUrl.searchParams.get('usage') === '1') {
      return NextResponse.json({ success: true, data: await tagUsage() })
    }
    return NextResponse.json({ success: true, data: await listTags() })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}
