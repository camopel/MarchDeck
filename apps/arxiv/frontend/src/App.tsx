import React, { useEffect, useState, useCallback } from 'react'

const API = '/api/app/arxiv'

interface Paper {
  arxiv_id: string; title: string; published: string
}
interface Stats {
  papers: number; categories: number
  last_crawl?: string; last_crawl_count?: number
}
interface PaperDetail {
  arxiv_id: string; title: string; abstract: string | null
  abstract_translated: string | null; translate_language: string | null
  published: string; has_pdf: boolean
}

function CrawlProgress({ apiBase, onRunningChange, onStatsRefresh }: { apiBase: string; onRunningChange?: (running: boolean) => void; onStatsRefresh?: () => void }) {
  const [status, setStatus] = useState<{running: boolean; message: string} | null>(null)

  useEffect(() => {
    let timer: number | null = null
    let wasRunning = false
    const poll = () => {
      fetch(`${apiBase}/crawl/status`).then(r => r.json()).then(d => {
        setStatus(d)
        // Only propagate running=true or transition from running→stopped
        if (d.running) {
          onRunningChange?.(true)
          // Refresh stats during download
          if (d.message?.includes('Downloading')) onStatsRefresh?.()
        }
        if (wasRunning && !d.running) {
          onRunningChange?.(false)
          onStatsRefresh?.()
        }
        wasRunning = d.running
        if (d.running) {
          timer = window.setTimeout(poll, 2000)
        }
      }).catch(() => {})
    }
    poll()
    const bg = window.setInterval(() => {
      if (!timer) poll()
    }, 10000)
    return () => { if (timer) clearTimeout(timer); clearInterval(bg) }
  }, [apiBase, onRunningChange, onStatsRefresh])

  if (!status || (!status.running && !status.message)) return null

  return (
    <div style={{
      fontSize: 12, color: 'var(--text-secondary)',
      padding: '6px 0', marginBottom: 8,
    }}>
      {status.running && '⏳ '}{status.message}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<'search' | 'categories'>('search')
  const [crawlMessage, setCrawlMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const busySetAt = React.useRef(0)  // timestamp when user clicked crawl

  const markBusy = useCallback(() => {
    busySetAt.current = Date.now()
    setBusy(true)
  }, [])

  const refreshStats = useCallback(() => {
    fetch(`${API}/stats`).then(r => r.ok ? r.json() : null).then(s => { if (s) setStats(s) }).catch(() => {})
  }, [])

  // Poll crawl status
  useEffect(() => {
    let timer: number
    const poll = () => {
      fetch(`${API}/crawl/status`).then(r => r.json()).then(d => {
        setCrawlMessage(d.message || '')
        if (d.running) {
          setBusy(true)
          if (d.message?.includes('Downloading')) refreshStats()
          timer = window.setTimeout(poll, 1000)
        } else {
          setBusy(prev => {
            if (prev) refreshStats()
            return false
          })
          timer = window.setTimeout(poll, 5000)
        }
      }).catch(() => { timer = window.setTimeout(poll, 5000) })
    }
    poll()
    return () => clearTimeout(timer)
  }, [refreshStats])
  const [stats, setStats] = useState<Stats | null>(null)
  const [categories, setCategories] = useState<{code: string; description: string; group: string; enabled: boolean}[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Paper[]>([])
  const [searching, setSearching] = useState(false)
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [togglingCat, setTogglingCat] = useState<string | null>(null)

  const toggleCategory = async (code: string, currentEnabled: boolean) => {
    setTogglingCat(code)
    try {
      const r = await fetch(`${API}/categories/${encodeURIComponent(code)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentEnabled }),
      })
      const data = await r.json()
      setCategories(prev => prev.map(c =>
        c.code === code ? { ...c, enabled: !currentEnabled } : c
      ))
      // Update stats with new counts
      if (data.categories_enabled !== undefined || data.papers !== undefined) {
        setStats(prev => prev ? {
          ...prev,
          categories: data.categories_enabled ?? prev.categories,
          papers: data.papers ?? prev.papers,
        } : prev)
      }
    } catch (e) {
      console.error('Toggle failed:', e)
    }
    setTogglingCat(null)
  }

  useEffect(() => {
    Promise.all([
      fetch(`${API}/stats`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${API}/categories`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, c]) => {
      if (s) setStats(s)
      else setError('ArXiv database not found. Run the install script first.')
      if (c?.categories) setCategories(c.categories)
      setLoading(false)
    })
  }, [])

  const doSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const r = await fetch(`${API}/search?q=${encodeURIComponent(query)}&top_k=20`)
      const data = await r.json()
      setResults(data.results || [])
    } catch { setResults([]) }
    setSearching(false)
  }

  const [showPdf, setShowPdf] = useState(false)
  const [translating, setTranslating] = useState(false)

  const viewPaper = async (arxivId: string) => {
    setShowPdf(false)
    setTranslating(false)
    try {
      const r = await fetch(`${API}/paper/${arxivId}`)
      const data = await r.json()
      setDetail(data)

      // Translation is now triggered by the Translate button — no auto-fire
    } catch {}
  }

  if (detail) {
    return (
      <div className="page">
        <div className="nav-bar">
          <button className="nav-btn" onClick={() => { setDetail(null); setShowPdf(false) }}>← Back</button>
          <div className="title">Paper</div>
          <a href={`https://arxiv.org/abs/${detail.arxiv_id}`} target="_blank" rel="noreferrer"
            style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>arXiv ↗</a>
        </div>
        <div style={{ padding: 16 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8, lineHeight: 1.4 }}>{detail.title}</h2>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 16 }}>
            {new Date(detail.published).toLocaleDateString()}
          </div>

          {detail.abstract && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                {detail.abstract_translated
                  ? `Abstract (${detail.translate_language})`
                  : translating
                    ? <span>Abstract <span style={{ color: 'var(--accent)', fontStyle: 'italic' }}>(translating…)</span></span>
                    : 'Abstract'}
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                {detail.abstract_translated || detail.abstract}
              </div>
              {/* Translate button — hidden once translated */}
              {!detail.abstract_translated && !translating && detail.translate_language && (
                <button onClick={() => {
                  setTranslating(true)
                  fetch(`${API}/paper/${detail.arxiv_id}/translate`)
                    .then(r => r.json())
                    .then(t => {
                      if (t.translated) {
                        setDetail(prev => prev ? { ...prev, abstract_translated: t.translated } : prev)
                      } else {
                        alert('Translation failed — check LLM config')
                      }
                      setTranslating(false)
                    })
                    .catch(() => { alert('Translation request failed'); setTranslating(false) })
                }}
                  style={{
                    marginTop: 10, padding: '8px 16px', fontSize: 13, fontWeight: 600,
                    background: 'var(--accent)', color: '#fff',
                    border: 'none', borderRadius: 8, cursor: 'pointer',
                  }}>
                  🌐 Translate
                </button>
              )}
            </div>
          )}

          {detail.has_pdf && !showPdf && (
            <button onClick={() => setShowPdf(true)} style={{
              width: '100%', padding: '12px', fontSize: 14, fontWeight: 600,
              background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8,
              cursor: 'pointer', marginBottom: 16,
            }}>
              📄 View Paper PDF
            </button>
          )}

          {detail.has_pdf && showPdf && (
            <div style={{ marginBottom: 20 }}>
              <embed
                src={`${API}/pdf/${detail.arxiv_id}#toolbar=0`}
                type="application/pdf"
                style={{ width: '100%', height: 'calc(100vh - 240px)', borderRadius: 8 }}
              />
              <a href={`${API}/pdf/${detail.arxiv_id}`} target="_blank" rel="noreferrer"
                style={{ display: 'block', textAlign: 'center', fontSize: 12, color: 'var(--accent)', marginTop: 8 }}>
                Open PDF in new tab ↗
              </a>
            </div>
          )}

          {!detail.abstract && !detail.has_pdf && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No content available.</div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="nav-bar">
        <button className="nav-btn" onClick={() => window.location.href = '/'}>← Back</button>
        <div className="title">📄 ArXiv</div>
        <div style={{ width: 60 }} />
      </div>
      <div className="content">
        {error && <div className="error">{error}</div>}

        <div className="tab-row">
          {(['search', 'categories'] as const).map(t => (
            <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}>
              {t === 'search' ? '🔍 Search' : `📂 Categories${busy ? ' 🔒' : ''}`}
            </button>
          ))}
        </div>

        {tab === 'search' && (
          <div>
            <div className="search-row">
              <input className="search-input" value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
                placeholder="Search papers..." />
              <button className="search-btn" onClick={doSearch} disabled={searching}>Go</button>
            </div>
            {searching ? <div className="loading">Searching...</div>
              : results.length > 0 ? results.map(p => (
                <div key={p.arxiv_id} className="paper" onClick={() => viewPaper(p.arxiv_id)}>
                  <div className="p-title">{p.title}</div>
                  <div className="p-meta">{new Date(p.published).toLocaleDateString()}</div>
                </div>
              ))
              : query ? <div className="loading">No results</div>
              : <div className="loading">Enter a query to search indexed papers</div>}
          </div>
        )}

        {tab === 'categories' && (
          <div>
            {stats && (
              <div className="stat-row">
                {[
                  { label: 'Papers', value: stats.papers },
                  { label: 'Categories', value: stats.categories },
                ].map(s => (
                  <div key={s.label} className="stat-box">
                    <div className="value">{s.value}</div>
                    <div className="label">{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Crawl papers from the last:</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <select
                id="crawl-range"
                defaultValue="7"
                style={{
                  flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 14,
                  border: '1px solid var(--border)', background: 'var(--surface, var(--card-bg))',
                  color: 'var(--text)',
                }}>
                <option value="7">1 week</option>
                <option value="30">1 month</option>
                <option value="90">3 months</option>
                <option value="180">6 months</option>
                <option value="365">12 months</option>
              </select>
              <button
                disabled={busy}
                onClick={async () => {
                  if (busy) return
                  markBusy()
                  setCrawlMessage('Starting...')
                  const days = parseInt((document.getElementById('crawl-range') as HTMLSelectElement)?.value || '7')
                  const r = await fetch(`${API}/crawl`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ days_back: days }),
                  })
                  const d = await r.json()
                  if (d.status === 'already_running') { /* already busy */ }
                  else if (d.status === 'no_categories') {
                    alert('Enable at least one category first')
                    setBusy(false)
                    setCrawlMessage('')
                  }
                  // Refresh stats
                  fetch(`${API}/stats`).then(r => r.ok ? r.json() : null).then(s => { if (s) setStats(s) }).catch(() => {})
                }}
                style={{
                  flex: 1, padding: '10px', borderRadius: 8,
                  border: 'none', background: 'var(--accent)', color: '#fff',
                  fontSize: 14, fontWeight: 600,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.5 : 1,
                }}>
                🔄 Crawl Now
              </button>
            </div>

            {crawlMessage && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '6px 0', marginBottom: 8 }}>
                {busy && '⏳ '}{crawlMessage}
              </div>
            )}

            {categories.length === 0
              ? <div className="loading">No categories found.</div>
              : <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0 12px' }}>
                    Tap the toggle to enable/disable categories for crawling
                  </div>
                {(() => {
                  let curGroup = ''
                  return categories.map((c, i) => {
                    const groupHeader = c.group !== curGroup ? (curGroup = c.group, true) : false
                    return (
                      <div key={i}>
                        {groupHeader && <div style={{ fontSize: 13, fontWeight: 700, padding: '12px 0 6px', color: 'var(--text)' }}>{c.group}</div>}
                        <div className="topic-item" style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          opacity: c.enabled ? 1 : 0.5,
                        }}>
                          <span style={{ fontSize: 13, fontWeight: c.enabled ? 600 : 400, flex: 1 }}>
                            {c.code}
                            <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{c.description}</span>
                          </span>
                          {(() => {
                            const isDisabled = busy || togglingCat === c.code
                            return (
                              <div
                                role="switch"
                                aria-checked={c.enabled}
                                aria-disabled={isDisabled}
                                onClick={() => { if (!isDisabled) toggleCategory(c.code, c.enabled) }}
                                style={{
                                  position: 'relative', width: 44, height: 24, borderRadius: 12,
                                  background: c.enabled ? '#16a34a' : '#555',
                                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                                  opacity: isDisabled ? 0.35 : 1,
                                  transition: 'background 0.2s, opacity 0.2s',
                                  flexShrink: 0,
                                }}
                              >
                                <div style={{
                                  position: 'absolute', top: 2, left: c.enabled ? 22 : 2,
                                  width: 20, height: 20, borderRadius: '50%',
                                  background: '#fff',
                                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                                  transition: 'left 0.2s',
                                }} />
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                    )
                  })
                })()}
              </div>}
          </div>
        )}
      </div>
    </div>
  )
}
