import { COMMON_OPTIONS, UNCLEAR_KEY } from './shared'

export type Trainable = 'yes' | 'no' | typeof UNCLEAR_KEY | 'user-yes'
export type AutomaticTrainable = Exclude<Trainable, 'user-yes'>

export const TRAINABLE_OPTIONS: ReadonlyArray<{ value: Trainable; label: string; hint: string }> = [
  { value: 'yes', label: 'Yes · 许可推导', hint: '许可没有阻止按当前保守规则纳入训练集；仍须满足署名等条件。' },
  { value: 'no', label: 'No', hint: '当前许可限制或你手动决定不纳入训练集。' },
  { value: UNCLEAR_KEY, label: COMMON_OPTIONS[UNCLEAR_KEY].label, hint: '授权或适用范围尚未核实，不自动纳入训练集。' },
  { value: 'user-yes', label: 'User Yes · 手动确认', hint: '你已根据额外许可或判断手动允许纳入训练集。' },
]

export type LicenseOption = {
  value: string
  label: string
  group: '状态' | 'Creative Commons' | '其他'
  uses: string
  permissions: ReadonlyArray<{ label: string; allowed: boolean }>
  training: string
  defaultTrainable: AutomaticTrainable
  reference?: string
}

/**
 * Conservative dataset policy. It is a workflow default, not a legal conclusion.
 * CC's own AI-training guidance notes that copyright exceptions and use context vary.
 */
const LICENSE_DEFINITIONS = [
  { value: UNCLEAR_KEY, label: '不明确 · 未核实授权', group: '状态', uses: '网页可访问不代表内容可再利用；先保留出处与作者线索。', training: '默认不纳入训练集，待核实具体许可。', defaultTrainable: UNCLEAR_KEY },
  { value: 'cc0-1.0', label: 'CC0 1.0', group: 'Creative Commons', uses: '权利人尽可能放弃版权；可复制、修改、分享与商业使用。', training: '默认可纳入训练集。', defaultTrainable: 'yes', reference: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  { value: 'cc-by-4.0', label: 'CC BY 4.0', group: 'Creative Commons', uses: '可分享、改编和商业使用；须署名、附许可链接并标注修改。', training: '默认可纳入训练集，但应满足适用的署名要求。', defaultTrainable: 'yes', reference: 'https://creativecommons.org/licenses/by/4.0/' },
  { value: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0', group: 'Creative Commons', uses: '可分享、改编和商业使用；须署名，公开分享改编作品时须相同方式共享。', training: '默认可纳入；公开分享相关改编内容时还需检查 ShareAlike 条件。', defaultTrainable: 'yes', reference: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  { value: 'cc-by-nc-4.0', label: 'CC BY-NC 4.0', group: 'Creative Commons', uses: '可署名后非商业分享和改编；不许可商业使用。', training: '通用训练集保守设为 No；非商业训练须单独判断。', defaultTrainable: 'no', reference: 'https://creativecommons.org/licenses/by-nc/4.0/' },
  { value: 'cc-by-nc-sa-4.0', label: 'CC BY-NC-SA 4.0', group: 'Creative Commons', uses: '仅非商业使用；须署名，公开分享改编作品时须相同方式共享。', training: '通用训练集保守设为 No；非商业用途与 ShareAlike 条件须单独判断。', defaultTrainable: 'no', reference: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
  { value: 'cc-by-nd-4.0', label: 'CC BY-ND 4.0', group: 'Creative Commons', uses: '可署名后分享原作，包括商业分享；不得公开分享改编版本。', training: '按 CC 的保守训练指南设为 No。', defaultTrainable: 'no', reference: 'https://creativecommons.org/licenses/by-nd/4.0/' },
  { value: 'cc-by-nc-nd-4.0', label: 'CC BY-NC-ND 4.0', group: 'Creative Commons', uses: '仅可署名后非商业分享未改编原作。', training: '按 CC 的保守训练指南设为 No。', defaultTrainable: 'no', reference: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
  { value: 'public-domain-verified', label: '公有领域 · 已核实', group: '其他', uses: '已核实版权限制届满或不适用；可复制与再利用。', training: '默认可纳入训练集；仍需留意隐私等其他限制。', defaultTrainable: 'yes', reference: 'https://creativecommons.org/public-domain/pdm/' },
  { value: 'all-rights-reserved', label: '保留所有权利', group: '其他', uses: '未授予复制、改编或再分发许可；仅保存出处供查证。', training: '默认 No，除非另获明确许可。', defaultTrainable: 'no' },
  { value: 'personal-use-only', label: '仅限个人使用', group: '其他', uses: '仅按权利人明示的个人使用范围使用；不可推断可再分发。', training: '默认 No。', defaultTrainable: 'no' },
  { value: 'custom-permission', label: '单独授权', group: '其他', uses: '适用范围以实际授权文本为准，需自行留存授权证据。', training: '未记录明确训练许可时为不明确；确认后可手动设为 User Yes。', defaultTrainable: UNCLEAR_KEY },
 ] as const satisfies ReadonlyArray<Omit<LicenseOption, 'permissions'>>

export type LicenseKey = (typeof LICENSE_DEFINITIONS)[number]['value']

function permissionList(value: string): ReadonlyArray<{ label: string; allowed: boolean }> {
  const verified = value === 'cc0-1.0' || value === 'public-domain-verified'
  const cc = value.startsWith('cc-by-')
  const nonCommercial = value.includes('-nc-')
  const noDerivatives = value.includes('-nd-')
  const personal = value === 'personal-use-only'
  return [
    { label: '保存来源和作者线索', allowed: true },
    { label: '复制与分享', allowed: verified || cc },
    { label: '改编并分享', allowed: verified || (cc && !noDerivatives) },
    { label: '商业使用', allowed: verified || (cc && !nonCommercial) },
    { label: '纳入通用训练集', allowed: verified || (cc && !nonCommercial && !noDerivatives) },
    ...(personal ? [{ label: '超出个人范围使用', allowed: false }] : []),
  ]
}

export const LICENSE_OPTIONS: ReadonlyArray<LicenseOption & { value: LicenseKey }> = LICENSE_DEFINITIONS.map((option) => ({ ...option, permissions: permissionList(option.value) }))

export function isLicenseKey(value: unknown): value is LicenseKey {
  return typeof value === 'string' && LICENSE_OPTIONS.some((option) => option.value === value)
}

export function isTrainable(value: unknown): value is Trainable {
  return typeof value === 'string' && TRAINABLE_OPTIONS.some((option) => option.value === value)
}

export function licenseOption(value: LicenseKey): LicenseOption {
  return LICENSE_OPTIONS.find((option) => option.value === value)!
}

export function automaticTrainable(license: LicenseKey): AutomaticTrainable {
  return licenseOption(license).defaultTrainable
}

/** URL recognition is deliberately presentation-only; publications are valid sources. */
export function isHttpSource(source: string): boolean {
  try {
    const url = new URL(source.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
