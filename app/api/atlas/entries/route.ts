import { NextRequest, NextResponse } from 'next/server'
import { createEntry, listEntries, statusCounts } from '@/backstage/atlas/entry.service'
import type { EntryStatus, ImageSource } from '@/types/atlas'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Atlas 请求失败')

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const split = (value: string | null) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined)
    const entries = await listEntries({
      status: (params.get('status') as EntryStatus | null) ?? undefined,
      tagNames: split(params.get('tags')),
      anyTagNames: split(params.get('anyTags')),
      q: params.get('q') ?? undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      offset: params.get('offset') ? Number(params.get('offset')) : undefined,
    })
    return NextResponse.json({ success: true, data: entries, counts: await statusCounts() })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/**
 * 采集落库。
 *
 * ⚠️ 一次请求完成「取图 → 落盘 → 建条目 → 挂标签」四件事，
 * 前端只需要一次往返。采集路径上每多一个来回就多一次放弃的机会。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const entry = await createEntry({
      name: body.name,
      sourceUrl: body.sourceUrl,
      sourceTitle: body.sourceTitle,
      sourceGame: body.sourceGame,
      imagePath: body.imagePath,
      imageSource: body.imageSource as ImageSource,
      originalName: body.originalName,
      notes: body.notes,
      bodyType: body.bodyType,
      scale: body.scale,
      movement: body.movement,
      combatRole: body.combatRole,
      attackPattern: body.attackPattern,
      status: body.status,
      tagNames: Array.isArray(body.tagNames) ? body.tagNames : [],
    })
    return NextResponse.json({ success: true, data: entry }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}