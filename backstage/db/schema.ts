import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * v0.2 数据模型：顶层 entries + 按 domain 分流的扩展表。
 *
 * ⚠️ 所有 JSON 数组字段存成 TEXT，默认 '[]'。不用 JSON 扩展类型 —— 读的时候
 * parse 一次，写的时候 stringify，这样导出/导入只需要关心 TEXT 本身，
 * 不依赖 SQLite 的 JSON1 扩展是否编译进来。
 *
 * ⚠️ domain 列表**不进数据库**，留在 types/atlas.ts 的代码常量里。现在只有一个
 * domain，进表的代价是多两张表、多一层 join、顺序和中英文要 seed。等第二个
 * domain 真出现、维度真要分叉了再搬进来。`entries.domain` 这一列本身
 * 就足够支撑 Catalog 跨类型查询 —— 通用化的核心收益不需要 domains 表。
 */

/**
 * 顶层条目。所有 domain 共用。
 *
 * ⚠️ imagePath 从 v0.1 的 NOT NULL 降为可空：通用化后必然有不以图为中心的
 * 采集类型，强制图片会挡住它们。代价是 monster 这个 domain 的图片入口
 * 不再是数据库约束，靠 UI 提示。
 */
export const entries = sqliteTable('entries', {
  id: text('id').primaryKey(),
  domain: text('domain').notNull(),

  name: text('name').notNull().default(''),

  // 来源。sourceUrl 强制 —— 没有出处的东西不进 Atlas。
  sourceUrl: text('sourceUrl').notNull(),
  sourceTitle: text('sourceTitle').notNull().default(''),
  sourceGame: text('sourceGame').notNull().default(''),

  // 资产。imagePath 是相对 media 根的路径，不是绝对路径。
  imagePath: text('imagePath').notNull().default(''),
  imageSource: text('imageSource').notNull().default('file'),
  originalName: text('originalName').notNull().default(''),

  /**
   * ⭐ 观察与判断分列（2026-10-06）。
   *
   * · `observed` —— **我看到了什么**。客观。「攻击前身体膨胀 0.5 秒」在这。
   * · `read`    —— **我认为它为什么成立**。主观。「用silhouette 变化给玩家
   *               telegraph」在这。
   *
   * ⚠️ 分开是这套系统的地基，不是洁癖。混在一个字段里，半年后回头看就
   * 分不清哪句是原作的事实、哪句是我加的解读 —— 而**混在一起的判断等于
   * 没有判断**：不敢改，因为改了对= 承认之前在编。
   *
   * ⚠️ `notes` 保留为 deprecated 别名，读写都映射到 observed。已有的
   * entries 里的 notes 内容**保守地全算 observed** —— 不猜用户哪些是判断，
   * 猜错比不猜贵。要挪的话由用户在界面上自己动手。
   */
  observed: text('observed').notNull().default(''),
  read: text('read').notNull().default(''),

  /**
   * ⭐ 我为什么留着它（2026-10-06）。
   *
   * 「非常简单地用蓄力→冲刺建立了一种高 commitment / 高 readability 的攻击」
   * —— 这句话才是 Creative Atlas 区别于收藏夹与 wiki 的地方：前两者存
   * 「这是什么」，这里存「**这值得我留着的理由是什么**」。
   *
   * 半年后回看，这一句比整条记录里的其他内容都更值钱：它能回答「当初为什么
   * 觉得它有意思」，而 tag 只能回答「它属于哪些类」。
   *
   * 可空 —— 采集时不必每条都写。但**界面上它必须在最显眼的位置**。
   */
  worthwhileBecause: text('worthwhileBecause').notNull().default(''),

  /** @deprecated 已并入 observed。保留是为了让旧行还能读，见上方说明。 */
  notes: text('notes').notNull().default(''),

  status: text('status').notNull().default('inbox'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

/**
 * monster 扩展表。1:1，外键指向 entries.id。
 *
 * ⚠️ **只有 taxonomy 表达不了的结构化数据才放这里。**
 *
 * v0.1 的 bodyType / scale / movement / combatRole / attackPattern（离散版）
 * 已被裁掉 —— 它们和 taxonomy 维度重复，留两套就是让用户填两遍，而且两遍
 * 可能不一致。taxonomy 接管那五项。
 *
 * 剩下的四个 *Pattern 是唯一符合「taxonomy 表达不了」的候选：它们有结构、
 * 有先后和组合关系，不是一条刻度上的位置。
 *
 * ⚠️ 没有第二个 domain 出现之前，「哪些字段属于扩展表」这个划分只有理论
 * 保证。跑起来发现放错层，改的是加列不是改表。
 */
export const monsterEntries = sqliteTable('monster_entries', {
  entryId: text('entryId')
    .primaryKey()
    .references(() => entries.id, { onDelete: 'cascade' }),
  attackPattern: text('attackPattern').notNull().default('[]'),
  behaviorPattern: text('behaviorPattern').notNull().default('[]'),
  telegraph: text('telegraph').notNull().default('[]'),
  reactionPattern: text('reactionPattern').notNull().default('[]'),
})

/**
 * tag 名字字典。跨 domain 复用的同一套 tag 系统。
 *
 * ⚠️ **这里没有 origin 字段 —— 这是有意的。**
 * origin（用户输入 vs 系统自动添加）必须挂在 entry_tags 上：tag 表里 `cute`
 * 只有一行，但可能你手动加过、系统也自动加过。origin 挂在 tag 上，
 * 这一行的归属就歧义了。
 *
 * ⭐ `groupName` 是命名空间（2026-10-06）：primitive / visual / concept /
 * role / context / taxonomy。
 *
 * ⚠️ **为什么现在就需要它**：半年后 800 个 tag 混在一起，就只能靠一个个
 * 划标签做 Faceted Search，而那时再补命名空间要手工回填几百行 —— 而
 * **回填时你已经不记得当初为什么给某个 tag 选了哪个组**。趁现在只有几十个
 * tag、还都记得住的时候定下来，成本是零。
 *
 * ⚠️ **显示名不带前缀**。内部存 `jumper` + group=`primitive`，界面显示
 * 「Jumper」。前缀只是内部知识，不该漏给用户看 —— 否则每个 tag 都变成
 * 「primitive:Jumper」这种噪音。
 */
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  /** 命名空间。空字符串 = 还没归类，不阻塞使用 —— 强制归类会让随手加 tag 变成负担。 */
  groupName: text('groupName').notNull().default(''),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

/**
 * entry ↔ tag 关联。
 *
 * ⚠️ origin + ruleId 在这张表上，不在 tags 上。ruleId 是系统 tag 的来源规则
 * 标识 —— 「属于什么项目」这件事的实现基础就是：项目相关的 tag 全部
 * origin='system' + ruleId，可以按规则整批查、整批追溯。
 */
export const entryTags = sqliteTable(
  'entry_tags',
  {
    entryId: text('entryId')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    tagId: text('tagId')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    origin: text('origin').notNull().default('user'),
    ruleId: text('ruleId').notNull().default(''),
    createdAt: text('createdAt').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.tagId] })],
)

