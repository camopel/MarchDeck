/**
 * March Deck AppShell — shared layout component for all March Deck apps.
 *
 * Provides: nav header (with safe-area), tab bar, content wrapper.
 * Import from: ../../../../shared/ui/AppShell.tsx (or symlink)
 *
 * Usage:
 *   <AppShell title="💰 Trades" tabs={tabs} activeTab={tab} onTabChange={setTab}>
 *     {content}
 *   </AppShell>
 */
import { ReactNode } from 'react'

interface Tab {
  id: string
  label: string
}

interface AppShellProps {
  title: string
  tabs?: Tab[]
  activeTab?: string
  onTabChange?: (id: string) => void
  children: ReactNode
}

export function AppShell({ title, tabs, activeTab, onTabChange, children }: AppShellProps) {
  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Nav header — consistent across all March Deck apps */}
      <div className="nav-header">
        <a href="/" className="nav-back">← Back</a>
        <div className="nav-title">{title}</div>
        <div className="nav-spacer" />
      </div>

      {/* Tab bar */}
      {tabs && tabs.length > 0 && (
        <div className="tab-bar">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => onTabChange?.(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="app-content">
        {children}
      </div>
    </div>
  )
}
