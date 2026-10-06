import { NextRequest, NextResponse } from 'next/server'
import { exportAll, importFrom } from '@/backstage/atlas/import.service'

const message = (error: unknown) => (error instanceof Error ? error.message : '导入导出失败')

export async function GET() {
  try {
    const result = await exportAll()
    return NextResponse.json({ success: true, data: result })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}

/**
 * 导入。
 *
 * ⚠️ server-only 这条路由不能被客户端引，所以从 command line 走更合适：
 * `npx tsx scripts/import.ts <目录>`
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const root = String(body?.root ?? '').trim()
    if (!root) throw new Error('需要一个导出包目录')
    return NextResponse.json({ success: true, data: await importFrom(root) })
  } catch (error) {
    return NextResponse.json({ success: false, error: message(error) }, { status: 400 })
  }
}