/**
 * taxonomy 打分 —— **我对这条设计做的投影**，不是它的客观属性。
 *
 * ⚠️ 维度定义（维度列表、中英文、顺序、极值）**在代码常量里**，不在数据库。
 * 这是「字段要从数据里长出来」的纪律在框架层的应用：现在只有一个 domain，
 * 进表是提前付成本。等第二个 domain 出现、维度真要分叉再搬。
 *
 * ⚠️ 存 0–1 连续分，**不存星数**。星级是显示编码：`star = round(score × 5)`。
 * 界面是 1–5 星（5 档离散）而数据是 0.01 精度（101 档），这个矛盾靠
 * 「点击 0.2 步进 / 方向键 0.01 步进」化解，映射规则写死在 types/atlas.ts。
 *
 * ⭐⭐ **score 记的是「我把它放在哪」，不是「它客观有多强」**（2026-10-06）。
 *
 * 这是整个 Atlas 的立身之本：Creative Atlas 不做 Wiki。如果 score 是客观属性，
 * 半年后把0.70 改成 0.55 就只能理解成「之前记错了」；而它实际上是「我对
 * 怪物设计的理解变了」—— **不是数据错误，是判断变了**。这两者必须能区分，
 * 否则人就会不敢改分（改了对=承认之前错），于是坐标轴慢慢被当成不可动��
 * 客观事实，Atlas 就退化成考据库。
 *
 * 落实方式：维度本身的语义是「在我这套设计语言里」—— 界面文案与
 * hintZh 都要按这个写；`setAt` 记下这个判断是什么时候做的，让「我改主意了」
 * 有痕迹可循，而不是一次覆盖、没有历史。
 */
export const entryTaxonomy = sqliteTable(
  'entry_taxonomy',
  {
    entryId: text('entryId')
      .notNull()
      .references(() => entries.id, { onDelete: 'cascade' }),
    /**
     * ⭐ 坐标属于哪个设计空间（2026-10-06）。
     *
     * 这是整张表的关键：同一个 entry 在「原作」和「我的」下**各有一组独立
     * 坐标**，而不是同一组坐标有两种读法 —— 两种读法会让人无法判断自己在
     * 改什么，于是不敢改（详见 designSpaces 的注释）。
     */
    spaceId: text('spaceId')
      .notNull()
      .default('')
      .references(() => designSpaces.id, { onDelete: 'cascade' }),
    dimensionKey: text('dimensionKey').notNull(),
    score: real('score').notNull(),
    /** ⭐ 我定这个投影值的时间。不是 db 的时间戳 —— 那是「行被写过」，这个是
     *  「我的判断成形于何时」。改分时会更新它，于是「我改主意了」有痕迹。 */
    setAt: text('setAt').notNull().default(''),
    updatedAt: text('updatedAt').notNull(),
  },
  (table) => [primaryKey({ columns: [table.entryId, table.spaceId, table.dimensionKey] })],
)

