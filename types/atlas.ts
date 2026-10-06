export type EntryStatus = 'inbox' | 'reviewed' | 'reference'

export const ENTRY_STATUSES: EntryStatus[] = ['inbox', 'reviewed', 'reference']

export const STATUS_LABEL: Record<EntryStatus, string> = {
  inbox: 'Inbox',
  reviewed: 'Reviewed',
  reference: 'Reference',
}

export type ImageSource = 'paste' | 'file'

/* ──────────────────────────────────────────────────────────────
 * Domain
 *
 * ⚠️ domain 列表**不进数据库**，留在代码常量里。现在只有一个 domain，
 * 进表是提前付设计成本（多两张表、多一层 join、顺序和中英文要 seed）。
 * `entries.domain` 这一列本身足够支撑 Catalog 跨类型查询。
 *
 * 等第二个 domain 真出现、维度真要分叉，再把这份常量搬进表 —— 那时候搬
 * 是有数据支撑的。
 * ────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────
 * ⭐⭐⭐ Domain = 一个创作问题，不是一类资产（2026-10-07 token 裁定）
 *
 * > **每个 Domain 只研究一种创作问题，多个 Domain 加起来才是一个完整设计。**
 *
 * ⚠️ 这条把 domain 从「分类」重新定义成「**问题**」，判据随之全变：
 *
 * · **能不能加一个新 domain** = 是不是出现了一个**现有问题答不了的新问题**
 *   （不是「又有一类素材了」）
 * · **某个字段该放哪** = 它服务于哪个问题。**答案不唯一时说明是两个问题**
 * · **一个 domain 里出现「顺便也记一下…」** = 那个「顺便」属于另一个问题
 *
 * ⚠️ 昨天砍掉 monster 的 `combat` / `role` 两条轴，用的就是这条判据：
 * 「它在关卡里怎么用」不是「它长什么样」，那是**另一个创作问题**。
 * 而它们**没有被搬家** —— 因为那个问题现在没人问（见 §一 的问题地图）。
 *
 * ⚠️ **同一个 Reference 可以被多个 domain 分别解读**，而那不叫重复：
 * 蘑菇既是 Creature Design 的研究对象（怎么做到极简又可辨识），
 * 也是 Encounter Design 的研究对象（多快出、多密、给多少反馈）。
 * **Reference 是素材，domain 是镜头 —— 同一段素材在不同镜头下是不同的东西。**
 *
 * ⚠️ 所以「数据模型要不要让 entry 属于多个 domain」是个**独立问题**，
 * 不由这条原则直接推出。答案见 §一：现在只有 1 条数据 + 1 个 domain，
 * 改成多对多是纯预付成本。**判据已写下，触发条件是第二个 domain 真出现。**
 * ────────────────────────────────────────────────────────────── */

export type DomainCode = 'creature'

export type DomainDef = {
code: DomainCode
  /** 好懂的名字 —— 负责让人一眼知道「这是什么素材」。 */
  labelZh: string
  labelEn: string
  /**
   * ⭐ 这个 domain **回答什么问题** —— 负责划边界。
   *
   * ⚠️ 与 labelZh 的分工是刻意的：名字负责好懂，问题句负责准确。
   * 「Creature Design」好懂但不划边界（什么 creature？）；
   * 「它长成什么样、为什么有辨识度」才划得清边界。
   */
  creativeQuestion: string
  /** 一句话补充（选库页副标）。⚠️ 必须与实际轴一致 —— 写过期的文案
   *  会让界面承诺我们刚决定不做的事（昨天就发生过一次）。 */
  hintZh: string
  icon: string
}

export const DOMAINS: readonly DomainDef[] = [
  {
    code: 'creature',
    labelZh: '生物设计',
    labelEn: 'Creature Design',
    creativeQuestion: '它长成什么样，为什么有辨识度？',
    // ⚠️ 这行字曾经写「生物形态、战斗定位、行为模式」—— 而 combat / role
    // 在 2026-10-06 就被砍掉了。**过期的 hint 比没有 hint 更坏**：它会让
    // 界面承诺一件我们刚刚决定不做的事，而选库页是这件事的第一印象。
    hintZh: '轮廓 · 比例 · 配色 · 视觉复杂度 · 辨识度 · 气质',
    icon: 'creature',
  },
] as const

