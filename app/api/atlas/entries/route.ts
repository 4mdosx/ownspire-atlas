import { NextRequest, NextResponse } from 'next/server'
import { createEntry, listEntries, statusCounts, untaggedCount } from '@/backstage/atlas/entry.service'
import { isDomainCode, type DomainCode, type EntryStatus, type ImageSource, type TagOrigin } from '@/types/atlas'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Atlas 请求失败')

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const split = (value: string | null) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined)

    // ⚠️ domain 只影响筛选，不是权限边界 —— 认不出的值当没给，别抛错。
    // URL 参数是用户手打的，界面上不该因为打错一个字母就白屏。
    const rawDomain = params.get('domain')
    const domain = rawDomain && isDomainCode(rawDomain) ? (rawDomain as DomainCode) : undefined
    const originParam = params.get('origin')

    const entries = await listEntries({
      domain,
      status: (params.get('status') as EntryStatus | null) ?? undefined,
      tagNames: split(params.get('tags')),
      anyTagNames: split(params.get('anyTags')),
      origin: originParam === 'user' || originParam === 'system' ? (originParam as TagOrigin) : undefined,
      ruleId: params.get('ruleId') ?? undefined,
      untagged: params.get('untagged') === '1' || params.get('untagged') === 'true',
      q: params.get('q') ?? undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      offset: params.get('offset') ? Number(params.get('offset')) : undefined,
    })
    return NextResponse.json({
      success: true,
      data: entries,
      counts: await statusCounts(domain),
      untagged: await untaggedCount(domain),
      /** 有 domain 筛选时侧栏不显示「全部类型」入口。 */
      filteredByDomain: domain ?? null,
    })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/**
 * 采集落库。
 *
 * ⚠️ 一次请求完成「取图 → 落盘 → 建条目 → 挂标签 → 写 axisValues」五件事，
 * 前端只需要一次往返。采集路径上每多一个来回就多一次放弃的机会。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const entry = await createEntry({
      domain: body.domain,
      name: body.name,
      sourceUrl: body.sourceUrl,
      sourceTitle: body.sourceTitle,
      sourceGame: body.sourceGame,
      imagePath: body.imagePath,
      imageSource: body.imageSource as ImageSource,
      originalName: body.originalName,
      observed: body.observed,
      read: body.read,
      worthwhileBecause: body.worthwhileBecause,
      status: body.status,
      tagNames: Array.isArray(body.tagNames) ? body.tagNames : [],
      axisValues: body.axisValues && typeof body.axisValues === 'object' ? body.axisValues : undefined,
      extension: body.extension && typeof body.extension === 'object' ? body.extension : undefined,
    })
    return NextResponse.json({ success: true, data: entry }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}
