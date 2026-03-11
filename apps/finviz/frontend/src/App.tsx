import { useEffect, useState, useRef, useCallback } from 'react'
import { AppShell } from '../../../../shared/ui/AppShell'

const API = '/api/app/finviz'

interface SummaryData {
  status: 'ready' | 'generating'
  summary?: string
  article_count?: number
  generated_at?: string
}

interface CrawlerStats {
  pending_count: number
  failed_count: number
  total: number
  with_content: number
  last_crawl_at: string | null
}

interface CrawlerStatus {
  enabled: boolean
  running: boolean
}

interface AlertConfig {
  enabled: boolean
  schedule_hour: number
  schedule_minute: number
}

function renderMarkdown(md: string): string {
  return md.trim()
    .replace(/^---+$/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^#### (.+)$/gm, '<h4 style="font-size:14px;font-weight:600;margin:10px 0 4px">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;font-weight:600;margin:12px 0 4px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:700;margin:14px 0 4px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:17px;font-weight:700;margin:14px 0 6px">$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent)" target="_blank">$1</a>')
    .replace(/^- (.+)$/gm, '<li style="margin:1px 0;margin-left:16px;list-style:disc">$1</li>')
    .replace(/\n\n/g, '<br/>')
    .replace(/\n/g, ' ')
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 44, height: 26, borderRadius: 13, position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--border)', transition: 'background 0.2s',
        opacity: disabled ? 0.5 : 1,
      }}>
      <span style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        width: 20, height: 20, borderRadius: 10, background: '#fff',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </div>
  )
}

