import { useEffect, useState, useCallback } from 'react'

/* ── Types ── */
interface GpuInfo {
  name: string
  utilization_percent: number | null
  memory_used_mb: number | null
  memory_total_mb: number | null
  temperature_c: number | null
  power_draw_w: number | null
  power_limit_w: number | null
}

interface ServiceInfo {
  name: string
  unit: string
  active: boolean
  scope: string
}

interface SystemStats {
  hostname: string
  platform: string
  os_version: string | null
  gpu_driver: string | null
  cuda_version: string | null
  kernel_version: string | null
  uptime_seconds: number
  cpu: {
    cores: number
    threads: number
    percent: number
    freq_mhz: number | null
    load_1m: number
    load_5m: number
    load_15m: number
  }
  memory: {
    total: number
    used: number
    available: number
    percent: number
  }
  disk: {
    total: number
    used: number
    free: number
    percent: number
  }
  gpu: GpuInfo[] | null
  services: ServiceInfo[]
}

interface CronJob {
  id: string
  name: string
  description?: string
  source: string
  enabled: boolean
  schedule: string
  next_run: string | null
  last_run: string | null
  last_status: string
  last_duration_s: number
  consecutive_errors: number
}

interface CronData {
  jobs: CronJob[]
}

/* ── Helpers ── */
function fmtBytes(b: number): string {
  if (b < 1024) return b + ' B'
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB'
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB'
  return (b / 1024 ** 3).toFixed(1) + ' GB'
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

/* ── StatBar ── */
function StatBar({ pct, color }: { pct: number; color?: string }) {
  return (
    <div className="stat-bar">
      <div
        className="stat-bar-fill"
        style={{
          width: `${Math.min(pct, 100)}%`,
          background: color ?? 'var(--accent)',
        }}
      />
    </div>
  )
}

/* ── StatCard ── */
function StatCard({ label, value, sub, pct, barColor, children }: {
  label: string
  value?: string
  sub?: string
  pct?: number
  barColor?: string
  children?: React.ReactNode
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      {value && <div className="stat-value">{value}</div>}
      {sub && <div className="stat-sub">{sub}</div>}
      {pct !== undefined && <StatBar pct={pct} color={barColor} />}
      {children}
    </div>
  )
}

const API = '/api/app/system'

/* ── Main component ── */
export default function App() {
  const [data, setData] = useState<SystemStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [cron, setCron] = useState<CronData | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const doAction = useCallback((action: string, label: string) => {
    if (!confirm(`Are you sure you want to ${label.toLowerCase()}?`)) return
    setActionLoading(action)
    setActionMsg(null)
    fetch(`${API}/action/${action}`, { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        setActionMsg(d.message || 'Done')
        setActionLoading(null)
      })
      .catch(() => { setActionMsg(`Failed to ${label.toLowerCase()}`); setActionLoading(null) })
  }, [])

  const fetchStats = useCallback(() => {
    fetch(`${API}/stats`)
      .then(r => {
        if (!r.ok) throw new Error('Failed')
        return r.json() as Promise<SystemStats>
      })
      .then(d => { setData(d); setLoading(false); setError(false) })
      .catch(() => { setLoading(false); setError(true) })
  }, [])

  const fetchCron = useCallback(() => {
    fetch(`${API}/cron`)
      .then(r => r.ok ? r.json() as Promise<CronData> : null)
      .then(d => { if (d) setCron(d) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchStats()
    fetchCron()
    const interval = setInterval(fetchStats, 3000)
    const onVis = () => { if (document.visibilityState === 'visible') { fetchStats(); fetchCron() } }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVis) }
  }, [fetchStats, fetchCron])

  return (
    <div className="page">
      <div className="nav-bar">
        <button className="nav-btn" onClick={() => window.location.href = '/'}>← Back</button>
        <div className="title">System</div>
        <div className="spacer" />
      </div>

      <div className="content">
        {loading && <div className="loading"><div className="spinner" /></div>}
        {error && (
          <div className="error-state">
            <div style={{ fontSize: 40 }}>⚠️</div>
            <div>Could not load stats</div>
            <button className="btn btn-secondary" onClick={fetchStats}>Retry</button>
          </div>
        )}
        {data && (
          <>
            {/* Host info */}
            <StatCard label="Host" value={data.hostname}>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className="stat-sub" style={{ margin: 0 }}>Uptime {fmtUptime(data.uptime_seconds)}</div>
                {data.os_version && <div className="stat-sub" style={{ margin: 0 }}>{data.os_version}{data.kernel_version ? ` · ${data.kernel_version}` : ''}</div>}
              </div>
            </StatCard>

            {/* CPU */}
            <StatCard
              label="CPU"
              value={`${data.cpu.percent.toFixed(1)}%`}
              sub={[
                `${data.cpu.cores} cores / ${data.cpu.threads} threads`,
                data.cpu.freq_mhz ? `${data.cpu.freq_mhz} MHz` : null,
                `Load: ${data.cpu.load_1m} / ${data.cpu.load_5m} / ${data.cpu.load_15m}`,
              ].filter(Boolean).join(' · ')}
              pct={data.cpu.percent}
            />

            {/* Memory */}
            <StatCard
              label="Memory"
              value={`${data.memory.percent.toFixed(1)}%`}
              sub={`${fmtBytes(data.memory.used)} used of ${fmtBytes(data.memory.total)}`}
              pct={data.memory.percent}
            />

            {/* Disk */}
            <StatCard
              label="Disk"
              value={`${data.disk.percent.toFixed(1)}%`}
              sub={`${fmtBytes(data.disk.used)} used of ${fmtBytes(data.disk.total)}`}
              pct={data.disk.percent}
              barColor="#ff9500"
            />

            {/* GPU(s) — only shown if available */}
            {data.gpu && data.gpu.length > 0 && data.gpu.map((g, i) => {
              const memPct = g.memory_used_mb && g.memory_total_mb
                ? Math.round((g.memory_used_mb / g.memory_total_mb) * 100)
                : null
              return (
                <div className="stat-card" key={i}>
                  <div className="stat-label">
                    GPU{data.gpu!.length > 1 ? ` ${i}` : ''} · {g.name}
                  </div>
                  {g.temperature_c !== null && (
                    <div className="stat-sub">Temp: {g.temperature_c}°C</div>
                  )}
                  {g.power_draw_w !== null && g.power_limit_w !== null && (
                    <div className="stat-sub">Power: {g.power_draw_w}W / {g.power_limit_w}W</div>
                  )}
                  {g.utilization_percent !== null && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                        <span className="stat-sub">Compute</span>
                        <span className="stat-sub">{g.utilization_percent}%</span>
                      </div>
                      <StatBar pct={g.utilization_percent} color="#34c759" />
                    </>
                  )}
                  {memPct !== null && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
                        <span className="stat-sub">VRAM</span>
                        <span className="stat-sub">
                          {(g.memory_used_mb! / 1024).toFixed(1)} /
                          {(g.memory_total_mb! / 1024).toFixed(1)} GB ({memPct}%)
                        </span>
                      </div>
                      <StatBar pct={memPct} color="#ff9f0a" />
                    </>
                  )}
                </div>
              )
            })}


            {/* Scheduled Jobs */}
            {cron && cron.jobs.length > 0 && (
              <div className="stat-card">
                <div className="stat-label">Scheduled Jobs</div>
                {cron.jobs.map((job, i) => (
                  <div
                    key={job.id}
                    style={{
                      paddingTop: i === 0 ? 10 : 8,
                      paddingBottom: 8,
                      borderBottom: i < cron.jobs.length - 1 ? '0.5px solid var(--border)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          className={`status-dot ${
                            !job.enabled ? '' :
                            job.last_status === 'ok' ? 'active' :
                            job.last_status === 'unknown' || job.last_run === null ? '' :
                            job.consecutive_errors > 0 ? 'inactive' : 'active'
                          }`}
                          style={
                            !job.enabled ? { background: '#888' } :
                            job.last_status === 'unknown' || job.last_run === null ? { background: '#888' } :
                            undefined
                          }
                        />
                        <div style={{ fontSize: 14, fontWeight: 500 }}>{job.name}</div>
                        <span style={{
                          fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 4,
                          background: job.source === 'openclaw' ? '#007aff22' : '#ff950022',
                          color: job.source === 'openclaw' ? '#007aff' : '#ff9500',
                        }}>
                          {job.source === 'openclaw' ? 'cron' : 'timer'}
                        </span>
                      </div>
                      <div style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: !job.enabled ? '#888' :
                               job.last_status === 'ok' ? '#34c759' :
                               job.last_status === 'unknown' || job.last_run === null ? '#888' :
                               '#ff3b30',
                      }}>
                        {!job.enabled ? 'disabled' :
                         job.last_status === 'unknown' && job.last_run === null ? 'pending' :
                         job.last_status}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, paddingLeft: 20 }}>
                      <span className="stat-sub">{job.schedule}</span>
                      <span className="stat-sub">
                        {job.next_run ? `Next: ${job.next_run}` : ''}
                        {job.last_run ? ` · Last: ${job.last_run}` : ''}
                        {job.last_duration_s > 0 ? ` (${job.last_duration_s}s)` : ''}
                      </span>
                    </div>
                    {job.consecutive_errors > 0 && (
                      <div style={{ paddingLeft: 20, marginTop: 2, fontSize: 11, color: '#ff3b30' }}>
                        ⚠️ {job.consecutive_errors} consecutive error{job.consecutive_errors > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Action Buttons */}
            <div className="stat-card" style={{ display: 'flex', gap: 10, padding: 10 }}>
              {[
                { action: 'restart', label: 'Restart', icon: '🔄', color: '#ff9500' },
                { action: 'shutdown', label: 'Shutdown', icon: '⏻', color: '#ff3b30' },
              ].map(btn => (
                <button
                  key={btn.action}
                  onClick={() => doAction(btn.action, btn.label)}
                  disabled={actionLoading !== null}
                  style={{
                    flex: 1,
                    padding: '12px 8px',
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 12,
                    border: 'none',
                    cursor: actionLoading ? 'wait' : 'pointer',
                    background: btn.color,
                    color: '#fff',
                    opacity: actionLoading && actionLoading !== btn.action ? 0.5 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  {actionLoading === btn.action ? '⏳' : btn.icon} {btn.label}
                </button>
              ))}
            </div>
            {actionMsg && (
              <div className="stat-card" style={{
                textAlign: 'center', fontSize: 13,
                color: 'var(--text-secondary, #888)',
              }}>
                {actionMsg}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