export function isDomainCode(value: string): value is DomainCode {
  return DOMAINS.some((domain) => domain.code === value)
}

export function domainOf(code: string): DomainDef | null {
  return DOMAINS.find((domain) => domain.code === code) ?? null
}

/**
 * ⚠️ 旧 code → 新 code（2026-10-07`monster` 改名 `creature`）。
 *
 * ⚠️ **保留映射是为了让历史数据与旧导出包继续可用**，而不是舍不得改。
 * 读的时候两个 code 都认；写的时候一律写新的那个。
 * 真的删掉这条别名应该是「数据里再也没有旧值、导出包也全升级完」之后的事。
 */
export const DOMAIN_ALIASES: Readonly<Record<string, DomainCode>> = { monster: 'creature' }

/** 归一化 code：认旧名，返回新名。不认识就原样返回（调用方决定怎么报错）。 */
export function normalizeDomainCode(value: string): string {
  return DOMAIN_ALIASES[value] ?? value
}

/* ──────────────────────────────────────────────────────────────
 * Taxonomy —— 连续打分，与 tag 系统无关
 *
 * tag 是「是/不是」的分类标签，taxonomy 是「有多」的度量刻度。两者互不隶属：
 * · tag 任意输入，没有白名单，一套 tag 跨 domain 复用
 * · taxonomy 维度由 domain 确定，中英文双语，存 0–1 连续分
 *
 * ⚠️ **维度定义在这里，不在数据库。** 见上方 domain 同理。
 *
 * ⭐ **两级结构：domain → group → dimension**（2026-10-06）
 *
 * 原来是平铺五个维度（form/scale/movement/combat/role），界面上就是五行，
 * 看不出它们之间「谁和谁是一伙的」。现在按语义聚成两个 group：
 *
 *   形态 Form        它长什么样 —— 是什么东西、多大
 *     ├ form    形态型
 *     └ scale   体量
 *   战斗 Combat      它怎么动、怎么打、干什么
 *     ├ movement  移动
 *     ├ combat    战斗方式
 *     └ role      定位
 *
 * 「Scale 放进 Form」「Movement 和 Role 放进 Combat」就是这个意思。
 * group 只是**展示层的归类**，不落库、不进 entry_taxonomy —— 那是 key 的
 * 扁平结构该背的债，不该让数据模型替界面的分组长久买单。
 * ────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────
 * ⭐⭐ 设计空间（2026-10-06）
 *
 * 一个 entry 在每个空间下各有一组独立坐标。空间本身是**数据**（可建、可增），
 * 因为「原作」的维度取决于原作是什么游戏、「项目」的维度每个项目都不一样 ——
 * 这两类都不可能活在代码常量里。
 *
 * ⚠️ 空间之间**不共享维度**。`我的.mobility` 与 `原作.mobility` 是两个不同的
 * 问题，硬塞进一个共享定义恰好把这里要分开的区别又合回去。
 *
 * ⚠️ 下面那份 MONSTER_TAXONOMY 现在只是**首次初始化的种子** —— 维度归数据库
 * 管之后，它不再被写入侧当作权威来源读。留着是为了让新库开箱就有完整的
 * 「我的」空间，而不是空表。
 * ────────────────────────────────────────────────────────────── */

export type DesignSpace = {
  id: string
  /** 稳定标识。代码与脚本认它，不认 id。 */
  code: string
  labelZh: string
  labelEn: string
  /** 一句话：这个空间里记的是什么。 */
  hintZh: string
  /** 小 = 靠前。「我的」(10) 排在「原作」(20) 前面，因为采集时最常写的是它。 */
  sortOrder: number
  /** 预置空间（原作 / 我的）不可删。 */
  isBuiltin: boolean
  createdAt: string
  updatedAt: string
}

export type DesignAxisGroup = {
  labelZh: string
  labelEn: string
}

