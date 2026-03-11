import { useEffect, useState, useCallback } from 'react'
import { AppShell } from './AppShell'
import './styles.css'

const API = '/api/app/openclaw'

type Tab = 'chats' | 'config' | 'tools'

const tabs = [
  { id: 'chats', label: 'Chats' },
  { id: 'config', label: 'Config' },
  { id: 'tools', label: 'Tools' },
]

// ── Types ────────────────────────────────────────────────────────────────

interface Backup {
  name: string
  size: number
  modified: string
}

interface ChannelInfo {
  key: string
  label: string
  sessionId: string
}

interface ChatMessage {
  role: string
  content: string
  ts?: string
  model?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

// ── App ──────────────────────────────────────────────────────────────────

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('chats')

  return (
    <AppShell title="🦞 OpenClaw" tabs={tabs} activeTab={activeTab} onTabChange={id => setActiveTab(id as Tab)}>
      {activeTab === 'config' && <ConfigTab />}
      {activeTab === 'chats' && <ChatsTab />}
      {activeTab === 'tools' && <ToolsTab />}
    </AppShell>
  )
}

// ── Config Tab ───────────────────────────────────────────────────────────

function ConfigTab() {
  const [config, setConfig] = useState('')
  const [original, setOriginal] = useState('')
  const [rawError, setRawError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [backups, setBackups] = useState<Backup[]>([])
  const [showBackups, setShowBackups] = useState(false)
  const [diffText, setDiffText] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/config`)
      const data = await res.json()
      if (data.error && data.raw) {
        setConfig(data.raw)
        setOriginal(data.raw)
        setRawError(data.error)
      } else {
        const text = JSON.stringify(data, null, 2)
        setConfig(text)
        setOriginal(text)
        setRawError(null)
      }
      setMsg(null)
    } catch (e) {
      setMsg({ text: `Load failed: ${e}`, ok: false })
    }
    setLoading(false)
  }, [])

  const loadBackups = async () => {
    try {
      const res = await fetch(`${API}/config/backups`)
      const data = await res.json()
      setBackups(data.backups || [])
    } catch { /* ignore */ }
  }

  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    setMsg(null)
    try {
      const parsed = JSON.parse(config)
      const res = await fetch(`${API}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      if (res.ok) {
        const data = await res.json()
        setOriginal(config)
        setRawError(null)
        setMsg({ text: `✅ Saved! Backup: ${data.backup}`, ok: true })
      } else {
        const data = await res.json()
        setMsg({ text: `Save failed: ${data.detail || res.statusText}`, ok: false })
      }
    } catch (e) {
      setMsg({ text: `Invalid JSON: ${e}`, ok: false })
    }
    setSaving(false)
  }

  const createBackup = async () => {
    try {
      const res = await fetch(`${API}/config/backup`, { method: 'POST' })
      const data = await res.json()
      setMsg({ text: `📦 Backup: ${data.name}`, ok: true })
      loadBackups()
    } catch (e) {
      setMsg({ text: `Backup failed: ${e}`, ok: false })
    }
  }

  const restore = async (name: string) => {
    if (!confirm(`Restore config from ${name}?\n\nCurrent config will be backed up first.`)) return
    try {
      const res = await fetch(`${API}/config/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) {
        setMsg({ text: `✅ Restored from ${name}`, ok: true })
        load()
      } else {
        const data = await res.json()
        setMsg({ text: `Restore failed: ${data.detail}`, ok: false })
      }
    } catch (e) {
      setMsg({ text: `Restore failed: ${e}`, ok: false })
    }
  }

  const showDiff = async (name: string) => {
    try {
      const res = await fetch(`${API}/config/diff/${name}`)
      const data = await res.json()
      if (data.diff && data.diff.length > 0) {
        setDiffText(`${data.changes} changes vs ${name}:\n\n${data.diff.join('\n')}`)
      } else {
        setDiffText(`No differences vs ${name}`)
      }
    } catch (e) {
      setDiffText(`Diff failed: ${e}`)
    }
  }

  const dirty = config !== original

  return (
    <div>
      {rawError && (
        <div className="card" style={{ borderColor: '#dc2626' }}>
          <div style={{ color: '#dc2626', fontWeight: 600, marginBottom: 4 }}>⚠️ Config is broken</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{rawError}</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Fix the JSON below and save, or restore a backup.</div>
        </div>
      )}

      <div className="action-row">
        <button onClick={load} disabled={loading}>🔄 Reload</button>
        <button className="primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <span className="spinner" /> : '💾'} Save
        </button>
        <button onClick={() => { setShowBackups(!showBackups); if (!showBackups) loadBackups() }}>
          {showBackups ? '▲' : '▼'} Backups
        </button>
      </div>

      <div className="action-row">
        {dirty && <span style={{ fontSize: 13, color: '#f59e0b' }}>● Unsaved changes</span>}
        {msg && <span style={{ fontSize: 13, color: msg.ok ? '#16a34a' : '#dc2626' }}>{msg.text}</span>}
      </div>

      {showBackups && (
        <div className="card" style={{ padding: 0, marginBottom: 12 }}>
          {backups.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-secondary)', textAlign: 'center' }}>No backups yet</div>
          ) : backups.map(b => (
            <div key={b.name} className="session-item">
              <div>
                <div style={{ fontSize: 14, fontFamily: 'monospace' }}>{b.name}</div>
                <div className="session-meta">{fmtSize(b.size)} · {fmtDate(b.modified)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="small" onClick={() => showDiff(b.name)}>Diff</button>
                <button className="small primary" onClick={() => restore(b.name)}>Restore</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {diffText && (
        <div className="terminal" style={{ marginBottom: 12, maxHeight: '30vh' }}>
          {diffText}
          <div style={{ textAlign: 'right', marginTop: 8 }}>
            <button className="small" onClick={() => setDiffText(null)} style={{ background: '#333', color: '#ccc' }}>Close</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : (
        <textarea
          className="config-editor"
          value={config}
          onChange={e => setConfig(e.target.value)}
          spellCheck={false}
        />
      )}
    </div>
  )
}

// ── Simple Markdown renderer ─────────────────────────────────────────────

function renderMd(text: string): string {
  let html = text
    // Escape HTML
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Code blocks (``` ... ```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    // Bullet lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Line breaks (double newline → paragraph break)
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>(?:<br\/>)?)+/g, (m) =>
    '<ul>' + m.replace(/<br\/>/g, '') + '</ul>'
  )
  return html
}

function fmtTs(ts?: string): string {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
  } catch { return '' }
}

// ── Chats Tab ────────────────────────────────────────────────────────────

function ChatsTab() {
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [channelsLoading, setChannelsLoading] = useState(true)

  // Load channel list on mount
  useEffect(() => {
    (async () => {
      setChannelsLoading(true)
      try {
        const res = await fetch(`${API}/channels`)
        const data = await res.json()
        setChannels(data.channels || [])
        if (data.channels?.length > 0) {
          setSelected(data.channels[0].key)
        }
      } catch (e) {
        console.error('Failed to load channels:', e)
      }
      setChannelsLoading(false)
    })()
  }, [])

  // Load messages when channel changes
  useEffect(() => {
    if (!selected) return
    loadMessages()
  }, [selected])

  const loadMessages = async () => {
    if (!selected) return
    setLoading(true)
    try {
      const res = await fetch(`${API}/channels/${encodeURIComponent(selected)}/history?limit=60`)
      const data = await res.json()
      setMessages(data.messages || [])
    } catch (e) {
      setMessages([{ role: 'system', content: `Error: ${e}` }])
    }
    setLoading(false)
  }

  if (channelsLoading) {
    return <div className="empty-state"><div className="spinner" /></div>
  }

  // Reverse: latest on top
  const reversed = [...messages].reverse()

  return (
    <div>
      <div className="action-row">
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          style={{ flex: 1 }}
        >
          {channels.length === 0 && <option value="">No channels</option>}
          {channels.map(c => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        <button onClick={loadMessages} disabled={loading || !selected}>
          {loading ? <span className="spinner" /> : '🔄'}
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><div className="spinner" /></div>
      ) : messages.length === 0 ? (
        <div className="empty-state">
          <div className="icon">💬</div>
          <div>No messages</div>
        </div>
      ) : (
        <div className="chat-messages">
          {reversed.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              <div className="chat-header">
                <span className="chat-role">{m.role}{m.model ? ` · ${m.model}` : ''}</span>
                {m.ts && <span className="chat-ts">{fmtTs(m.ts)}</span>}
              </div>
              <div className="chat-body" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tools Tab ────────────────────────────────────────────────────────────

function ToolsTab() {
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)

  const runAction = async (label: string, endpoint: string, method = 'GET') => {
    setRunning(label)
    setOutput(null)
    try {
      const res = await fetch(`${API}/${endpoint}`, { method })
      const data = await res.json()
      if (data.output) {
        setOutput(data.output)
      } else if (data.steps) {
        setOutput(data.steps.map((s: any) => `── ${s.step} (exit ${s.returncode}) ──\n${s.output}`).join('\n\n'))
      } else {
        setOutput(JSON.stringify(data, null, 2))
      }
    } catch (e) {
      setOutput(`Error: ${e}`)
    }
    setRunning(null)
  }

  return (
    <div>
      <div className="tool-buttons">
        <button className="tool-btn" onClick={() => runAction('Status', 'status')} disabled={running !== null}>
          {running === 'Status' ? <span className="spinner" /> : <span className="tool-icon">📊</span>}
          <span className="tool-label">Status</span>
          <span className="tool-desc">Gateway health, sessions, channels</span>
        </button>
        <button className="tool-btn" onClick={() => runAction('Doctor', 'doctor')} disabled={running !== null}>
          {running === 'Doctor' ? <span className="spinner" /> : <span className="tool-icon">🩺</span>}
          <span className="tool-label">Doctor</span>
          <span className="tool-desc">Config validation, session locks, cleanup hints</span>
        </button>
        <button className="tool-btn" onClick={() => runAction('Restart', 'restart', 'POST')} disabled={running !== null}>
          {running === 'Restart' ? <span className="spinner" /> : <span className="tool-icon">🔄</span>}
          <span className="tool-label">Restart Gateway</span>
          <span className="tool-desc">Restart the OpenClaw gateway service</span>
        </button>
        <button className="tool-btn danger-btn" onClick={() => {
          if (confirm('Run openclaw update? This will fetch, rebase your local changes, install deps, build, and restart.')) {
            runAction('Upgrade', 'upgrade', 'POST')
          }
        }} disabled={running !== null}>
          {running === 'Upgrade' ? <span className="spinner" /> : <span className="tool-icon">⬆️</span>}
          <span className="tool-label">Update OpenClaw</span>
          <span className="tool-desc">openclaw update — fetch, rebase, install, restart</span>
        </button>
      </div>
      {output && <div className="terminal" style={{ marginTop: 12 }}>{output}</div>}
    </div>
  )
}
