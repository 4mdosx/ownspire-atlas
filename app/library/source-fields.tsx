'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, Check, CircleAlert, ExternalLink } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { LICENSE_OPTIONS, TRAINABLE_OPTIONS, isHttpSource, licenseOption, type LicenseKey, type Trainable } from '@/options/licensing'
import { COMMON_OPTIONS, UNCLEAR_KEY } from '@/options/shared'

export function SourceFields({ source, author, license, trainable, onSourceChange, onAuthorChange, onLicenseChange, onTrainableChange, onSourceCommit, onAuthorCommit }: {
  source: string
  author: string
  license: LicenseKey
  trainable: Trainable
  onSourceChange: (value: string) => void
  onAuthorChange: (value: string) => void
  onLicenseChange: (value: LicenseKey) => void
  onTrainableChange: (value: Trainable) => void
  onSourceCommit?: () => void
  onAuthorCommit?: () => void
}) {
  const selected = licenseOption(license)
  const url = isHttpSource(source)
  const [tooltipAt, setTooltipAt] = useState<{ top: number; left: number } | null>(null)
  const showLicenseTip = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect()
    const width = Math.min(288, window.innerWidth - 16)
    setTooltipAt({
      top: Math.max(8, Math.min(rect.top - 292, window.innerHeight - 300)),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    })
  }
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="atlas-source" className="mb-1 block text-xs font-medium">Source <span className="text-destructive">*</span></label>
        <Input id="atlas-source" aria-label="Source" value={source} onChange={(event) => onSourceChange(event.target.value)}
          onBlur={onSourceCommit} placeholder="https://… 或出版物名称" className="h-8 text-xs" />
        {source.trim() && (url ? (
          <a href={source.trim()} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 break-all text-[11px] text-primary hover:underline">
            <ExternalLink className="size-3 shrink-0" />打开网址
          </a>
        ) : (
          <p className="mt-1.5 text-[11px] text-muted-foreground">出版物 · {source.trim()}</p>
        ))}
      </div>
      <div>
        <label htmlFor="atlas-author" className="mb-1 block text-xs font-medium">Author</label>
        <Input id="atlas-author" aria-label="Author" value={author} onChange={(event) => onAuthorChange(event.target.value)}
          onBlur={onAuthorCommit} placeholder={COMMON_OPTIONS[UNCLEAR_KEY].label} className="h-8 text-xs" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="atlas-license" className="mb-1 block text-xs font-medium">License</label>
          <div className="flex items-center gap-1.5">
            <select id="atlas-license" aria-label="License" value={license}
              onChange={(event) => onLicenseChange(event.target.value as LicenseKey)}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground shadow-sm">
              {(['状态', 'Creative Commons', '其他'] as const).map((group) => (
                <optgroup key={group} label={group}>
                  {LICENSE_OPTIONS.filter((option) => option.group === group).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="shrink-0">
              <button type="button" aria-label={`${selected.label} 适用范围与训练说明`}
                onMouseEnter={(event) => showLicenseTip(event.currentTarget)} onMouseLeave={() => setTooltipAt(null)}
                onFocus={(event) => showLicenseTip(event.currentTarget)} onBlur={() => setTooltipAt(null)}
                className="grid size-7 place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2">
                <CircleAlert className="size-4" />
              </button>
              {tooltipAt && createPortal(<span role="tooltip" style={{ top: tooltipAt.top, left: tooltipAt.left }}
                className="pointer-events-none fixed z-[100] max-h-[calc(100vh-16px)] w-72 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border bg-card p-3 text-xs leading-relaxed text-card-foreground shadow-xl">
                <strong className="block text-xs">{selected.label}</strong>
                <span className="mt-1 block text-muted-foreground">{selected.uses}</span>
                <span className="mt-2 block font-medium">使用范围</span>
                <span className="mt-1 block space-y-1">
                  {selected.permissions.map((item) => <span key={item.label} className="flex items-start gap-1.5">
                    {item.allowed ? <Check className="mt-0.5 size-3.5 shrink-0 text-green-600" /> : <Ban className="mt-0.5 size-3.5 shrink-0 text-red-600" />}
                    {item.label}
                  </span>)}
                </span>
                <span className="mt-2 block">训练集：{selected.training}</span>
                <span className="mt-1 block text-muted-foreground">这是归档时的保守默认判断；具体用途仍以许可条款和适用法律为准。</span>
              </span>, document.body)}
            </span>
          </div>
          {selected.reference && <a href={selected.reference} target="_blank" rel="noreferrer" className="mt-1 block text-[11px] text-muted-foreground hover:underline">查看许可原文 ↗</a>}
        </div>
        <div>
          <label htmlFor="atlas-trainable" className="mb-1 block text-xs font-medium">Trainable</label>
          <select id="atlas-trainable" aria-label="Trainable" value={trainable}
            onChange={(event) => onTrainableChange(event.target.value === 'yes' ? 'user-yes' : event.target.value as Trainable)}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs text-foreground shadow-sm">
            {TRAINABLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {TRAINABLE_OPTIONS.find((option) => option.value === trainable)?.hint}
          </p>
        </div>
      </div>
    </div>
  )
}
