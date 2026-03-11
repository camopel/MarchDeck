import { useState, useEffect, useRef, useCallback } from 'react'
import { AppShell } from './AppShell'
import { Session, Message, StreamingState, WsMessage } from './types'
import { ChatView } from './ChatView'
import { Dashboard } from './Dashboard'
import './base.css'
import './index.css'

// March proxy URL — served by the ws_proxy plugin.
function getMeta(name: string, fallback: string): string {
  const el = document.querySelector(`meta[name="${name}"]`)
  return el?.getAttribute('content') || fallback
}

function getProxyBase(): string {
  if (location.protocol === 'https:') {
    const httpsPort = getMeta('march-proxy-https-port', '8143')
    return `https://${location.hostname}:${httpsPort}`
  }
  const httpPort = getMeta('march-proxy-port', '8101')
  return `http://${location.hostname}:${httpPort}`
}

const PROXY_BASE = getProxyBase()
const DASHBOARD_API = '/api/app/march'

function proxyUrl(path: string): string {
  return `${PROXY_BASE}${path}`
}

function wsUrl(sessionId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const port = location.protocol === 'https:'
    ? getMeta('march-proxy-https-port', '8143')
    : getMeta('march-proxy-port', '8101')
  return `${proto}//${location.hostname}:${port}/ws/${sessionId}`
}

type Tab = 'chat' | 'dashboard'