/**
 * 导入用的外部 id 映射表。
 *
 * 为什么需要：导出包里的 entryId 可能是别的机器上生成的，直接搬会撞 id。
 * 导入时按 externalId 查这张表，命中就复用本地 id，没命中就新建并登记。
 * 这张表不进导出包 —— 它是导入机制的内部状态，不是数据。
 */
export const importIdMap = sqliteTable('import_id_map', {
  externalId: text('externalId').primaryKey(),
  localId: text('localId').notNull(),
  importedAt: text('importedAt').notNull(),
})
/**
 * ⭐⭐ 设计空间（2026-10-06）—— 坐标系的持有者。
 *
 * 为什么需要这张表：**同一个问题问两次，答案不一样。**
 *
 *   「原作的移动性」    → 对原作的**观察**  → 原作里它有多能跑
 *   「我的移动性」      → 对原作的**解读**  → 我认为它有多能跑
 *
 * 两者挤在同一列（v0.2 的`entry_taxonomy`）时，半年后把0.70 改成 0.55
 * 就**无法判断自己在改什么**：按「属性」读只能理解成记错了，于是不敢改；
 * 按「投影」读才是「我的理解变了」。不敢改分的坐标系会慢慢被当成不可动的
 * 客观事实，那时 Atlas 就退化成 wiki 了 —— 而它本来就不该是 wiki。
 *
 * 所以把空间提升成一等公民：一个 entry 在每个空间下各有一组独立坐标。
 *
 * ⚠️ **空间自带维度定义**（`design_axes`），不与别的空间共享。理由同上：
 * `我的.mobility` 与 `原作.mobility` 是**两个不同的问题**，硬塞进一个共享定义
 * 恰好把这里要分开的区别又合回去。代价是没法画双空间对比图 —— 但那本来
 * 就不是 Atlas 的目标（目标是条目之间在空间里的相对位置）。
 *
 * ⚠️ **空间的维度必须是数据而不是代码常量**（这是被逼出来的，不是偏好）：
 * 「原作」的维度取决于原作是什么游戏（蘑菇打 HP/移动速度，Boss 战打
 * 威胁范围/技能组合），「项目」的维度每个项目都不一样。这两类不可能活在
 * 代码里 —— 改一个项目要改代码重新部署，比开一张表贵得多。
 */
export const designSpaces = sqliteTable('design_spaces', {
  id: text('id').primaryKey(),
  /** 稳定标识（'source' / 'mine' / 'project-mr'）。代码里认它，不认 id。 */
  code: text('code').notNull().unique(),
  labelZh: text('labelZh').notNull(),
  labelEn: text('labelEn').notNull().default(''),
  /** 一句话：在这个空间里，坐标记的是什么。 */
  hintZh: text('hintZh').notNull().default(''),
  /**
   * 排序用的小整数。
   *
   * ⚠️ 存在的理由是「原作」与「我的」有固定顺序 —— 采集时最常写的是
   * 「我的」，而「原作」是可选的补充。用 createdAt 排序做不到「我的总在前面」。
   */
  sortOrder: integer('sortOrder').notNull().default(0),
  /** 系统预置的两个（原作 / 我的）不可删。 */
  isBuiltin: integer('isBuiltin').notNull().default(0),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

/** 某空间下的维度定义。归类用 `groupKey`（展示分组，只管排版不落进坐标）。 */
export const designAxes = sqliteTable('design_axes', {
  id: text('id').primaryKey(),
  spaceId: text('spaceId')
    .notNull()
    .references(() => designSpaces.id, { onDelete: 'cascade' }),
  /** 空间内唯一的短key，写入侧用它定位。 */
  key: text('key').notNull(),
  labelZh: text('labelZh').notNull(),
  labelEn: text('labelEn').notNull().default(''),
  /** 一句话说明这一轴在衡量什么。 */
  hintZh: text('hintZh').notNull().default(''),
  /** 展示分组。只影响排版，不影响坐标语义。 */
  groupKey: text('groupKey').notNull().default(''),
  /** JSON 编码的完整档位数组，从低到高。 */
  anchorsJson: text('anchorsJson').notNull().default('[]'),
  sortOrder: integer('sortOrder').notNull().default(0),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})
