import { NextRequest, NextResponse } from 'next/server'
import { deleteEntry, getEntry, setEntryStatus, updateEntry } from '@/backstage/atlas/entry.service'
import { detachEntryTag } from '@/backstage/atlas/tag.service'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Atlas 请求失败')

type Context = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    return NextResponse.json({ success: true, data: await getEntry(id) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 404 })
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { id } = await context.params
    const body = await request.json()
    return NextResponse.json({ success: true, data: await updateEntry(id, body) })
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
    return NextResponse.json({ success: true, data: await getEntry(id) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}