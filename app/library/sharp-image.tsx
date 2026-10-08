'use client'

import { useState } from 'react'

/**
 * ⭐ 有上限、且**保证完整显示**的图像（2026-10-07）。
 *
 * 需求原文：「这种小图片在大格子里显示的时候，给一个上限，不要显示模糊的版本」
 * +「修复这个图片，让他显示完」。**第二句是第一句漏掉的后果**——
 * 加上限之后如果没管住「怎么缩」，图就会被裁掉一半。所以两件事必须一起做，
 * 而且要能同时成立。
 *
 * ── 三个独立的毛病 ──────────────────────────────────────────
 *
 * ① **糊** = 浏览器把 40×68 的像素画双线性插值到 400px，相邻像素被揉成灰糊一片。
 *    修法：`image-rendering: pixelated` 禁止插值，最近邻放大。
 *    ⚠️ **不能无条件开** —— concept art 这类连续色调的图用 pixelated，
 *    边缘出锯齿，比糊更难看。
 *
 * ② **无限放大** = 一张 40×68 的图铺满 400px 格子，等于宣称「我看清它了」，
 *    其实只是把同一批像素摊开 10 倍。**超过原生分辨率不产生新信息，只产生马赛克。**
 *    修法：按 `naturalWidth/Height` 算一个像素上限。
 *
 * ③ **被裁掉** = 这个最隐蔽，而且是我自己上一轮写出来的。
 *    当时用 `size-full`（`w-full h-full`）+ `object-contain`，指望它「填满盒子
 *    再等比缩」。但 **`h-full` 的前提是父元素有确定高度**；一旦父容器高度是
 *    `auto`（或那个类没编译出来），`h-full` 解析失败 → 退回图片自然高度 →
 *    而自然高度又被 ② 的上限放大到几百 px → 溢出容器 → 被 `overflow-hidden`
 *    裁掉一截。**表现是「图只显示了一半」，而原因藏在两个类的交互里。**
 *    修法见下面 `style` 的注释：**用 min() 把上限与容器尺寸取交集**，
 *    这样「不超过上限」和「不超过容器」是同一个声明，两件事不可能互相破坏。
 *
 * ── 分工 ────────────────────────────────────────────────────
 *
 * 卡片负责**认得出是什么**，drawer 负责**看清每个像素**。
 * 这两件事挤在一张卡片上时，两边都做不到 —— 所以卡片 4×、drawer 8×。
 */
export const TINY_EDGE = 256
export const UPSCALE_CAP_TINY = 4
export const UPSCALE_CAP_LARGE = 2
/** 抽屉给到 8×：最近邻放大后仍能数清像素的上限，再多只是格子。 */
export const UPSCALE_CAP_DETAIL = 8

export function SharpImage({
  src,
  alt,
  className,
  imgClassName,
  maxUp,
  loading = 'lazy',
}: {
  src: string
  alt: string
  /** 外层容器（负责占位与居中）。 */
  className?: string
  /** <img> 自身的额外 class。 */
  imgClassName?: string
  /** 覆盖放大倍数。默认按图的像素尺寸自动判。 */
  maxUp?: number
  loading?: 'lazy' | 'eager'
}) {
  /** 放大上限（CSS px）。null = 尺寸未知，此时不加 style。 */
  const [cap, setCap] = useState<number | null>(null)
  const [tiny, setTiny] = useState(false)

  return (
    <span className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading={loading}
        decoding="async"
        onLoad={(event) => {
          const img = event.currentTarget
          // naturalWidth 是 0 = 没加载出来 / 不是位图。这时算出的上限是 0，
          // 会把图压成一条线 —— 必须挡住，且宁可不加限制（下面 style 会处理）。
          const w = img.naturalWidth
          const h = img.naturalHeight
          if (!w || !h) return
          const isTiny = Math.max(w, h) <= TINY_EDGE
          setTiny(isTiny)
          setCap(Math.max(w, h) * (maxUp ?? (isTiny ? UPSCALE_CAP_TINY : UPSCALE_CAP_LARGE)))
        }}
        /**
         * ⚠️⚠️ **这里就是修「显示不完整」的那一行，别改回 size-full。**
         *
         * `min(<cap>px, 100%)` 让两条约束在**同一条声明**里取交集：
         * · `min(cap, 100%)` → 宽度既不超过放大上限，也不超过容器
         * · 同理高度
         * 于是**无论父容器高度是确定值还是 auto，img 都不可能溢出**。
         *
         * 之前写成 `size-full` + `object-contain` 时，缩放完全依赖「父元素有确定
         * 高度」这个前提；前提不成立时 h-full 静默失效，图被裁掉一截，
         * 而代码里没有任何地方写着「我依赖父元素高度」——这类 bug 只能靠
         * 把约束写成**不依赖任何前提的形式**来根治。
         *
         * ⚠️ 必须显式写 `width/height: auto`：不加的话 <img> 的固有尺寸会
         * 参与布局，在 grid 里可能撑破容器。
         */
        style={cap ? { maxWidth: `min(${cap}px, 100%)`, maxHeight: `min(${cap}px, 100%)`, width: 'auto', height: 'auto' } : undefined}
        // ⚠️ arbitrary property 而不是 `pixelated` 类：Tailwind 4 不保证提供
        // image-rendering 工具类，写死就等于赌编译期。
        className={['max-w-full object-contain', tiny ? '[image-rendering:pixelated]' : '', imgClassName ?? ''].join(' ')}
      />
    </span>
  )
}