export type DesignAxis = {
  id: string
  spaceId: string
  /** 空间内唯一的短key，写入侧用它定位。 */
  key: string
  labelZh: string
  labelEn: string
  hintZh: string
  /** 展示分组。只影响排版，不影响坐标语义。 */
  group: DesignAxisGroup
  /** 完整档位，从低到高。⚠️ 不是示例词 —— 用户只敢在看得见的档位里选。 */
  anchors: string[]
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/* ──────────────────────────────────────────────────────────────
 * ⭐ 分析状态：proposal 与 committed 是不同的东西（2026-10-07）
 *
 * ⚠️ **这不是「审核流程」，是「别把不同确定度的东西混着用」。**
 *
 * 一条坐标有两种可能的来源：
 * · **我看了图之后自己打的分** → committed，这是我确认过的判断
 * · **机器读出来的**（将来接 LLM 或视觉模型） → draft，那是一个**提案**
 *
 * ⚠️ **混在一起会有两个具体的坏处**：
 * 1. **可信度不可见**：空间分布图上「这条在 0.62」和「这条在 0.62」看起来一样，
 *    但一个是猜的一个是我判的。半年后回看分不清。
 * 2. **筛选被污染**：「筛选所有 threatAffinity > 0.7 的」会把机器的猜测
 *    和我的判断一起捞出来 —— 而这两者不该有同等权重。
 *
 * ⚠️ 所以规则很硬：**`draft` 的坐标不参与筛选**，也不在分布图上占位
 * （虚线渲染）。要变 committed 就得有人确认过 —— 这是「机器填充」与
 * **「人的判断」之间那道必须存在的缝。
 *
 * ⚠️ **默认 committed**：v0 的采集全是手工填的，没人确认等于已确认。
 * 将来接机器时**必须显式传 draft**，而不是反过来让所有存量数据变成 draft。
 * ────────────────────────────────────────────────────────────── */

export type AnalysisStatus = 'draft' | 'review' | 'committed'

export const ANALYSIS_STATUSES: readonly AnalysisStatus[] = ['draft', 'review', 'committed'] as const

export const ANALYSIS_STATUS_LABEL: Record<AnalysisStatus, string> = {
  draft: '提案',
  review: '待定稿',
  committed: '已定稿',
}

export const ANALYSIS_STATUS_HINT: Record<AnalysisStatus, string> = {
  draft: '机器读的，还没我确认 —— 不参与筛选',
  review: '我看过，暂未定稿',
  committed: '我确认过的判断',
}

export function isAnalysisStatus(value: string): value is AnalysisStatus {
  return (ANALYSIS_STATUSES as readonly string[]).includes(value)
}

/** 系统预置的两个空间的 code。 */
export const SPACE_SOURCE = 'source'
export const SPACE_MINE = 'mine'

/**
 * ⭐ 维度的 key 是**空间内的自由字符串**，不是联合类型（2026-10-06）。
 *
 * 维度定义进数据库之后，轴的集合随空间变化 —— 所以这里不能再是
 * `'form' | 'scale' | ...` 那种固定枚举。每加一条轴都要能直接用，不该逼着
 * 改类型定义，而那正是「维度该归数据库管」这件事要摆脱的。
 *
 * ⚠️ 只在**种子**里用得上具体字符串（MONSTER_TAXONOMY）。运行时的校验靠
 * 「这个空间实际有哪些轴」（service 层查 design_axes），不靠类型。
 */
export type TaxonomyDimensionKey = string

/** 维度的归类 group —— 纯展示用，不进数据库。 */
export type TaxonomyGroupKey = 'form' | 'read'

export type TaxonomyDimensionDef = {
  key: TaxonomyDimensionKey
  labelZh: string
  labelEn: string
  /** 归到哪个 group。决定界面上挨着谁。 */
  group: TaxonomyGroupKey
  /**
   * 这一轴的**完整档位**，从低到高。
   *
   * ⚠️ 这不是「示例值」—— 它是打分的语义边界。给 3 个词当示例，用户就只
   * 敢在这 3 个词里选；给全档位，用户才知道「5分」该落在哪个词上。
   * 星级是 0–1 连续分，档位描述的是那条轴上**有意义的几个位置**。
   */
  anchors: readonly string[]
  /** 一句话说明这一轴在衡量什么。给人看。 */
  hintZh: string
}

export type TaxonomyGroupDef = {
  key: TaxonomyGroupKey
  labelZh: string
  labelEn: string
  hintZh: string
}

/**
 * ⭐ group 分成两堆（2026-10-07）：**形态**（它长什么样）与 **可读性**
 * （它让人读出什么）。分开是因为它们回答的是两个不同的问题 ——
 * 而「一个 domain 只研究一种创作问题」那条原则，在 domain 内部同样适用。
 *
 * · 形态：体量 / 比例 / 形体语言 / 视觉复杂度 —— 都是「客观可见的形状」
 * · 可读性：熟悉度 / 气质 —— 都是「它让人读出什么」，与形状有关但不是形状
 */
export const MONSTER_TAXONOMY_GROUPS: readonly TaxonomyGroupDef[] = [
  { key: 'form', labelZh: '形态', labelEn: 'Form', hintZh: '它长什么样 —— 客观可见的形状' },
  { key: 'read', labelZh: '可读性', labelEn: 'Readability', hintZh: '它让人读出什么 —— 辨识度与第一眼气质' },
] as const

/**
 * domain → group 定义。
 *
 * ⚠️ 与 TAXONOMY_BY_DOMAIN 同理：group 也不进数据库。组件通过
 * `groupsOf(domain)` 取，**不直接 import MONSTER_TAXONOMY_GROUPS** ——
 * 否则换 domain 就要改组件，那等于把 domain 的知识漏进界面代码里。
 */
export const TAXONOMY_GROUPS_BY_DOMAIN: Record<DomainCode, readonly TaxonomyGroupDef[]> = {
  creature: MONSTER_TAXONOMY_GROUPS,
}

/**
 * ⭐⭐ creature domain 的维度 —— **六根视觉轴**（2026-10-07）。
 *
 * 这六根不是「我拍脑袋想的」，而是**只看一眼 concept art 就能打出分**的那种。
 * 判据：**你能在设定图上指着一个地方说「这里更圆一点」** —— 指得出来才配当
 * 坐标轴；指不出来的（animation、vfx、lighting）就该划给别的 domain。
 *
 * ⚠️ **上一版的四根轴里有三根是分类，不是刻度**（这才是真正的错误）：
 * · ~~`form` 形态型~~（blob/humanoid/beast）→ 它是**归类**（「它属于哪一
 *   类」），不是刻度上的位置。已降级为 tag 分组 `form`（Body Form）。
 * · ~~`palette` 配色~~（monochrome/limited/duotone）→ 它是**特征描述**。
 *   颜色结构改为 `observed` 里的观察项。
 * · ~~`mobility` 动势~~→ 明确划给 **Animation domain**：造型阶段回答
 *   「它静止时什么质感」，动作阶段回答「它动起来什么质感」，两个问题。
 *
 * ⚠️ 2026-10-06 域收窄时我只问了「这条轴属不属于形象设计」，没问
 * 「**它是一条刻度吗**」。前者过了，后者没过 —— 而后者才是轴与分类的分界。
 *
 * ⚠️ **Threat ↔ Affinity 是「气质」不是「强度」**：蘑菇可以是 menacing ——
 * 它看起来危险与它实际上有多强无关。所以它和 combat domain 里的「威胁」
 * 重名，但不是同一件事。
 */
export const MONSTER_TAXONOMY: readonly TaxonomyDimensionDef[] = [
  {
    key: 'visualMass',
    labelZh: '视觉体量',
    labelEn: 'Visual Mass',
    group: 'form',
    anchors: ['weightless', 'slight', 'solid', 'heavy', 'massive'],
    hintZh: '画面上占多满 —— 注意是**视觉**重量，不是实际体积',
  },
  {
    key: 'proportion',
    labelZh: '比例',
    labelEn: 'Proportion',
    group: 'form',
    anchors: ['head-heavy', 'chibi', 'natural', 'heroic', 'elongated'],
    hintZh: '头身比与各部位大小关系 —— 剪影能不能一眼读懂全靠它',
  },
  {
    key: 'shapeLanguage',
    labelZh: '形体语言',
    labelEn: 'Shape Language',
    group: 'form',
    anchors: ['round', 'organic', 'boxy', 'angular', 'spiky'],
    hintZh: '基本形状倾向。圆 = 可亲，硬边 = 机械/冷，尖角 = 攻击性',
  },
  {
    key: 'visualComplexity',
    labelZh: '视觉复杂度',
    labelEn: 'Visual Complexity',
    group: 'form',
    anchors: ['silhouette-first', 'readable', 'detailed', 'ornate', 'busy'],
    hintZh: '缩小到多小还认得出 —— 直接决定生产成本',
  },
  {
    key: 'familiarity',
    labelZh: '熟悉度',
    labelEn: 'Familiarity',
    group: 'read',
    anchors: ['abstract', 'archetypal', 'recognizable', 'referential', 'realistic'],
    hintZh: '离日常经验多近 —— 决定观众能否立刻读懂它的意图',
  },
  {
    key: 'threatAffinity',
    labelZh: '气质',
    labelEn: 'Threat ↔ Affinity',
    group: 'read',
    anchors: ['menacing', 'wild', 'neutral', 'appealing', 'gentle'],
    hintZh: '第一眼给的情感态度 —— 与「它有多强」无关，蘑菇可以是 menacing',
  },
] as const

/** domain → 维度定义。换 domain 就换一组维度。 */
export const TAXONOMY_BY_DOMAIN: Record<DomainCode, readonly TaxonomyDimensionDef[]> = {
  creature: MONSTER_TAXONOMY,
}

export function dimensionsOf(domain: DomainCode): readonly TaxonomyDimensionDef[] {
  return TAXONOMY_BY_DOMAIN[domain] ?? []
}

/** 某个 group 下的维度，按定义顺序。界面上按 group 分块渲染用它。 */
export function dimensionsInGroup(
  domain: DomainCode,
  group: TaxonomyGroupKey,
): readonly TaxonomyDimensionDef[] {
  return dimensionsOf(domain).filter((dimension) => dimension.group === group)
}

/** 某个 domain 的 group 列表（按定义顺序）。 */
export function groupsOf(domain: DomainCode): readonly TaxonomyGroupDef[] {
  return TAXONOMY_GROUPS_BY_DOMAIN[domain] ?? []
}

export function dimensionKeysOf(domain: DomainCode): readonly TaxonomyDimensionKey[] {
  return dimensionsOf(domain).map((dimension) => dimension.key)
}

/** 维度 key 是否属于该 domain —— **写入侧校验**用的就是这个。 */
export function isDimensionOf(domain: DomainCode, key: string): boolean {
  return dimensionsOf(domain).some((dimension) => dimension.key === key)
}

export function dimensionOf(domain: DomainCode, key: TaxonomyDimensionKey): TaxonomyDimensionDef | null {
  return dimensionsOf(domain).find((dimension) => dimension.key === key) ?? null
}

/* ── 星级 ⇆ score 映射 ──────────────────────────────────────────
 *
 * ⚠️ 数据是 0–1 连续分（0.01 精度），界面是 1–5 星（5 档离散）。这两个数
 * 对不上，映射规则必须先定死，否则后面对不上：
 *
 * · 点击星星 → 0.2 步进（半星可点，10 档）
 * · 方向键   → 0.01 步进
 * · 显示     → star = round(score × 5)，悬停显示原始 score
 *
 * **星级是显示编码，不是数据。** 数据库存 score，不存星数。
 * ────────────────────────────────────────────────────────────── */

export const TAXONOMY_MIN = 0
export const TAXONOMY_MAX = 1
export const TAXONOMY_STARS = 5
/** 点击一颗星的步进：半星可点 → 10 档。 */
export const TAXONOMY_CLICK_STEP = 0.2
/** 方向键微调步进。 */
export const TAXONOMY_FINE_STEP = 0.01

export function scoreToStars(score: number): number {
  return Math.round(clampScore(score) * TAXONOMY_STARS)
}

export function starsToScore(star: number): number {
  return clampScore(round2(star / TAXONOMY_STARS))
}

/**
 * 档位 → score。
 *
 * ⭐ 这是「点档位等于打分」的映射（2026-10-06）。**落在该轴的倒数第几格，
 * 就打该轴上对应的那个分数** —— 所以点「huge」不是打满星，而是打这一轴
 * 的第五档（0.8）。留一档给「比 huge 还夸张」的情况，也避免点任何档位都
 * 变成 1.0，那样 0.8 以上的精度就只能靠数字框，界面上再也走不到。
 *
 * 3 档的轴落在 0.33 / 0.67（round2 后0.34 / 0.66 是显示层的妥协，存的是
 * 精确值）；5 档 → 0.2/0.4/0.6/0.8；6 档 → 0.17/0.33/0.5/0.67/0.83。
 */
/**
 * ⚠️ 参数是**最小形状** `{ anchors: readonly string[] }` 而不是
 * `TaxonomyDimensionDef` —— 因为坐标轴现在有两种来源：代码里的
 * TaxonomyDimensionDef（首次种子）与数据库里的 DesignAxis。它们对
 * 「档位 → 分数」是同一套规则，写死具体类型就等于逼着写两份实现，
 * 而两份实现早晚有一处忘了改，且那种 bug 只在数据里显形。
 */
export function anchorToScore(dimension: { anchors: readonly string[] }, anchor: string): number | null {
  const index = dimension.anchors.findIndex((item) => item === anchor)
  if (index < 0 || dimension.anchors.length === 0) return null
  // (index + 1) / (length + 1)：第 1 档在1/(n+1)，最后一档在 n/(n+1)，永不等于 1。
  return clampScore(round2((index + 1) / (dimension.anchors.length + 1)))
}

/** score → 最接近的档位词。用于把已存的score 显示成「huge」这样的词。 */
export function scoreToAnchor(dimension: { anchors: readonly string[] }, score: number): string | null {
  if (score === undefined) return null
  const target = clampScore(score)
  let best: string | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const anchor of dimension.anchors) {
    const candidate = anchorToScore(dimension, anchor)
    if (candidate === null) continue
    const gap = Math.abs(candidate - target)
    if (gap < bestGap) {
      bestGap = gap
      best = anchor
    }
  }
  return best
}

