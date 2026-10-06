import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Creative Atlas',
  description: '个人创意采集库 · 怪物是首个库，通用化后按 domain 分流',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-svh antialiased">{children}</body>
    </html>
  )
}