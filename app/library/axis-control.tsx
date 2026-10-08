'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  anchorToScore,
  clampScore,
  round2,
  scoreToAnchor,
  scoreToStars,
  starsToScore,
  AXIS_FINE_STEP,
  AXIS_STARS,
} from '@/types/atlas'

/**
 * ⭐ AxisValues 度量控件。
 *
 * ⚠️ **星级是显示编码，不是数据。** 底层存 0–1 连续分。
 *
 * 交互分三档（这是「界面 5 档 vs 数据 101 档」这个矛盾的化解方式）：
 * · **点档位词 → 直接定到该档的分数**（2026-10-06 加）。这是最快的路径：
 *   「它是 huge」是一次点击，不该是「拖到第 4.5 颗星」。
 * · **点星 → 0.2 步进**（半星可点，鼠标一档能到 6 个位置）
 * · **数字框 → 0.01 步进**（101 个位置）
 *
 * 所以「凭直觉评价」和「精确到百分位」都有路可走，中间那段靠点星。
 *
 * ⚠️ **没打过分的维度显示为全灰星，不是 0 分。** 「我没评过这条」
 * 和「我觉得它是 0 分」是两件事 —— 前者不该被后者污染。这也是
 * entry_axis_values 要做 sparse 表的原因。
 */
/**
 * ⭐ 一条坐标轴的最小形状。
 *
 * ⚠️ 刻意只声明用到的字段，而不是 `AxisSeedDef` 或 `DesignAxis`：
 * 坐标轴现在有两种来源（代码里的种子定义、数据库里的 design_axes），
 * 而这两个组件只关心「名字 + 档位 + 提示」。写死具体类型会逼着渲染层
 * 为两种来源各写一个组件，而它们唯一的区别只有取数路径。
 */
export type AxisLike = {
  key: string
  labelZh: string
  labelEn: string
  hintZh: string
  anchors: readonly string[]
}

export function AxisControl({
  dimension,
  value,
  onChange,
  onClear,
  /** 显示档位词快选行。Quick Add 与 Detail 都开着。 */
  showAnchors = true,
}: {
  dimension: AxisLike
  /** undefined = 没打过分。 */
  value?: number
  onChange: (score: number) => void
  onClear: () => void
  showAnchors?: boolean
}) {
  // 悬停时的预览星数（含半星，如 2.5）。null = 没悬停，显示真实值。
  const [hoverStar, setHoverStar] = useState<number | null>(null)
  const scored = value !== undefined
  const star = hoverStar ?? (value !== undefined ? scoreToStars(value) : 0)
  const shownScore = hoverStar !== null ? starsToScore(hoverStar) : value
  const currentAnchor = value !== undefined ? scoreToAnchor(dimension, value) : null

  /** 点左半边 = 半星（star-0.5），右半边 = 整星。点 0 星区 = 清除。 */
  const commit = (target: number, event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const half = event.clientX - rect.left < rect.width / 2
    const next = half ? target - 0.5 : target
    if (next < 1) return onClear()
    onChange(starsToScore(next))
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* ⚠️ 档位词快选放上面而不是下面：它是最快的路径，星是精细微调。
          顺序反过来等于让人先做精细操作再用快的。 */}
      {showAnchors && (
        <div className="flex flex-wrap gap-1">
          {dimension.anchors.map((anchor) => {
            const active = currentAnchor === anchor
            const target = anchorToScore(dimension, anchor)
            return (
              <button
                key={anchor}
                type="button"
                title={target !== null ? `${anchor} = ${target.toFixed(2)}` : undefined}
                onClick={() => {
                  if (active) return onClear()
                  if (target !== null) onChange(target)
                }}
                className={cn(
                  'rounded-full border px-1.5 py-px text-[10px] transition-colors',
                  active
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {anchor}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div
          className="flex items-center"
          role="radiogroup"
          aria-label={`${dimension.labelZh} ${dimension.labelEn}`}
          onMouseLeave={() => setHoverStar(null)}
        >
          {Array.from({ length: AXIS_STARS }, (_, index) => index + 1).map((target) => {
            const full = star >= target
            const half = !full && star >= target - 0.5
            return (
              <button
                key={target}
                type="button"
                role="radio"
                aria-checked={scored && star >= target}
                aria-label={`${target} 星`}
                title={`${target} 星 = ${starsToScore(target).toFixed(2)}`}
                className="relative px-[3px] text-base leading-none"
                onMouseEnter={() => setHoverStar(target)}
                onClick={(event) => commit(target, event)}
              >
                {/* 半星用一个裁掉右半的实色星叠在空星上 —— 不靠 border 宽度 hack。 */}
                <span className={cn('transition-colors', scored ? 'text-muted-foreground/25' : 'text-muted-foreground/20')}>★</span>
                {full && <span className="absolute inset-0 flex items-center justify-center text-foreground">★</span>}
                {half && (
                  <span className="absolute inset-y-0 left-[3px] flex items-center overflow-hidden text-foreground" style={{ width: '50%' }}>
                    ★
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* 悬停时显示预览分，静止时显示真实分。数字框可填 0.01 精度。 */}
        <input
          type="number"
          aria-label={`${dimension.labelZh} 精确值`}
          min={0}
          max={1}
          step={AXIS_FINE_STEP}
          value={shownScore !== undefined ? shownScore.toFixed(2) : ''}
          placeholder="—"
          onChange={(event) => {
            const next = Number(event.target.value)
            if (!Number.isNaN(next)) onChange(clampScore(next))
          }}
          className="h-6 w-14 rounded border bg-transparent px-1 text-right text-[11px] tabular-nums outline-none focus:border-foreground/40"
        />

        {scored && (
          <button type="button" onClick={onClear} title="清除这个维度的打分" className="text-[11px] text-muted-foreground hover:text-foreground">
            清除
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 一个维度一块：中英文 + 档位快选 + 星级 + 语义提示。
 *
 * ⚠️ 纵向排列（label 在上、控件在下）而不是横向挤一行 —— 抽屉加宽到能
 * 放下 6 个档位词之后，横向会把星级和数字框挤出视口。
 */
export function AxisRow({
  dimension,
  value,
  onChange,
  onClear,
  showAnchors = true,
}: {
  dimension: AxisLike
  value?: number
  onChange: (score: number) => void
  onClear: () => void
  showAnchors?: boolean
}) {
  const currentAnchor = value !== undefined ? scoreToAnchor(dimension, value) : null
  return (
    <div className="space-y-1 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium">
          {dimension.labelZh} <span className="text-[11px] font-normal text-muted-foreground">{dimension.labelEn}</span>
        </p>
        {value !== undefined && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {currentAnchor ?? ''} · {round2(value).toFixed(2)}
          </span>
        )}
      </div>
      <AxisControl
        dimension={dimension}
        value={value}
        onChange={onChange}
        onClear={onClear}
        showAnchors={showAnchors}
      />
      <p className="text-[10px] text-muted-foreground">{dimension.hintZh}</p>
    </div>
  )
}
