import { NextRequest, NextResponse } from 'next/server'
import { listTags, setTagGroup, tagUsage } from '@/backstage/atlas/tag.service'
import { isTagGroupKey, type TagGroup } from '@/types/atlas'

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
/**
 * 改 tag 的命名空间。
 *
 * ⚠️ **只改归类，不改名。** 改名要处理所有引用它的地方（含 entry_tags 的
 * 跨库关联），那是另一个动作；而归类是「这个词属于哪类」，改错了改回来就行。
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { name?: string; group?: string }
    const name = String(body.name ?? '').trim()
    if (!name) throw new Error('缺少 tag 名')
    // ⚠️ group 允许是空串（取消归类），所以不能用 `|| ''` —— 那会把
    // 任何非法值都悄悄当成「取消归类」。非法值该在这里被挡住。
    const raw = body.group ?? ''
    if (raw !== '' && !isTagGroupKey(raw)) throw new Error(`未知的归类：${raw}`)
    return NextResponse.json({ success: true, data: await setTagGroup(name, raw as TagGroup) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}
