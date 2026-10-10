import { NextResponse } from 'next/server'
import { databaseFile, mediaRootExists, pingDatabase } from '@/backstage/db/database'
import { ATLAS_VERSION } from '@/backstage/version'

/**
 * 部署健康检查。
 *
 * infra 的 `ownspire.mjs atlas deploy` 靠这里返回的 7 位 commit 判断
 * 「跑的是哪一版」，然后写进 /srv/ownspire/compose/atlas.tag。
 * **不返回任何数据行或密钥** —— 只有两个布尔和版本号。
 *
 * @see navi 的 app/healthz/route.ts（同一套契约）
 */
export async function GET() {
  try {
    await pingDatabase()
    return NextResponse.json({
      ok: true,
      version: ATLAS_VERSION,
      media: mediaRootExists(),
    })
  } catch {
    return NextResponse.json({ ok: false, version: ATLAS_VERSION, error: databaseFile() }, { status: 500 })
  }
}