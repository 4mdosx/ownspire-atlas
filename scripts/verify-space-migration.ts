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
  const mine = spaces.find((item) => item.code === 'mine')
  const source = spaces.find((item) => item.code === 'source')
  const mineAxes = await listDesignAxes(mine!.id)
  const axisKeys = mineAxes.map((axis) => axis.key)
  const migrated = await listEntries()
  const rec = migrated.find((entry) => entry.id === 'e-old')

  //⚠️ **迁移路径只有三件真正要验的事**，其余都是它们的推论：
  //  ① 旧结构能迁过来（表重建 + 列新增）
  //  ② **数据一个不少，且被搬到了正确的位置**
  //  ③ 幂等 —— 再跑一遍不炸、不重复搬
  // 其余断言都是从这三件推出来的，重复列一遍只是让失败时更难定位。

  // ① 结构
  check('迁出两个预置空间且「我的」在前', Boolean(mine && source) && mine!.sortOrder < source!.sortOrder, spaces.map((item) => item.code).join(' '))
  check('「我的」迁入六根视觉轴', axisKeys.length === 6, axisKeys.join(' '))
  check('每根轴都带分组标签（渲染靠它，漏声明= 界面整块消失）', mineAxes.every((axis) => axis.group.labelZh !== ''), mineAxes[0]?.group.labelZh ?? '')
  //⚠️ **「原作」刻意是空的**：它的维度取决于原作是什么游戏。硬塞预置维度
  // 就等于又回到「照搬原作的坐标系」—— 正是这套系统要避开的事。
  check('「原作」空间刻意留空', (await listDesignAxes(source!.id)).length === 0)

  // ② 数据落到正确的位置（这一组是迁移的全部意义）
  check('domain 从 monster 迁到 creature', rec?.domain === 'creature', String(rec?.domain))
  check('旧 notes 落进 observed（v0.2→v0.3 的迁移）', rec?.observed === '旧笔记', rec?.observed ?? '')
  check('scale 的分搬到 visualMass（语义仍成立才搬）', rec?.taxonomy?.['visualMass'] === 0.83, JSON.stringify(rec?.taxonomy ?? {}))
  check('搬完后旧 key 不再出现', rec?.taxonomy?.['scale'] === undefined, String(rec?.taxonomy?.['scale']))
  // ⚠️ **form 的分保留但不再是轴** —— 降级不是丢弃。那个概念回来时分数还在。
  check('form 的分保留（降级而非丢弃）', rec?.taxonomy?.['form'] === 0.33, String(rec?.taxonomy?.['form']))
  //⚠️ movement 的分**不搬**：它没有语义等价的现役轴，塞进去等于伪造
  // 一次用户没做过的判断。
  check('movement 的分不搬（没有等价轴）', rec?.taxonomy?.['movement'] === 0.5, String(rec?.taxonomy?.['movement']))
  check('迁进来的坐标一条不少', Object.keys(rec?.taxonomy ?? {}).length === 3, `${Object.keys(rec?.taxonomy ?? {}).length} 条`)

  // ③ 幂等 —— 关库重开是**唯一能测出幂等**的方式，而它还顺带验了
  // 「closeDatabase 之后连接能重开」（踩过：原来是模块级常量，关掉就废了）
  await closeDatabase()
  await getDatabase()
  const spaces2 = await listDesignSpaces()
  const axes2 = await listDesignAxes(mine!.id)
  const rec2 = (await listEntries()).find((entry) => entry.id === 'e-old')
  check(
    '幂等：重开库后空间/轴/坐标都没变',
    spaces2.length === spaces.length && axes2.length === mineAxes.length && rec2?.taxonomy?.['visualMass'] === 0.83,
    `空间 ${spaces2.length} · 轴 ${axes2.length} · visualMass=${String(rec2?.taxonomy?.['visualMass'])}`,
  )

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