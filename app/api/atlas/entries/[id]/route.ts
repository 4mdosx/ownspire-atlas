import { NextRequest, NextResponse } from 'next/server'
import { changeDomain, clearTaxonomyDimension, deleteEntry, getEntryDetail, setEntryStatus, updateEntry } from '@/backstage/atlas/entry.service'
import { detachEntryTag } from '@/backstage/atlas/tag.service'
import { isDomainCode } from '@/types/atlas'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Atlas 请求失败')

type Context = { params: Promise<{ id: string }> }

/**
 * 详情要带 extension 与 taxonomy —— drawer 里要显示这些。
 *
 * ⚠️ `?spaceId=` 决定读**哪个设计空间**的坐标（2026-10-06）。一个 entry
 * 在「原作」与「我的」下各有一组独立坐标，而「原作」和「我的」记的是两个不同的
 * 问题 —— 不指定就默认「我的」，因为那是采集时最常写的那个。
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    const spaceId = request.nextUrl.searchParams.get('spaceId') ?? undefined
    return NextResponse.json({ success: true, data: await getEntryDetail(id, spaceId) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 404 })
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    const body = await request.json()

    // ⚠️ 换 domain 是独立动作，不能混在 updateEntry 里 —— updateEntry 的语义是
    // 「改这条的字段」，而换 domain 会换扩展表。做成 PATCH 的一个分支会让
    // 「哪些字段可以一起改」这件事变得不可预测。
    if (body.domain !== undefined) {
      if (!isDomainCode(String(body.domain))) throw new Error(`未知的采集类型：${String(body.domain)}`)
      const { domain, ...rest } = body
      if (Object.keys(rest).length > 0) await updateEntry(id, rest)
      return NextResponse.json({ success: true, data: await changeDomain(id, domain) })
    }

    // 清除某个维度 ——「没打分」和「打了 0 分」是两件事，所以要能单独删。
    // ⚠️ spaceId 必须一起传：不清掉它就等于在默认空间删，而用户可能正在
    // 「原作」视图里点清除 —— 那样会删掉错空间的那一行。
    if (typeof body.clearDimension === 'string' && body.clearDimension) {
      await clearTaxonomyDimension(id, body.clearDimension, String(body.spaceId ?? 'space-mine'))
    }

    // ⚠️ 返回值也要跟着空间走：清除完之后直接把这个 body 返回给界面，
    // 而界面当前显示的可能正是被删掉的那个空间的坐标。
    const spaceId = typeof body.spaceId === 'string' ? body.spaceId : 'space-mine'
    const updated = await updateEntry(id, body)
    return NextResponse.json({ success: true, data: spaceId === 'space-mine' ? updated : await getEntryDetail(id, spaceId) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/** 状态推进单独一条：录完看一眼就标 reviewed，是采集后最频繁的第二个动作。 */
export async function PUT(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    const body = await request.json()
    return NextResponse.json({ success: true, data: await setEntryStatus(id, body.status) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    await deleteEntry(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/**
 * 摘掉一个 tag。
 *
 * ⚠️ 单独一条路由而不塞进 PATCH：detach 是「关系操作」，跟「改字段」混在一个
 * patch 里，调用方得先读一遍才知道该发哪个。
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    const body = await request.json()
    const tagId = String(body?.detachTagId ?? '').trim()
    if (!tagId) throw new Error('缺少 detachTagId')
    await detachEntryTag(id, tagId)
    return NextResponse.json({ success: true, data: await getEntryDetail(id) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}