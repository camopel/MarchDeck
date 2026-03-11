import { useState, useRef, useEffect, useCallback } from 'react'
import { Message, StreamingState } from './types'
import { MessageBubble } from './MessageBubble'

interface ChatViewProps {
  sessionId: string | null
  messages: Message[]
  streaming: StreamingState
  onSendMessage: (content: string) => void
  onSendAttachment?: (file: File) => void
  onSendVoice?: (blob: Blob) => void
  isConnected: boolean
  isReconnecting: boolean
}

/* ── Microphone icon (outline, classic style) ──────────────────────────── */
function MicIcon({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="9" y1="22" x2="15" y2="22" />
    </svg>
  )
}

/* ── Waveform bars (animated during recording) ─────────────────────────── */
function RecordingWaveform() {
  return (
    <div className="recording-waveform">
      {Array.from({ length: 12 }).map((_, i) => (
        <span key={i} className="wave-bar" style={{ animationDelay: `${i * 0.08}s` }} />
      ))}
    </div>
  )
}

export function ChatView({
  sessionId,
  messages,
  streaming,
  onSendMessage,
  onSendAttachment,
  onSendVoice,
  isConnected,
  isReconnecting,
}: ChatViewProps) {
  const [input, setInput] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<number | null>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, streaming.content, scrollToBottom])

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
  }, [])

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || !sessionId) return
    onSendMessage(trimmed)
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Enter = new line, send button = send
  }

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && onSendAttachment) onSendAttachment(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Track whether recording was cancelled (so onstop doesn't send the blob)
  const cancelledRef = useRef(false)

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // Pick a supported MIME type — order matters for iOS compatibility
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/aac',
        'audio/wav',
      ]
      let mimeType = ''
      for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) {
          mimeType = candidate
          break
        }
      }

      const recorderOpts: MediaRecorderOptions = {}
      if (mimeType) recorderOpts.mimeType = mimeType

      const recorder = new MediaRecorder(stream, recorderOpts)
      mediaRecorderRef.current = recorder
      audioChunksRef.current = []
      cancelledRef.current = false

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current)
          recordingTimerRef.current = null
        }
        // Only send if not cancelled
        if (!cancelledRef.current) {
          const actualMime = recorder.mimeType || mimeType || 'audio/webm'
          const blob = new Blob(audioChunksRef.current, { type: actualMime })
          if (blob.size > 0 && onSendVoice) onSendVoice(blob)
        }
        audioChunksRef.current = []
        setIsRecording(false)
        setRecordingDuration(0)
      }

      recorder.onerror = (e) => {
        console.error('MediaRecorder error:', e)
        stream.getTracks().forEach(t => t.stop())
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current)
          recordingTimerRef.current = null
        }
        setIsRecording(false)
        setRecordingDuration(0)
      }

      // iOS Safari: don't pass timeslice — it can cause ondataavailable to
      // never fire on some versions. Instead, just call start() and rely on
      // the final ondataavailable when stop() is called.
      recorder.start()
      setIsRecording(true)
      setRecordingDuration(0)
      recordingTimerRef.current = window.setInterval(
        () => setRecordingDuration(d => d + 1), 1000
      )
    } catch (err) {
      console.error('Microphone access denied:', err)
      alert('Microphone access denied. Please allow microphone access in Settings > Safari > Microphone.')
    }
  }

  const stopRecording = () => {
    cancelledRef.current = false
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  const cancelRecording = () => {
    cancelledRef.current = true
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  const fmtDur = (s: number) =>
    `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`

  const shouldShowDate = (msg: Message, idx: number): boolean => {
    if (idx === 0) return true
    const prev = messages[idx - 1]
    return new Date(prev.created_at).toDateString() !== new Date(msg.created_at).toDateString()
  }

  if (!sessionId) {
    return (
      <div className="chat-empty">
        <p>Select a session or create a new one to start chatting</p>
      </div>
    )
  }

  const hasText = !!input.trim()
  const canInteract = isConnected || isReconnecting

  return (
    <div className="chat-view">
      <div className="chat-messages" ref={scrollContainerRef}>
        {messages.length === 0 && !streaming.isStreaming && (
          <div className="chat-start-hint"><p>Send a message to start the conversation</p></div>
        )}

        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            showDate={shouldShowDate(msg, idx)}
          />
        ))}

        {streaming.isStreaming && (
          <>
            <MessageBubble
              message={{ id: '__streaming__', session_id: sessionId, role: 'assistant', content: streaming.content, tool_calls: [], created_at: '' }}
              isStreaming={true}
              activeTools={streaming.activeTools}
              toolProgress={streaming.toolProgress}
            />
          </>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ────────────────────────────────────────────────── */}
      <div className="chat-input-bar">
        <input ref={fileInputRef} type="file"
          accept="image/*,application/pdf,text/*,.json,.yaml,.yml,.toml,.csv,.md"
          style={{ display: 'none' }} onChange={handleFileSelected} />

        {isRecording ? (
          /* ── Recording mode ──────────────────────────────────────── */
          <div className="chat-input-wrap recording">
            <button className="rec-cancel-btn" onClick={cancelRecording} title="Cancel">
              ✕
            </button>
            <div className="recording-body">
              <RecordingWaveform />
              <span className="recording-time">{fmtDur(recordingDuration)}</span>
            </div>
            <button className="chat-send-btn" onClick={stopRecording} title="Send voice">
              ▲
            </button>
          </div>
        ) : (
          /* ── Normal composer ─────────────────────────────────────── */
          <div className="chat-input-wrap">
            <button className="composer-btn" onClick={() => fileInputRef.current?.click()}
              disabled={!canInteract} title="Attach file">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </button>
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="Message..."
              value={input}
              onChange={e => {
                setInput(e.target.value)
                const ta = e.target
                ta.style.height = 'auto'
                ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                setTimeout(() => {
                  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                }, 300)
              }}
              onBlur={() => {
                // iOS: scroll page back when keyboard closes
                setTimeout(() => window.scrollTo(0, 0), 100)
              }}
              disabled={!canInteract}
              rows={1}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="sentences"
              spellCheck={false}
              enterKeyHint="send"
              inputMode="text"
            />
            {hasText ? (
              <button className="chat-send-btn" onClick={handleSend}
                disabled={!canInteract} title="Send">
                ▲
              </button>
            ) : (
              <button className="composer-btn composer-btn-mic"
                onClick={startRecording} disabled={!canInteract} title="Voice message">
                <MicIcon size={20} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
