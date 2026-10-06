/**
 * ⭐ 设计空间迁移的验证（2026-10-06）。
 *
 * 为什么单独一个脚本：`migrateTaxonomySpace` 要重建表，而**重建失败时留下的是
 * 半张表** —— 那比报错更难收拾。正常库碰不到这条路径（新建库走 CREATE TABLE），
 * 所以只能专门造一份旧结构的库来跑。
 *
 * 验三件事：
 * 1. 旧结构（二元主键、无 spaceId）能迁到三元主键
 * 2. **旧数据全部归入「我的」空间**，且一个不少
 * 3. 迁移是幂等的（第二次跑不炸、不重复搬）
 *
 * 用法：node --conditions react-server --import tsx scripts/verify-space-migration.ts
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

async function main(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail = ''): void => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const stamp = Date.now()
  const legacyPath = `/tmp/atlas-legacy-${stamp}.db`

  // 1. 造一份 **v0.2 旧结构**：entry_taxonomy 是二元主键、没有 spaceId。
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      sourceUrl TEXT NOT NULL, sourceTitle TEXT NOT NULL DEFAULT '', sourceGame TEXT NOT NULL DEFAULT '',
      imagePath TEXT NOT NULL DEFAULT '', imageSource TEXT NOT NULL DEFAULT 'file',
      originalName TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE TABLE monster_entries (
      entryId TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      attackPattern TEXT NOT NULL DEFAULT '[]', behaviorPattern TEXT NOT NULL DEFAULT '[]',
      telegraph TEXT NOT NULL DEFAULT '[]', reactionPattern TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE entry_tags (
      entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      tagId TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      origin TEXT NOT NULL DEFAULT 'user', ruleId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL, PRIMARY KEY (entryId, tagId)
    );
    CREATE TABLE entry_taxonomy (
      entryId TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      dimensionKey TEXT NOT NULL, score REAL NOT NULL,
      setAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL,
      PRIMARY KEY (entryId, dimensionKey)
    );
    CREATE TABLE import_id_map (
      externalId TEXT PRIMARY KEY, localId TEXT NOT NULL, importedAt TEXT NOT NULL
    );
  `)
  const now = '2026-10-01T00:00:00.000Z'
  legacy
    .prepare('INSERT INTO entries (id, domain, name, sourceUrl, notes, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)')
    .run('e-old', 'monster', '旧条目', 'https://example.com/old', '旧笔记', 'inbox', now, now)
  const seedScore = legacy.prepare(
    'INSERT INTO entry_taxonomy (entryId, dimensionKey, score, setAt, updatedAt) VALUES (?,?,?,?,?)',
  )
  // 两条五维分数 —— v0.2 时期的打分全是「在我的设计语言里它在哪」
  for (const [dim, score] of [
    ['form', 0.33],
    ['scale', 0.83],
    ['movement', 0.5],
  ] as const) {
    seedScore.run('e-old', dim, score, now, now)
  }
  legacy.close()

  // 2. 跑迁移 —— 让 database.ts 打开那份库（它的 getDatabase 会调 ensureSchema）
  process.env.DB_FILE_NAME = `file:${legacyPath}`
  process.env.MEDIA_ROOT = `/tmp/atlas-mig-media-${stamp}`
  const { closeDatabase, getDatabase } = await import('@/backstage/db/database')
  await getDatabase()
  const { listDesignSpaces, listDesignAxes } = await import('@/backstage/atlas/space.service')
  const { listEntries } = await import('@/backstage/atlas/entry.service')

  const spaces = await listDesignSpaces()
  check('迁出两个预置空间', spaces.length >= 2, spaces.map((s) => s.code).join(' '))
  const mine = spaces.find((s) => s.code === 'mine')
  const source = spaces.find((s) => s.code === 'source')
  check('「我的」空间存在', mine !== undefined)
  check('「原作」空间存在', source !== undefined)
  check('「我的」排在「原作」前面（采集时最常写我的）', (mine?.sortOrder ?? 99) < (source?.sortOrder ?? 0), `${mine?.sortOrder} vs ${source?.sortOrder}`)
  check('预置空间不可删', mine?.isBuiltin === true && source?.isBuiltin === true)

  const mineAxes = await listDesignAxes(mine!.id)
  check('「我的」带维度', mineAxes.length === 4, `${mineAxes.length} 条：${mineAxes.map((a) => a.key).join(' ')}`)
  check(
    '维度带完整档位',
    mineAxes.every((axis) => axis.anchors.length >= 3),
    mineAxes.map((a) => `${a.key}:${a.anchors.length}`).join(' '),
  )

  // ⚠️ 域收窄的迁移断言（2026-10-06）
  // combat / role 被砍（属玩法不属造型），movement 改名 mobility 且**分数要搬过来**。
  const axisKeys = mineAxes.map((a) => a.key)
  check('migration 后 combat 轴已不存在', !axisKeys.includes('combat'), axisKeys.join(' '))
  check('migration 后 role 轴已不存在', !axisKeys.includes('role'))
  check('movement 已改名 mobility', axisKeys.includes('mobility') && !axisKeys.includes('movement'))
  check('新增 palette 轴', axisKeys.includes('palette'), axisKeys.join(' '))

  const migratedEntry = await listEntries()
  const rec = migratedEntry.find((entry) => entry.id === 'e-old')
  check(
    'movement 的分数搬到 mobility 上',
    rec?.taxonomy?.['mobility'] === 0.5,
    JSON.stringify(rec?.taxonomy ?? {}),
  )
  check('搬完后旧 key 不再出现', rec?.taxonomy?.['movement'] === undefined, String(rec?.taxonomy?.['movement']))
  check('维度带分组标签', mineAxes.every((axis) => axis.group.labelZh !== ''), mineAxes[0]?.group.labelZh ?? '')

  // ⚠️ **「原作」刻意是空的** —— 它的维度取决于原作是什么游戏
  const sourceAxes = await listDesignAxes(source!.id)
  check('「原作」空间刻意留空', sourceAxes.length === 0, `${sourceAxes.length} 条`)

  // 3. 旧数据全部归入「我的」，一个不少
  const migrated = await listEntries()
  check('旧条目还在', migrated.some((entry) => entry.id === 'e-old'), `${migrated.length} 条`)
  const old = migrated.find((entry) => entry.id === 'e-old')
  // ⚠️ 断言里用的是 mobility 而不是 movement —— 域收窄时那条轴改了名，
  // 而分数要跟着搬过去（syncDesignAxes 里做）。所以「迁进来」已经包含了
  // 「改名」这一层。
  check(
    '旧坐标迁到「我的」空间（movement 已改名为 mobility）',
    old?.taxonomy?.['scale'] === 0.83 && old?.taxonomy?.['mobility'] === 0.5,
    JSON.stringify(old?.taxonomy ?? {}),
  )
  check('「我的」空间读数与迁移前一致', Object.keys(old?.taxonomy ?? {}).length === 3, `${Object.keys(old?.taxonomy ?? {}).length} 条`)

  // 4. notes 落到 observed
  check('旧 notes 落进 observed', old?.observed === '旧笔记', old?.observed ?? '')

  // 5. 迁移是幂等的：再跑一次不炸、不重复
  await closeDatabase()
  const again = await getDatabase()
  check('重复打开不报错（二次迁移跳过）', Boolean(again))
  const spaces2 = await listDesignSpaces()
  check('空间没被重复插入', spaces2.length === spaces.length, `${spaces2.length} vs ${spaces.length}`)
  const axes2 = await listDesignAxes(mine!.id)
  check('维度没被重复插入', axes2.length === 4, `${axes2.length} 条`)
  const migrated2 = await listEntries()
  check('坐标没被重复搬运', migrated2.find((e) => e.id === 'e-old')?.taxonomy?.['scale'] === 0.83)

  await closeDatabase()
  fs.rmSync(legacyPath, { force: true })
  fs.rmSync(`/tmp/atlas-mig-media-${stamp}`, { recursive: true, force: true })

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('\n失败项：')
    for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})