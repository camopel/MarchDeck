import { useEffect, useState, useCallback } from 'react'

interface DashboardProps {
  apiBase: string
}

interface UsageData {
  date: string
  total_input_tokens: number
  total_output_tokens: number
  total_cost: number
  entries: Array<{
    ts: string
    session_id: string
    model: string
    input_tokens: number
    output_tokens: number
    cost: number
  }>
}

interface MarchStatus {
  version: string
  status: string
  agent: boolean
  model: string
  channels: string[]
  plugins: string[]
  processes: number | null
  uptime_seconds: number | null
  session_count: number | null
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getMarchBase(): string {
  if (location.protocol === 'https:') {
    const el = document.querySelector('meta[name="march-proxy-https-port"]')
    const port = el?.getAttribute('content') || '8143'
    return `https://${location.hostname}:${port}`
  }
  const el = document.querySelector('meta[name="march-proxy-port"]')
  const port = el?.getAttribute('content') || '8101'
  return `http://${location.hostname}:${port}`
}

export function Dashboard({ apiBase }: DashboardProps) {
  const [activePanel, setActivePanel] = useState('status')
  const [marchStatus, setMarchStatus] = useState<MarchStatus | null>(null)
  const [serviceStatus, setServiceStatus] = useState<string>('')
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [config, setConfig] = useState('')
  const [configExists, setConfigExists] = useState(false)
  const [configDirty, setConfigDirty] = useState(false)
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [restarting, setRestarting] = useState(false)

  const marchBase = getMarchBase()

  const fetchPanel = useCallback(async (panel: string) => {
    setLoading(prev => ({ ...prev, [panel]: true }))
    try {
      switch (panel) {
        case 'status': {
          const [statusRes, svcRes] = await Promise.all([
            fetch(`${marchBase}/status`).then(r => r.json()).catch(() => null),
            fetch(`${apiBase}/service/status`).then(r => r.json()).catch(() => ({ status: 'unknown' })),
          ])
          setMarchStatus(statusRes)
          setServiceStatus(svcRes.status || 'unknown')
          break
        }
        case 'usage': {
          const data = await fetch(`${apiBase}/usage`).then(r => r.json())
          setUsage(data)
          break
        }
        case 'config': {
          const data = await fetch(`${apiBase}/config`).then(r => r.json())
          setConfig(data.content || '')
          setConfigExists(data.exists)
          setConfigDirty(false)
          break
        }
      }
    } catch (e) { console.error(`Failed to fetch ${panel}:`, e) }
    setLoading(prev => ({ ...prev, [panel]: false }))
  }, [apiBase, marchBase])

  useEffect(() => { fetchPanel(activePanel) }, [activePanel, fetchPanel])

  const handleRestart = async () => {
    if (!confirm('Restart March agent?')) return
    setRestarting(true)
    try {
      await fetch(`${apiBase}/service/restart`, { method: 'POST' })
      setTimeout(() => { fetchPanel('status'); setRestarting(false) }, 3000)
    } catch { setRestarting(false) }
  }

  const handleSaveConfig = async () => {
    try {
      await fetch(`${apiBase}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: config }),
      })
      setConfigDirty(false)
    } catch { alert('Failed to save') }
  }

  const handleBackupConfig = async () => {
    try {
      const res = await fetch(`${apiBase}/config/backup`, { method: 'POST' })
      const data = await res.json()
      if (data.backed_up) alert(`Backed up to ${data.path}`)
    } catch { alert('Failed to backup') }
  }

  const panels = [
    { id: 'status', label: '🟢 Status' },
    { id: 'usage', label: '📊 Usage' },
    { id: 'config', label: '⚙️ Config' },
  ]

  const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const formatCost = (n: number) => `$${n.toFixed(4)}`
  const formatTime = (ts: string) => {
    try { return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }
    catch { return ts }
  }

  return (
    <div style={{ padding: '12px 0' }}>
      {/* Panel tabs — evenly spaced */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {panels.map(p => (
          <button key={p.id} onClick={() => setActivePanel(p.id)}
            style={{
              flex: 1, padding: '8px 16px', borderRadius: 8, border: 'none',
              background: activePanel === p.id ? 'var(--accent)' : 'var(--card-bg)',
              color: activePanel === p.id ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer', fontSize: 14, fontWeight: activePanel === p.id ? 600 : 400,
              textAlign: 'center',
            }}>{p.label}</button>
        ))}
      </div>

      {/* Status — styled card */}
      {activePanel === 'status' && (
        <div style={{ display: 'grid', gap: 12 }}>
          {loading.status ? (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>Loading...</div>
          ) : marchStatus ? (
            <>
              <div className="status-card">
                <div className="status-row">
                  <span className="status-label">Status</span>
                  <span className="status-value">{marchStatus.status === 'ok' ? '✅ Healthy' : '❌ Unhealthy'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Version</span>
                  <span className="status-value">v{marchStatus.version}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Agent</span>
                  <span className="status-value">{marchStatus.agent ? '✅ Running' : '❌ Not loaded'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Model</span>
                  <span className="status-value">{marchStatus.model}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Channels</span>
                  <span className="status-value">{marchStatus.channels.join(', ') || 'none'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Plugins</span>
                  <span className="status-value">{marchStatus.plugins.length > 0 ? marchStatus.plugins.join(', ') : 'none'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Sessions</span>
                  <span className="status-value">{marchStatus.session_count ?? '—'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Uptime</span>
                  <span className="status-value">{marchStatus.uptime_seconds != null ? formatUptime(marchStatus.uptime_seconds) : '—'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Service</span>
                  <span className="status-value">{serviceStatus === 'active' ? '✅ Active' : `❌ ${serviceStatus}`}</span>
                </div>
              </div>
              <div className="action-row">
                <button onClick={handleRestart} disabled={restarting}
                  style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    background: '#ff9500', color: '#fff', cursor: restarting ? 'not-allowed' : 'pointer',
                    fontSize: 13, fontWeight: 600, opacity: restarting ? 0.5 : 1,
                  }}>{restarting ? 'Restarting...' : '🔄 Restart Agent'}</button>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>
              Failed to connect to March agent
            </div>
          )}
        </div>
      )}

      {/* Usage */}
      {activePanel === 'usage' && (
        <div style={{ display: 'grid', gap: 12 }}>
          {usage && (
            <>
              <div style={{
                background: 'var(--card-bg)', padding: 16, borderRadius: 12,
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
              }}>
                <div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{formatTokens(usage.total_input_tokens + usage.total_output_tokens)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Tokens today</div>
                </div>
                <div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{formatCost(usage.total_cost)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Cost today</div>
                </div>
                <div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{usage.entries.length}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Turns</div>
                </div>
              </div>
              {usage.entries.length > 0 && (
                <div style={{ background: 'var(--card-bg)', padding: 16, borderRadius: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Recent turns</div>
                  <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
                    {[...usage.entries].reverse().map((e, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', padding: '6px 0',
                        borderBottom: '0.5px solid var(--border)', fontSize: 12,
                      }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{formatTime(e.ts)}</span>
                        <span>{formatTokens(e.input_tokens + e.output_tokens)}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{formatCost(e.cost)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {!usage && !loading.usage && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>No usage data</div>
          )}
        </div>
      )}

      {/* Config — Reload button only here */}
      {activePanel === 'config' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="action-row">
            <button onClick={() => fetchPanel('config')} disabled={loading.config}>
              {loading.config ? '⏳' : '🔄'} Reload
            </button>
            <button className="primary" onClick={handleSaveConfig} disabled={!configDirty}>
              💾 Save
            </button>
            <button onClick={handleBackupConfig} disabled={!configExists}>
              📦 Backup
            </button>
          </div>
          {configDirty && (
            <div className="action-row">
              <span style={{ fontSize: 13, color: '#f59e0b' }}>● Unsaved changes</span>
            </div>
          )}
          <textarea
            className="config-editor"
            value={config}
            onChange={e => { setConfig(e.target.value); setConfigDirty(true) }}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  )
}
