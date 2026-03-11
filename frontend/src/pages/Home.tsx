import { useEffect, useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

const PTR_THRESHOLD = 64

/** Returns true if the string is purely emoji (no Latin/CJK text). */
function isEmoji(str: string): boolean {
  // Strip variation selectors and ZWJ, then check if only emoji remain
  const stripped = str.replace(/[\uFE00-\uFE0F\u200D]/g, '')
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(stripped)
}

interface AppEntry {
  id: string
  name: string
  icon: string
  description: string
  url: string
}

interface AppsResponse {
  apps: Array<{
    id: string
    name: string
    icon: string
    description: string
    builtin: boolean
    enabled: boolean
    status: string
    url?: string
  }>
}

// Badge fetchers: app id → async function that returns a count (or null)
type BadgeFetcher = () => Promise<number | null>

const APP_BADGE_FETCHERS: Record<string, BadgeFetcher> = {
}

// iOS-style solid gradient backgrounds per app
const APP_GRADIENTS: Record<string, string> = {
  'march':    'linear-gradient(135deg, #007AFF, #5856D6)',
  'system':   'linear-gradient(135deg, #5856D6, #AF52DE)',
  'files':    'linear-gradient(135deg, #AF52DE, #FF2D55)',
  'finviz':   'linear-gradient(135deg, #34C759, #30D158)',
  'arxiv':    'linear-gradient(135deg, #FF9500, #FF6B00)',
  'notes':    'linear-gradient(135deg, #FFD60A, #FF9F0A)',
  'cast':     'linear-gradient(135deg, #FF3B30, #FF6B6B)',
  'openclaw': 'linear-gradient(135deg, #FF6B6B, #FF2D55)',
}

const DEFAULT_GRADIENT = 'linear-gradient(135deg, #8E8E93, #636366)'

function sortApps(apps: AppEntry[], order: string): AppEntry[] {
  if (!order) return apps
  const ids = order.split(',').map(s => s.trim()).filter(Boolean)
  const map = new Map(apps.map(a => [a.id, a]))
  const sorted: AppEntry[] = []
  for (const id of ids) {
    const app = map.get(id)
    if (app) {
      sorted.push(app)
      map.delete(id)
    }
  }
  // Append any apps not in the order list
  for (const app of map.values()) sorted.push(app)
  return sorted
}

export default function Home() {
  const navigate = useNavigate()
  const [apps, setApps] = useState<AppEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [badges, setBadges] = useState<Record<string, number>>({})
  const [ptrActive, setPtrActive] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const ptrStartY = useRef<number | null>(null)
  const ptrDeltaY = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)

  const loadApps = useCallback(() => {
    return Promise.all([
      fetch('/api/apps').then(r => r.json()),
      fetch('/api/settings/preferences').then(r => r.json()),
    ]).then(([appsData, prefs]: [AppsResponse, { app_order?: string }]) => {
      const enabled = (appsData.apps ?? [])
        .filter(a => a.enabled && a.status === 'active')
        .map(a => ({
          id: a.id,
          name: a.name,
          icon: a.icon,
          description: a.description,
          url: a.url ?? `/app/${a.id}/`,
        }))
      setApps(sortApps(enabled, prefs.app_order ?? ''))
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadApps()
  }, [loadApps])

  // Fetch badges for apps that have fetchers
  const fetchBadges = useCallback((appList: AppEntry[]) => {
    const appIds = appList.map(a => a.id).filter(id => id in APP_BADGE_FETCHERS)
    appIds.forEach(id => {
      APP_BADGE_FETCHERS[id]().then(count => {
        setBadges(prev => {
          if (count == null) {
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: count }
        })
      })
    })
  }, [])

  // Fetch badges for apps that have fetchers
  useEffect(() => {
    if (apps.length === 0) return
    const appIds = apps.map(a => a.id).filter(id => id in APP_BADGE_FETCHERS)
    if (appIds.length === 0) return

    fetchBadges(apps)
    const interval = setInterval(() => fetchBadges(apps), 60_000) // refresh every 60s
    return () => clearInterval(interval)
  }, [apps, fetchBadges])

  const saveOrder = useCallback((newApps: AppEntry[]) => {
    const order = newApps.map(a => a.id).join(',')
    fetch('/api/settings/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_order: order }),
    }).catch(() => {})
  }, [])

  const openApp = (url: string) => {
    if (editMode) return
    window.location.href = url
  }

  // Pull-to-refresh: detect downward swipe from top of page
  const handlePageTouchStart = (e: React.TouchEvent) => {
    const scrollable = e.currentTarget.querySelector('.content') as HTMLElement | null
    if (!scrollable || scrollable.scrollTop > 0) return
    ptrStartY.current = e.touches[0].clientY
    ptrDeltaY.current = 0
  }

  const handlePageTouchMove = (e: React.TouchEvent) => {
    if (ptrStartY.current === null || editMode) return
    const delta = e.touches[0].clientY - ptrStartY.current
    if (delta > 0) {
      ptrDeltaY.current = delta
      if (delta > PTR_THRESHOLD / 2) setPtrActive(true)
    }
  }

  const handlePageTouchEnd = () => {
    if (ptrDeltaY.current >= PTR_THRESHOLD && !refreshing) {
      setRefreshing(true)
      loadApps().then(() => {
        fetchBadges(apps)
        setRefreshing(false)
      })
    }
    ptrStartY.current = null
    ptrDeltaY.current = 0
    setPtrActive(false)
  }

  // Long press to enter edit mode
  const handleTouchStart = (idx: number, e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      setEditMode(true)
      setDragIdx(idx)
      // Haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(50)
    }, 500)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    // Cancel long press if finger moves too much
    if (longPressTimer.current && touchStartPos.current) {
      const touch = e.touches[0]
      const dx = Math.abs(touch.clientX - touchStartPos.current.x)
      const dy = Math.abs(touch.clientY - touchStartPos.current.y)
      if (dx > 10 || dy > 10) {
        clearTimeout(longPressTimer.current)
        longPressTimer.current = null
      }
    }

    if (dragIdx === null || !gridRef.current) return
    e.preventDefault()
    const touch = e.touches[0]
    const tiles = gridRef.current.querySelectorAll('.app-tile')
    for (let i = 0; i < tiles.length; i++) {
      const rect = tiles[i].getBoundingClientRect()
      if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
        setOverIdx(i)
        break
      }
    }
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) {
      const newApps = [...apps]
      const [moved] = newApps.splice(dragIdx, 1)
      newApps.splice(overIdx, 0, moved)
      setApps(newApps)
      saveOrder(newApps)
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  // Desktop drag support
  const handleDragStart = (idx: number) => {
    if (!editMode) return
    setDragIdx(idx)
  }

  const handleDragOver = (idx: number, e: React.DragEvent) => {
    e.preventDefault()
    setOverIdx(idx)
  }

  const handleDrop = (idx: number) => {
    if (dragIdx !== null && dragIdx !== idx) {
      const newApps = [...apps]
      const [moved] = newApps.splice(dragIdx, 1)
      newApps.splice(idx, 0, moved)
      setApps(newApps)
      saveOrder(newApps)
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  return (
    <div
      className="page"
      onTouchStart={handlePageTouchStart}
      onTouchMove={handlePageTouchMove}
      onTouchEnd={handlePageTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {(ptrActive || refreshing) && (
        <div style={{
          position: 'absolute', top: 'calc(56px + var(--safe-top))', left: 0, right: 0, zIndex: 100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '8px 0', background: 'var(--card-bg)',
          fontSize: 12, color: 'var(--text-secondary)', gap: 6,
          borderBottom: '0.5px solid var(--border)',
        }}>
          <div style={{
            width: 16, height: 16,
            border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
            borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0,
          }} />
          {refreshing ? 'Refreshing…' : 'Release to refresh'}
        </div>
      )}
      <div className="nav-bar">
        {editMode ? (
          <button
            className="nav-btn"
            onClick={() => setEditMode(false)}
            style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent)' }}
          >
            Done
          </button>
        ) : (
          <div className="spacer" />
        )}
        <div className="title">March Deck</div>
        <button
          className="nav-btn"
          onClick={() => editMode ? setEditMode(false) : navigate('/settings')}
          aria-label="Settings"
          style={{ fontSize: 20 }}
        >
          {editMode ? '' : '⚙️'}
        </button>
      </div>

      <div className="content">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : apps.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <div className="empty-text">No apps installed</div>
          </div>
        ) : (
          <>
            <div className="app-grid" ref={gridRef} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
              {apps.map((app, idx) => (
                <button
                  key={app.id}
                  className={`app-tile ${editMode ? 'wiggle' : ''} ${dragIdx === idx ? 'dragging' : ''} ${overIdx === idx && dragIdx !== idx ? 'drop-target' : ''}`}
                  onClick={() => openApp(app.url)}
                  onTouchStart={(e) => handleTouchStart(idx, e)}
                  draggable={editMode}
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(idx, e)}
                  onDrop={() => handleDrop(idx)}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                  aria-label={app.name}
                >
                  <div
                    className="app-icon-wrap"
                    style={{ background: APP_GRADIENTS[app.id] || DEFAULT_GRADIENT }}
                  >
                    {isEmoji(app.icon)
                      ? app.icon
                      : <span className="text-icon">{app.icon}</span>
                    }
                    {badges[app.id] != null && (
                      <div className="app-badge">
                        {badges[app.id]}
                      </div>
                    )}
                  </div>
                  <div className="app-name">{app.name}</div>
                </button>
              ))}
            </div>
            {!editMode && (
              <div style={{ textAlign: 'center', marginTop: 20, fontSize: 12, color: 'var(--text-secondary)' }}>
                Long press to reorder
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