export default function App() {
  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [crawlerStats, setCrawlerStats] = useState<CrawlerStats | null>(null)
  const [crawlerStatus, setCrawlerStatus] = useState<CrawlerStatus>({ enabled: false, running: false })
  const [articleCount, setArticleCount] = useState<number | null>(null)
  const [alertConfig, setAlertConfig] = useState<AlertConfig>({
    enabled: false, schedule_hour: 8, schedule_minute: 0
  })
  const [showSettings, setShowSettings] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const pollRef = useRef<number | null>(null)

  const isGenerating = loading || data?.status === 'generating'

  const refreshStats = useCallback(() => {
    fetch(`${API}/article-counts`).then(r => r.json()).then(d => setArticleCount(d?.Market ?? null)).catch(() => {})
    fetch(`${API}/stats`).then(r => r.json()).then(d => setCrawlerStats(d)).catch(() => {})
  }, [])

  // Fetch summary — load cached only (no regenerate) unless explicitly requested
  const fetchSummary = useCallback((regen = false) => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (regen) setLoading(true)
    const params = new URLSearchParams({ topic: 'Market' })
    if (regen) params.set('regenerate', '1')
    fetch(`${API}/summary/24h?${params}`)
      .then(r => r.json())
      .then((d: SummaryData) => {
        setData(d)
        setLoading(false)
        if (d.status === 'generating') {
          pollRef.current = window.setInterval(() => {
            fetch(`${API}/summary/24h?topic=Market`)
              .then(r => r.json())
              .then((d2: SummaryData) => {
                setData(d2)
                if (d2.status === 'ready' && pollRef.current) {
                  clearInterval(pollRef.current); pollRef.current = null
                  refreshStats()
                }
              })
              .catch(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } })
          }, 3000)
          setTimeout(() => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }, 120000)
        }
      })
      .catch(() => setLoading(false))
  }, [refreshStats])

  // Auto-load on mount — just load cached summary, don't generate
  useEffect(() => {
    fetchSummary(false)  // load cached only
    refreshStats()
    fetch(`${API}/crawler`).then(r => r.json()).then(d => setCrawlerStatus(d)).catch(() => {})
    fetch(`${API}/alert-config`).then(r => r.json()).then(d => {
      if (d && typeof d.enabled === 'boolean') setAlertConfig(d)
    }).catch(() => {})
    const statsInterval = window.setInterval(refreshStats, 30000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      clearInterval(statsInterval)
    }
  }, [fetchSummary, refreshStats])

  const handleGenerate = () => {
    if (isGenerating) return
    fetchSummary(true)  // force regenerate
  }

  const toggleCrawler = async (enabled: boolean) => {
    setCrawlerStatus(prev => ({ ...prev, enabled }))
    try {
      await fetch(`${API}/crawler`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
    } catch {
      setCrawlerStatus(prev => ({ ...prev, enabled: !enabled }))
    }
  }

  const handleCleanNews = async () => {
    if (cleaning) return
    if (!confirm('Delete all downloaded news and articles from the database?')) return
    setCleaning(true)
    try {
      await fetch(`${API}/clean-news`, { method: 'POST' })
      // Refresh stats
      fetch(`${API}/stats`).then(r => r.json()).then(d => setCrawlerStats(d)).catch(() => {})
      fetch(`${API}/article-counts`).then(r => r.json()).then(d => setArticleCount(d?.Market ?? null)).catch(() => {})
      setData(null)
    } catch {}
    setCleaning(false)
  }

  const saveAlertConfig = async (config: AlertConfig) => {
    setAlertConfig(config)
    try {
      await fetch(`${API}/alert-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
    } catch {}
  }

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch { return iso }
  }

  return (
    <AppShell title="📰 Finviz">
      <div style={{ height: 'calc(100dvh - 49px - var(--safe-top, 0px))', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      {/* Control row */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 16px', background: 'var(--card-bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button onClick={handleGenerate} disabled={isGenerating}
          style={{
            flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
            fontSize: 15, fontWeight: 600, cursor: isGenerating ? 'not-allowed' : 'pointer',
            opacity: isGenerating ? 0.5 : 1,
            background: 'var(--accent)', color: '#fff',
          }}>
          24h Summary
        </button>
        <button onClick={() => setShowSettings(!showSettings)}
          style={{
            padding: '10px 14px', borderRadius: 10, border: 'none',
            fontSize: 15, cursor: 'pointer',
            background: showSettings ? 'var(--accent)' : 'var(--surface)',
            color: showSettings ? '#fff' : 'var(--text)',
          }}>
          ⚙️
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div style={{ padding: '12px 16px', background: 'var(--card-bg)', borderBottom: '0.5px solid var(--border)' }}>

          {/* Crawler toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Crawler</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {crawlerStatus.enabled ? (crawlerStatus.running ? 'Running now' : 'Every 5 min') : 'Disabled'}
              </div>
            </div>
            <Toggle checked={crawlerStatus.enabled} onChange={toggleCrawler} />
          </div>

          {/* Daily alert toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: alertConfig.enabled ? 8 : 14 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Daily Alert</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Push notification</div>
            </div>
            <Toggle checked={alertConfig.enabled} onChange={v => saveAlertConfig({ ...alertConfig, enabled: v })} />
          </div>

          {/* Alert time picker (only when enabled) */}
          {alertConfig.enabled && (
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Alert Time</label>
              <input type="time"
                value={`${String(alertConfig.schedule_hour).padStart(2, '0')}:${String(alertConfig.schedule_minute).padStart(2, '0')}`}
                onChange={e => {
                  const [h, m] = e.target.value.split(':').map(Number)
                  saveAlertConfig({ ...alertConfig, schedule_hour: h, schedule_minute: m })
                }}
                style={{
                  width: '100%', padding: '8px', borderRadius: 8, fontSize: 15,
                  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
                }}
              />
            </div>
          )}

          {/* Clean news button */}
          <button onClick={handleCleanNews} disabled={cleaning}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 10, border: 'none',
              fontSize: 14, fontWeight: 600, cursor: cleaning ? 'not-allowed' : 'pointer',
              background: '#ff3b30', color: '#fff', opacity: cleaning ? 0.5 : 1,
            }}>
            {cleaning ? 'Cleaning...' : '🗑 Clean All News'}
          </button>
        </div>
      )}

      {/* Crawler stats */}
      {crawlerStats && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 16px', fontSize: 11, color: 'var(--text-secondary)',
          background: 'var(--card-bg)', borderBottom: '0.5px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {crawlerStats.with_content > 0 && <span>{crawlerStats.with_content} articles</span>}
            {crawlerStats.pending_count > 0 && <span>· {crawlerStats.pending_count} pending</span>}
            {crawlerStats.pending_count === 0 && crawlerStats.with_content > 0 && (
              <><span style={{ color: '#34c759', fontSize: 12 }}>✓</span><span>all downloaded</span></>
            )}
          </div>
          {crawlerStats.last_crawl_at && (
            <span>{formatDate(crawlerStats.last_crawl_at)}</span>
          )}
        </div>
      )}

      {/* Content */}
      <div style={{ padding: '8px 8px 32px' }}>
        {loading && !data ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
            <div style={spinnerStyle} />Loading...
          </div>
        ) : data?.status === 'generating' ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
            <div style={spinnerStyle} />
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Generating summary...</div>
            <div style={{ fontSize: 13 }}>30–60 seconds</div>
          </div>
        ) : data?.status === 'ready' && data.summary ? (
          <div style={{ padding: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
              <span>{data.article_count} articles</span>
              {data.generated_at && <span>{formatDate(data.generated_at)}</span>}
            </div>
            <div className="md-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.summary) }} />
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📰</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>No summary available</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Tap "24h Summary" to generate</div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .md-content { font-size: 14px; line-height: 1.7; word-break: break-word; }
        .md-content strong { font-weight: 600; }
        .md-content li { padding-left: 4px; margin: 1px 0; margin-left: 16px; list-style: disc; }
      `}</style>
      </div>
    </AppShell>
  )
}

const spinnerStyle: React.CSSProperties = {
  width: 24, height: 24, margin: '0 auto 12px',
  border: '2.5px solid var(--border)', borderTopColor: 'var(--accent)',
  borderRadius: '50%', animation: 'spin 0.7s linear infinite',
}
