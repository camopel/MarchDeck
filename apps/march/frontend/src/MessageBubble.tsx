import { useState, useRef, useCallback } from 'react'
import { Message, ToolCall } from './types'

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  activeTools?: string[]
  toolProgress?: { name: string; status: string; summary: string; duration_ms: number }[]
  showDate?: boolean
  onCopy?: (text: string) => void
}

/** Lightweight markdown → HTML. Handles bold, italic, code, code blocks, links, lists. */
function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`
  })
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  html = html.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(?<!<\/ul>)((?:<li>.*<\/li>\n?)+)/g, (match) => {
    if (match.includes('<ul>')) return match
    return `<ol>${match}</ol>`
  })
  html = html.replace(/\n\n/g, '<br/><br/>')
  const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/)
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('<pre>')) {
      parts[i] = parts[i].replace(/\n/g, '<br/>')
    }
  }
  return parts.join('')
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

function StreamingToolIndicator({ activeTools, toolProgress }: {
  activeTools: string[]
  toolProgress: { name: string; status: string; summary: string; duration_ms: number }[]
}) {
  const isWorking = activeTools.length > 0
  const doneCount = toolProgress.length
  if (!isWorking && doneCount === 0) return null
  return (
    <div className="tool-indicator">
      {isWorking && <span className="tool-spinner" />}
      {!isWorking && <span className="tool-summary-icon">⚙️</span>}
      <span className="tool-working-text">
        {isWorking
          ? doneCount > 0 ? `Working… (${doneCount} done)` : 'Working…'
          : `${doneCount} tool call${doneCount !== 1 ? 's' : ''}`
        }
      </span>
    </div>
  )
}

function ToolCallSummary({ calls }: { calls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false)
  if (!calls.length) return null
  return (
    <div className="tool-summary" onClick={() => setExpanded(v => !v)}>
      <div className="tool-summary-header">
        <span className="tool-summary-icon">⚙️</span>
        <span className="tool-summary-count">{calls.length} tool call{calls.length !== 1 ? 's' : ''}</span>
        <span className={`tool-summary-chevron ${expanded ? 'expanded' : ''}`}>›</span>
      </div>
      {expanded && (
        <div className="tool-summary-list">
          {calls.map((tc, i) => <span key={i} className="tool-badge" title={tc.result || ''}>{tc.name}</span>)}
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ message, isStreaming, activeTools, toolProgress, showDate, onCopy }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const [showCopyBtn, setShowCopyBtn] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showFullscreen, setShowFullscreen] = useState(false)
  const hideTimer = useRef<number | null>(null)

  // Tap bubble → show floating "Copy" button for 3s
  const handleTap = useCallback(() => {
    if (isStreaming || !message.content) return
    // Clear any existing timer
    if (hideTimer.current) clearTimeout(hideTimer.current)
    setShowCopyBtn(true)
    setCopied(false)
    hideTimer.current = window.setTimeout(() => setShowCopyBtn(false), 3000)
  }, [isStreaming, message.content])

  // Copy button click — this IS a direct user gesture, so clipboard works
  const handleCopyClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const text = message.content
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        setTimeout(() => { setCopied(false); setShowCopyBtn(false) }, 1000)
      }).catch(() => {
        // Fallback
        fallbackCopy(text)
      })
    } else {
      fallbackCopy(text)
    }
    if (onCopy) onCopy(text)
  }, [message.content, onCopy])

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    try { document.execCommand('copy'); setCopied(true); setTimeout(() => { setCopied(false); setShowCopyBtn(false) }, 1000) } catch { /* */ }
    document.body.removeChild(ta)
  }

  return (
    <>
      {showDate && message.created_at && (
        <div className="date-separator">{formatDate(message.created_at)}</div>
      )}
      <div className={`msg-row ${isUser ? 'msg-user' : 'msg-assistant'}`}>
        <div
          className={`msg-bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}`}
          onClick={handleTap}
        >
          {/* Floating copy button */}
          {showCopyBtn && (
            <button className="bubble-copy-btn" onClick={handleCopyClick}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          )}

          {!isUser && message.tool_calls?.length > 0 && (
            <ToolCallSummary calls={message.tool_calls} />
          )}
          {isUser ? (
            message.content === '🔊 Voice message' || message.content === '🎤 Voice message' ? (
              <div className="msg-text msg-voice">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="4" y1="8" x2="4" y2="16" />
                  <line x1="8" y1="5" x2="8" y2="19" />
                  <line x1="12" y1="3" x2="12" y2="21" />
                  <line x1="16" y1="7" x2="16" y2="17" />
                  <line x1="20" y1="10" x2="20" y2="14" />
                </svg>
                <span>Voice message</span>
              </div>
            ) : message.image_data ? (
              <>
                <div
                  className="msg-image-wrap"
                  onClick={(e) => { e.stopPropagation(); setShowFullscreen(true) }}
                >
                  <img
                    src={message.image_data}
                    alt={message.content}
                    className="msg-image"
                    loading="lazy"
                  />
                </div>
                {showFullscreen && (
                  <div
                    className="image-fullscreen-overlay"
                    onClick={() => setShowFullscreen(false)}
                  >
                    <img
                      src={message.image_data}
                      alt={message.content}
                      className="image-fullscreen"
                    />
                    <button
                      className="image-fullscreen-close"
                      onClick={() => setShowFullscreen(false)}
                    >✕</button>
                  </div>
                )}
              </>
            ) : (
              <div className="msg-text">{message.content}</div>
            )
          ) : (
            <div className="msg-text msg-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
          )}
          {isStreaming && <StreamingToolIndicator activeTools={activeTools || []} toolProgress={toolProgress || []} />}
          {isStreaming && !message.content && (!activeTools || activeTools.length === 0) && (
            <div className="msg-typing">
              <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
            </div>
          )}
          {message.created_at && <div className="msg-time">{formatTime(message.created_at)}</div>}
        </div>
      </div>
    </>
  )
}
