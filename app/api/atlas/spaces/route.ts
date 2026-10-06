import { NextRequest, NextResponse } from 'next/server'
import { createDesignAxis, createDesignSpace, listDesignAxes, listDesignSpaces } from '@/backstage/atlas/space.service'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Atlas 请求失败')

/**
 * 设计空间。
 *
 * ⚠️ GET 默认**不含**维度定义：侧栏与切换器只要空间列表（id + code + 名字），
 * 而维度可能几十条，混在一个响应里每次都要全部解析。维度走 `?axesOf=` 单独取。
 */
export async function GET(request: NextRequest) {
  try {
    const spaceId = request.nextUrl.searchParams.get('axesOf')
    if (spaceId) return NextResponse.json({ success: true, data: await listDesignAxes(spaceId) })
    return NextResponse.json({ success: true, data: await listDesignSpaces() })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/**
 * 新建一个设计空间 —— 项目坐标系用。
 *
 * ⚠️ **只有项目空间才该走这里**。「原作」与「我的」是预置的，重复建会撞
 * code 的唯一约束，那是有意的：code 是数据里的稳定标识。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { code?: string; labelZh?: string; labelEn?: string; hintZh?: string }
    if (!body.labelZh?.trim()) throw new Error('空间需要一个名字')
    return NextResponse.json({
      success: true,
      data: await createDesignSpace({
        code: body.code ?? `space-${Date.now()}`,
        labelZh: body.labelZh,
        labelEn: body.labelEn,
        hintZh: body.hintZh,
      }),
    })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/** 给某个空间加一条维度轴。 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      spaceId?: string
      key?: string
      labelZh?: string
      labelEn?: string
      hintZh?: string
      groupLabelZh?: string
      groupLabelEn?: string
      anchors?: string[]
    }
    if (!body.spaceId) throw new Error('缺少 spaceId')
    if (!body.key?.trim()) throw new Error('维度需要一个 key')
    if (!body.labelZh?.trim()) throw new Error('维度需要一个名字')
    return NextResponse.json({
      success: true,
      data: await createDesignAxis({
        spaceId: body.spaceId,
        key: body.key,
        labelZh: body.labelZh,
        labelEn: body.labelEn,
        hintZh: body.hintZh,
        groupLabelZh: body.groupLabelZh,
        groupLabelEn: body.groupLabelEn,
        anchors: body.anchors ?? [],
      }),
    })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}