const tabs = [
  { id: 'chat', label: 'Chat' },
  { id: 'dashboard', label: 'Dashboard' },
]

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('chat')
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState<StreamingState>({
    isStreaming: false,
    content: '',
    activeTools: [],
    toolProgress: [],
  })
  const [isConnected, setIsConnected] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const lastChunkId = useRef<number>(-1)
  const activeSessionRef = useRef<string | null>(null)
  const streamingRef = useRef(false)

  // iOS PWA keyboard: scroll page back to top when keyboard closes
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let lastHeight = vv.height
    const onResize = () => {
      const newHeight = vv.height
      if (newHeight > lastHeight + 50) window.scrollTo(0, 0)
      lastHeight = newHeight
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  const reconnectAttempt = useRef(0)
  const messageQueue = useRef<string[]>([])
  const newNameRef = useRef<HTMLInputElement>(null)

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(proxyUrl("/sessions"))
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions)
        return data.sessions as Session[]
      }
    } catch { /* offline */ }
    return []
  }, [])

  const fetchHistory = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(proxyUrl(`/sessions/${sessionId}/history`))
      if (res.ok) {
        const data = await res.json()
        const completed = (data.messages || []).filter(
          (m: any) => m.summary !== '[streaming]'
        )
        if (streamingRef.current) return
        setMessages(completed)
      }
    } catch { /* offline */ }
  }, [])

  useEffect(() => {
    fetchSessions().then((loaded) => {
      if (loaded.length > 0) setActiveSessionId(loaded[0].id)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    activeSessionRef.current = activeSessionId
    if (activeSessionId) fetchHistory(activeSessionId)
    else setMessages([])
  }, [activeSessionId, fetchHistory])

  // WebSocket connection
  const connectWs = useCallback((sessionId: string) => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    const ws = new WebSocket(wsUrl(sessionId))
    wsRef.current = ws

    ws.onopen = () => {
      setIsConnected(true)
      setIsReconnecting(false)
      reconnectAttempt.current = 0
      while (messageQueue.current.length > 0) {
        const msg = messageQueue.current.shift()!
        ws.send(msg)
      }
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
        else clearInterval(pingInterval)
      }, 30000)
      ;(ws as any)._pingInterval = pingInterval
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage & { chunk_id?: number; collected?: string }
        if (msg.chunk_id !== undefined) lastChunkId.current = msg.chunk_id
        switch (msg.type) {
          case 'stream.start':
            streamingRef.current = true
            setStreaming({ isStreaming: true, content: '', activeTools: [], toolProgress: [] })
            break
          case 'stream.delta':
            setStreaming(prev => ({ ...prev, content: prev.content + (msg.content || '') }))
            break
          case 'stream.end':
            lastChunkId.current = -1
            streamingRef.current = false
            if (msg.cancelled) break
            setStreaming(prev => {
              if (prev.content) {
                const newMsg: Message = {
                  id: `msg-${Date.now()}`, session_id: sessionId, role: 'assistant',
                  content: prev.content, tool_calls: [], created_at: new Date().toISOString(),
                }
                setMessages(msgs => [...msgs, newMsg])
              }
              return { isStreaming: false, content: '', activeTools: [], toolProgress: [] }
            })
            fetchSessions()
            break
          case 'stream.active':
            streamingRef.current = true
            setStreaming({ isStreaming: true, content: msg.collected || '', activeTools: [], toolProgress: [] })
            setTimeout(() => {
              const el = document.querySelector('.chat-messages')
              if (el) el.scrollTop = el.scrollHeight
            }, 100)
            break
          case 'stream.catchup':
            lastChunkId.current = -1
            streamingRef.current = false
            if (msg.content) {
              const catchupMsg: Message = {
                id: `msg-catchup-${Date.now()}`, session_id: sessionId, role: 'assistant',
                content: msg.content, tool_calls: [], created_at: new Date().toISOString(),
              }
              setMessages(msgs => {
                const lastMsg = msgs[msgs.length - 1]
                if (lastMsg?.content === msg.content) return msgs
                return [...msgs, catchupMsg]
              })
            }
            setStreaming({ isStreaming: false, content: '', activeTools: [], toolProgress: [] })
            break
          case 'stream.resumed':
          case 'stream.idle':
          case 'pong':
            break
          case 'stream.cancelled':
            streamingRef.current = false
            setStreaming(prev => {
              if (prev.content) {
                const stoppedMsg: Message = {
                  id: `msg-${Date.now()}`, session_id: sessionId, role: 'assistant',
                  content: prev.content + '\n\n⏹ Stopped', tool_calls: [], created_at: new Date().toISOString(),
                }
                setMessages(msgs => [...msgs, stoppedMsg])
              }
              return { isStreaming: false, content: '', activeTools: [], toolProgress: [] }
            })
            break
          case 'tool.start':
            setStreaming(prev => ({ ...prev, activeTools: [...prev.activeTools, msg.name] }))
            break
          case 'tool.result':
            setStreaming(prev => ({ ...prev, activeTools: prev.activeTools.filter(t => t !== msg.name) }))
            break
          case 'tool.progress':
            setStreaming(prev => ({
              ...prev,
              activeTools: prev.activeTools.filter(t => t !== msg.name),
              toolProgress: [...prev.toolProgress, {
                name: msg.name, status: msg.status, summary: msg.summary, duration_ms: msg.duration_ms,
              }],
            }))
            break
          case 'error':
            setStreaming(prev => {
              const errContent = prev.content
                ? prev.content + `\n\n⚠️ ${msg.message}`
                : `⚠️ ${msg.message}`
              const newMsg: Message = {
                id: `msg-${Date.now()}`, session_id: sessionId, role: 'assistant',
                content: errContent, tool_calls: [], created_at: new Date().toISOString(),
              }
              setMessages(msgs => [...msgs, newMsg])
              return { isStreaming: false, content: '', activeTools: [], toolProgress: [] }
            })
            break
          case 'message.queued':
            break
          case 'voice.transcribed':
            setMessages(msgs => {
              const updated = [...msgs]
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].role === 'user' && updated[i].content === '🔊 Voice message') {
                  updated[i] = { ...updated[i], content: msg.text }
                  break
                }
              }
              return updated
            })
            break
          case 'image.preview':
            setMessages(msgs => {
              const updated = [...msgs]
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].role === 'user' && updated[i].content === `📎 ${msg.filename}`) {
                  updated[i] = { ...updated[i], image_data: `data:${msg.mime_type};base64,${msg.data}` }
                  break
                }
              }
              return updated
            })
            break
          case 'session.reset':
            setMessages([])
            break
        }
      } catch { /* ignore parse errors */ }
    }

    ws.onclose = () => {
      setIsConnected(false)
      if ((ws as any)._pingInterval) clearInterval((ws as any)._pingInterval)
      wsRef.current = null
      if (activeSessionRef.current === sessionId) {
        setIsReconnecting(true)
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30000)
        reconnectAttempt.current++
        reconnectTimer.current = window.setTimeout(() => {
          if (activeSessionRef.current === sessionId) {
            connectWs(sessionId)
            fetchHistory(sessionId)
          }
        }, delay)
      }
    }
    ws.onerror = () => { /* triggers onclose */ }
  }, [fetchHistory, fetchSessions])

  useEffect(() => {
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
    setIsReconnecting(false)
    reconnectAttempt.current = 0
    if (activeSessionId) connectWs(activeSessionId)
    else { if (wsRef.current) { wsRef.current.close(); wsRef.current = null }; setIsConnected(false) }
    return () => { if (reconnectTimer.current) clearTimeout(reconnectTimer.current) }
  }, [activeSessionId, connectWs])

  const sendMessage = useCallback((content: string) => {
    if (!activeSessionId) return
    const userMsg: Message = {
      id: `msg-${Date.now()}`, session_id: activeSessionId, role: 'user',
      content, tool_calls: [], created_at: new Date().toISOString(),
    }
    setMessages(msgs => [...msgs, userMsg])
    const payload = JSON.stringify({ type: 'message', content, session_id: activeSessionId })
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(payload)
    else messageQueue.current.push(payload)
  }, [activeSessionId])

  const sendAttachment = useCallback(async (file: File) => {
    if (!activeSessionId) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(',')[1]
      const isImage = file.type.startsWith('image/')
      const userMsg: Message = {
        id: `msg-${Date.now()}`, session_id: activeSessionId, role: 'user',
        content: `📎 ${file.name}`, tool_calls: [], created_at: new Date().toISOString(),
        ...(isImage ? { image_data: dataUrl } : {}),
      }
      setMessages(msgs => [...msgs, userMsg])
      const payload = JSON.stringify({
        type: 'attachment', session_id: activeSessionId,
        filename: file.name, mime_type: file.type, data: base64,
      })
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(payload)
      else messageQueue.current.push(payload)
    }
    reader.readAsDataURL(file)
  }, [activeSessionId])

  const sendVoice = useCallback(async (blob: Blob) => {
    if (!activeSessionId) return
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1]
      const userMsg: Message = {
        id: `msg-${Date.now()}`, session_id: activeSessionId, role: 'user',
        content: '🔊 Voice message', tool_calls: [], created_at: new Date().toISOString(),
      }
      setMessages(msgs => [...msgs, userMsg])
      const payload = JSON.stringify({
        type: 'voice', session_id: activeSessionId,
        mime_type: blob.type || 'audio/webm', data: base64,
      })
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(payload)
      else messageQueue.current.push(payload)
    }
    reader.readAsDataURL(blob)
  }, [activeSessionId])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const res = await fetch(proxyUrl("/sessions"), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) {
        const data = await res.json()
        await fetchSessions()
        setActiveSessionId(data.id)
      }
    } catch { /* offline */ }
    setNewName('')
    setIsCreating(false)
  }

  const deleteActive = async () => {
    if (!activeSessionId) return
    const sess = sessions.find(s => s.id === activeSessionId)
    if (!confirm(`Delete "${sess?.name || 'this session'}"?`)) return
    try {
      const res = await fetch(proxyUrl(`/sessions/${activeSessionId}`), { method: 'DELETE' })
      if (res.ok) { setActiveSessionId(null); setMessages([]); await fetchSessions() }
    } catch { /* offline */ }
  }

  const sessionPicker = (
    <div className="session-picker">
      {isCreating ? (
        <div className="session-create-row">
          <input ref={newNameRef} className="session-create-input" placeholder="Session name..."
            value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setIsCreating(false); setNewName('') } }}
            autoFocus />
          <button className="session-btn session-btn-ok" onClick={handleCreate} disabled={!newName.trim()}>✓</button>
          <button className="session-btn session-btn-cancel" onClick={() => { setIsCreating(false); setNewName('') }}>✕</button>
        </div>
      ) : (
        <div className="session-select-row">
          <select className="session-dropdown" value={activeSessionId || ''}
            onChange={e => { const val = e.target.value; if (val === '__create__') { setIsCreating(true); setTimeout(() => newNameRef.current?.focus(), 50) } else setActiveSessionId(val || null) }}>
            <option value="">Select session...</option>
            <option value="__create__">＋ New session</option>
            {sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="session-btn session-btn-add"
            onClick={() => { setIsCreating(true); setTimeout(() => newNameRef.current?.focus(), 50) }} title="New session">+</button>
          <button className="session-btn session-btn-del" onClick={deleteActive} disabled={!activeSessionId} title="Delete session">−</button>
        </div>
      )}
    </div>
  )

  return (
    <AppShell title="March" tabs={tabs} activeTab={activeTab} onTabChange={id => setActiveTab(id as Tab)}>
      {activeTab === 'chat' && (
        <>
          {sessionPicker}
          {isReconnecting && (
            <div className="reconnect-banner">
              <span className="reconnect-spinner" />
              Reconnecting...
            </div>
          )}
          <ChatView
            sessionId={activeSessionId} messages={messages} streaming={streaming}
            onSendMessage={sendMessage} onSendAttachment={sendAttachment} onSendVoice={sendVoice}
            isConnected={isConnected} isReconnecting={isReconnecting}
          />
        </>
      )}
      {activeTab === 'dashboard' && <Dashboard apiBase={DASHBOARD_API} />}
    </AppShell>
  )
}
