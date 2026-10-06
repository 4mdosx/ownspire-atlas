export type EntryStatus = 'inbox' | 'reviewed' | 'reference'

export const ENTRY_STATUSES: EntryStatus[] = ['inbox', 'reviewed', 'reference']

export const STATUS_LABEL: Record<EntryStatus, string> = {
  inbox: 'Inbox',
  reviewed: 'Reviewed',
  reference: 'Reference',
}

export type ImageSource = 'paste' | 'file'

/** 受控 tag 的五个维度。自由 tag 不受此约束。 */
export const CONTROLLED_TAXONOMY = {
  form: ['humanoid', 'beast', 'blob', 'insect', 'construct'],
  scale: ['tiny', 'small', 'medium', 'large', 'huge'],
  movement: ['ground', 'flying', 'jumping', 'crawling', 'teleport'],
  combat: ['melee', 'ranged', 'charger', 'zoner', 'summoner'],
  role: ['fodder', 'pressure', 'disruptor', 'tank', 'elite', 'boss'],
} as const

export type TaxonomyDimension = keyof typeof CONTROLLED_TAXONOMY

/**
 * 反查：某个 tag 属于哪个维度？不在五组之内就是自由 tag。
 * 筛选面板靠它把受控 tag 分组显示。
 */
export function dimensionOf(tagName: string): TaxonomyDimension | null {
  for (const [dimension, values] of Object.entries(CONTROLLED_TAXONOMY)) {
    if ((values as readonly string[]).includes(tagName)) return dimension as TaxonomyDimension
  }
  return null
}

export type MonsterEntry = {
  id: string
  name: string

  sourceUrl: string
  sourceTitle: string
  sourceGame: string

  /** 相对 media 根的路径，例如 'm-01x2y3z/0.png'。相对路径是为了导出与迁移。 */
  imagePath: string
  imageSource: ImageSource
  originalName: string

  notes: string

  bodyType: string
  scale: string
  /** JSON 编码的字符串数组。未设置时是 '[]'，不是 null —— 空和未填在这个版本没有区别。 */
  movement: string
  combatRole: string
  attackPattern: string

  status: EntryStatus
  createdAt: string
  updatedAt: string

  tags: Tag[]
}

export type Tag = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

/** 列表页要显示的字段。刻意不含 imagePath 的原图尺寸等派生信息。 */
export type EntrySummary = Omit<MonsterEntry, 'movement' | 'combatRole' | 'attackPattern'> & {
  movement: string[]
  combatRole: string[]
  attackPattern: string[]
}