export function clampScore(score: number): number {
  if (Number.isNaN(score)) return TAXONOMY_MIN
  return Math.min(TAXONOMY_MAX, Math.max(TAXONOMY_MIN, score))
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 星级控件的档位：0.0 / 0.2 / 0.4 / … / 1.0，共 **6 档**。
 *
 * ⚠️ 半星可点意味着**一整星 = 0.2**（5 星 = 1.0），所以鼠标能到的
 * 位置是 0/0.2/0.4/0.6/0.8/1.0 —— 只有 6 个值，不是 11 个。
 *
 * 「5颗星 + 半星」和「11 档」不是一回事：星数是 5，半星只是让每颗星
 * 能落在两个位置，总共仍是 6 个可点值。11 档对应的是 0.1 步进（每颗星
 * 10 个位置），那是给滑杆用的精度。
 *
 * 想要 0.01 精度走滑杆 / 方向键，不靠点击。
 */
export const TAXONOMY_STEPS: number[] = Array.from(
  { length: Math.round((TAXONOMY_MAX - TAXONOMY_MIN) / TAXONOMY_CLICK_STEP) + 1 },
  (_, index) => round2(TAXONOMY_MIN + index * TAXONOMY_CLICK_STEP),
)

/* ──────────────────────────────────────────────────────────────
 * Gallery 尺寸
 *
 * ⚠️ 这是**显示偏好**，不是数据 —— 所以不进数据库，跟 domain 选择一样
 * 存 localStorage。
 *
 * 为什么要三档：v0 的实际用途是「一眼扫过去找东西」。160px 看得清细节但
 * 一屏只放几张；96px 一屏几十张但看不清图；256px 是「停下来仔细看」的
 * 状态。**三档对应三种意图**，不是「大中小」审美选择。
 * ────────────────────────────────────────────────────────────── */

export type GallerySize = 'sm' | 'md' | 'lg'

export const GALLERY_SIZES: readonly GallerySize[] = ['sm', 'md', 'lg'] as const

export const GALLERY_SIZE_LABEL: Record<GallerySize, string> = {
  sm: '小',
  md: '中',
  lg: '大',
}

/**
 * 每档的**最小列宽**（px）—— `auto-fill` 的那个 minmax。
 *
 * ⚠️ 为什么数字往小收：v0 的库是靠「扫」来用的，160px 一屏放不下几张，
 * 扫不动。96px 才是「一屏能扫几十个」的量级。lg 留给需要看清图的时刻。
 */
export const GALLERY_MIN_COLUMN: Record<GallerySize, number> = {
  sm: 96,
  md: 160,
  lg: 260,
}

export function isGallerySize(value: string): value is GallerySize {
  return (GALLERY_SIZES as readonly string[]).includes(value)
}

/* ──────────────────────────────────────────────────────────────
 * Tag origin —— 区分用户输入与系统自动添加
 *
 * ⚠️ origin 挂在**关联**上，不挂在 tag 实体上：tags 表里 `cute` 只有一行，
 * 但可能你手动加过、系统也自动加过。origin 挂在 tag 上，归属就歧义了。
 *
 * ruleId 是系统 tag 的来源规则标识 —— 「属于什么项目」的实现基础就是：
 * 项目相关的 tag 全部 origin='system' + ruleId，可按规则整批查、整批追溯。
 * ────────────────────────────────────────────────────────────── */

export type TagOrigin = 'user' | 'system'

export const TAG_ORIGINS: readonly TagOrigin[] = ['user', 'system']

export const ORIGIN_LABEL: Record<TagOrigin, string> = {
  user: '手动',
  system: '系统',
}

/* ──────────────────────────────────────────────────────────────
 * 数据类型
 * ────────────────────────────────────────────────────────────── */

export type Tag = {
  id: string
  name: string
  /**
   * 命名空间（2026-10-06）。空字符串 = 还没归类。
   *
   * ⚠️ 不强制：随手加一个 tag 不该被「必须先选组」拦住。归类是给
   * Faceted Search 用的，欠着不影响找得到东西。
   */
  group: TagGroup
  createdAt: string
  updatedAt: string
}

/**
 * ⭐⭐ tag 的四种参照系（2026-10-07 token 裁定）。
 *
 * **判据：这条 tag 在回答哪个问题？** 四个问题互不重叠，所以四组也互不重叠 ——
 * 而「互不重叠」正是 Faceted Search 能用的前提（同组内多选是 OR，跨组是 AND，
 * 那个组合只有在组之间真的正交时才有意义）。
 *
 * ⚠️ **Primitive 全部交给 tag，坐标轴一条不留**（同日改动）。原来的
 * `form`（blob/humanoid/beast）就是典型：它是「它属于哪一类」，是**归类**，
 * 不是刻度上的位置。**轴与分类的分界就在这里**。
 *
 * ⚠️ 组名从英文直译过来（motif / form / feature / device），因为它们其实是
 * **四种不同的参照系**，各说各的：
 * · motif 问「像什么」—— 借用现实世界的原型
 * · form 问「是什么」—— 身体结构本身
 * · feature 问「有什么」—— 具体零件
 * · device 问「怎么做的」—— 造型手法与视觉惯例
 */
export type TagGroupKey = 'motif' | 'form' | 'feature' | 'device' | 'taxonomy'

export const TAG_GROUP_KEYS: readonly TagGroupKey[] = [
  'motif',
  'form',
  'feature',
  'device',
  'taxonomy',
] as const

export const TAG_GROUP_LABEL: Record<TagGroupKey, string> = {
  motif: '原型来源',
  form: '形体',
  feature: '特征',
  device: '视觉手法',
  taxonomy: '未归类',
}

export const TAG_GROUP_HINT: Record<TagGroupKey, string> = {
  motif: '它像什么 —— animal:cat / plant:mushroom / object:clock',
  form: '它是什么身体 —— blob / biped / quadruped / serpentine / floating',
  feature: '它身上有什么 —— horn / wing / tail / shell / oversized-head',
  device: '造型怎么做的 —— face-on-body / asymmetry / layered-shell',
  taxonomy: '还没归类的 —— 点一下能改',
}

export type TagGroup = TagGroupKey | ''

export function isTagGroupKey(value: string): value is TagGroupKey {
  return (TAG_GROUP_KEYS as readonly string[]).includes(value)
}

/** 带关联元数据的 tag —— 列表和导出用这个形态。 */
export type EntryTag = Tag & {
  origin: TagOrigin
  ruleId: string
}

export type TaxonomyScore = {
  dimensionKey: TaxonomyDimensionKey
  /**
   * ⭐ **我对这条设计做的投影**，不是它的客观属性（2026-10-06）。
   *
   * 「0.7」的意思是「在我的怪物设计语言里，我把它理解为 0.7」，
   * 不是「原作里它是 0.7」。半年后改成 0.55 不是数据错误，
   * 是我对怪物设计的理解变了 —— 这个区别是整个 Atlas 的立身之本。
   */
  score: number
  /** 我定这个投影值的时间。改分会更新它，于是「我改主意了」有痕迹可循。 */
  setAt: string
  updatedAt: string
}

/** 顶层条目。所有 domain 共用。 */
export type Entry = {
  id: string
  domain: DomainCode
  name: string

  sourceUrl: string
  sourceTitle: string
  sourceGame: string

  /** 相对 media 根的路径，例如 'up-49b8269f/0f1e443c-preview.png'。相对路径是为了导出与迁移。 */
  imagePath: string
  imageSource: ImageSource
  originalName: string

  /**
   * ⭐ 观察 —— **我看到了什么**。「攻击前身体膨胀 0.5 秒」写这里。
   *
   * 与 read 严格分开：混在一起的话，半年后无法分辨哪句是原作事实、
   * 哪句是我的解读 —— 而混在一起的判断等于没有判断。
   */
  observed: string

  /**
   * ⭐ 判断 —— **我认为它为什么成立**。「用 silhouette 变化给玩家
   * telegraph」写这里。
   */
  read: string

  /**
   * ⭐ 我为什么留着它。整条记录里半年后最值钱的一句。
   *
   * tag 只能回答「它属于哪些类」，这一句回答「当初为什么觉得有意思」。
   * 可空，但界面上必须在最显眼的位置 —— 它才是这个系统区别于
   * 收藏夹与 wiki 的地方。
   */
  worthwhileBecause: string

  status: EntryStatus

  /**
   * ⭐ 分析的确定度（2026-10-07）。
   *
   * 默认 `committed` —— v0 的采集全是手工填的，没人确认等于已确认。
   * 将来接机器填值时**必须显式传 draft**：那样它的坐标就不会被当成
   * 「我确认过的判断」参与筛选。
   */
  analysisStatus: AnalysisStatus

  createdAt: string
  updatedAt: string
}

/**
 * monster domain 的扩展数据。1:1，外键指向 entries.id。
 *
 * ⚠️ **2026-10-06 起只有 entryId** —— 原来那四个行为字段
 *（attackPattern / behaviorPattern / telegraph / reactionPattern）
 * 在域收窄为**形象设计**时被砍掉了（见 db/schema.ts 的说明）。
 *
 * ⚠️ 类型保留成**只有 entryId 的对象**而不是整个删掉：它标明了「这条属于
 * monster 库」这个分流事实，而将来真有需要时它就是新字段的落点 ——
 * 到那时不必重新引入一层分流机制。
 */
export type MonsterExtension = {
  entryId: string
}

/**
 * 列表页 / 详情页要显示的聚合形态。
 *
 * ⚠️ taxonomy 是 sparse 的：没打分的维度不出现。所以是 Record 不是定长数组。
 * extension 只在 domain 匹配时才有值。
 */
export type EntryDetail = Entry & {
  tags: EntryTag[]
  /**
   * ⭐ 坐标。key 是**该空间下的轴 key**，不是固定枚举（2026-10-06）。
   *
   * ⚠️ 维度定义搬进数据库之后，轴的集合随设计空间变化，所以这里不能再是
   * `Partial<Record<TaxonomyDimensionKey, ...>>` 那种固定键 —— 那会让每加
   * 一条轴都要改类型定义，而那正是「维度该归数据库管」这件事要摆脱的。
   */
  taxonomy: Partial<Record<string, number>>
  extension: MonsterExtension | null
}

/** 列表页卡片：不含 extension 的派生内容，但要够画卡片。 */
export type EntrySummary = Entry & {
  tags: EntryTag[]
  /**
   * ⭐ 坐标。key 是**该空间下的轴 key**，不是固定枚举（2026-10-06）。
   *
   * ⚠️ 维度定义搬进数据库之后，轴的集合随设计空间变化，所以这里不能再是
   * `Partial<Record<TaxonomyDimensionKey, ...>>` 那种固定键 —— 那会让每加
   * 一条轴都要改类型定义，而那正是「维度该归数据库管」这件事要摆脱的。
   */
  taxonomy: Partial<Record<string, number>>
}