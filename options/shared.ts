/** One reserved value for information that has not been established. */
export const UNCLEAR_KEY = 'unclear' as const

export const COMMON_OPTIONS = {
  [UNCLEAR_KEY]: { label: '不明确', description: '尚未核实；不要据此推断许可或作者身份。' },
} as const
