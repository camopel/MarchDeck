import { useEffect, useState, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const API = import.meta.env.VITE_API_BASE || '/api/app/notes'

interface NoteSummary {
  id: string
  title: string
  preview: string
  pinned: boolean
  updated_at: string
}

interface NoteDetail {
  id: string
  title: string
  content: string
  pinned: boolean
  created_at: string
  updated_at: string
}

/* ── Time formatting ── */
function timeAgo(iso: string): string {
  if (!iso) return ''
  const normalized = iso.endsWith('Z') ? iso : iso + 'Z'
  const diff = Date.now() - new Date(normalized).getTime()
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(normalized).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* ── Strip markdown for preview text ── */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#+\s+/gm, '')        // headings
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links
    .replace(/(\*\*|__)(.*?)\1/g, '$2')        // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')           // italic
    .replace(/~~(.*?)~~/g, '$1')               // strikethrough
    .replace(/`{1,3}[^`]*`{1,3}/g, '')        // code
    .replace(/^[-*+]\s+/gm, '')               // list items
    .replace(/^\d+\.\s+/gm, '')               // ordered list
    .replace(/^>\s+/gm, '')                   // blockquotes
    .replace(/---+/g, '')                      // hr
    .replace(/\n{2,}/g, ' ')
    .trim()
}

/* ── Main App ── */
export default function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeNote, setActiveNote] = useState<NoteDetail | null>(null)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [previewMode, setPreviewMode] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef('')

  /* ── Fetch notes ── */
  const fetchNotes = useCallback((query?: string) => {
    const url = query ? `${API}/search?q=${encodeURIComponent(query)}` : `${API}/list`
    fetch(url)
      .then(r => r.json())
      .then(d => { setNotes(d.notes || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { fetchNotes() }, [fetchNotes])

  /* ── Search with debounce ── */
  const onSearch = useCallback((q: string) => {
    setSearchQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      fetchNotes(q || undefined)
    }, 300)
  }, [fetchNotes])

  /* ── Save note ── */
  const doSave = useCallback(async (noteId: string, content: string) => {
    if (!noteId) return
    setSaving('saving')
    try {
      const r = await fetch(`${API}/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (r.ok) {
        setSaving('saved')
        setTimeout(() => setSaving(prev => prev === 'saved' ? 'idle' : prev), 2000)
      }
    } catch { /* retry on next change */ }
  }, [])

  /* ── Auto-save with debounce ── */
  const scheduleAutoSave = useCallback((noteId: string, content: string) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    contentRef.current = content
    saveTimer.current = setTimeout(() => {
      doSave(noteId, content)
    }, 1000)
  }, [doSave])

  /* ── Open note ── */
  const openNote = useCallback(async (noteId: string) => {
    try {
      const r = await fetch(`${API}/${noteId}`)
      const note: NoteDetail = await r.json()
      setActiveNote(note)
      setEditContent(note.content)
      contentRef.current = note.content
      setSaving('idle')
      setPreviewMode(false)
      setMenuOpen(false)
      setTimeout(() => textareaRef.current?.focus(), 150)
    } catch { /* ignore */ }
  }, [])

  /* ── Create note ── */
  const createNote = useCallback(async () => {
    try {
      const r = await fetch(`${API}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }),
      })
      const note: NoteDetail = await r.json()
      setActiveNote(note)
      setEditContent('')
      contentRef.current = ''
      setSaving('idle')
      setPreviewMode(false)
      setMenuOpen(false)
      setTimeout(() => textareaRef.current?.focus(), 150)
    } catch { /* ignore */ }
  }, [])

  /* ── Delete note ── */
  const deleteNote = useCallback(async (noteId: string) => {
    if (!window.confirm('Delete this note?')) return
    try {
      await fetch(`${API}/${noteId}`, { method: 'DELETE' })
      if (activeNote?.id === noteId) {
        setActiveNote(null)
      }
      fetchNotes(searchQuery || undefined)
    } catch { /* ignore */ }
  }, [activeNote, fetchNotes, searchQuery])

  /* ── Toggle pin ── */
  const togglePin = useCallback(async () => {
    if (!activeNote) return
    try {
      const r = await fetch(`${API}/${activeNote.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: !activeNote.pinned }),
      })
      if (r.ok) {
        const updated: NoteDetail = await r.json()
        setActiveNote(updated)
      }
    } catch { /* ignore */ }
    setMenuOpen(false)
  }, [activeNote])

  /* ── Image upload helper ── */
  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    const formData = new FormData()
    formData.append('file', file)
    try {
      const r = await fetch(`${API}/upload`, { method: 'POST', body: formData })
      if (r.ok) {
        const { url } = await r.json()
        return url
      }
    } catch { /* ignore */ }
    return null
  }, [])

  /* ── Insert text at cursor ── */
  const insertAtCursor = useCallback((before: string, after: string = '', selectMiddle = false) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = editContent.slice(start, end)
    const insert = before + selected + after
    const newContent = editContent.slice(0, start) + insert + editContent.slice(end)
    setEditContent(newContent)
    contentRef.current = newContent
    if (activeNote) scheduleAutoSave(activeNote.id, newContent)
    setTimeout(() => {
      ta.focus()
      if (selectMiddle && !selected) {
        // Place cursor between before and after
        ta.setSelectionRange(start + before.length, start + before.length)
      } else {
        const pos = start + insert.length
        ta.setSelectionRange(pos, pos)
      }
    }, 10)
  }, [editContent, activeNote, scheduleAutoSave])

  /* ── Toolbar actions ── */
  const toolbarBold = useCallback(() => insertAtCursor('**', '**', true), [insertAtCursor])
  const toolbarItalic = useCallback(() => insertAtCursor('*', '*', true), [insertAtCursor])
  const toolbarHeading = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    // Find start of current line
    const lineStart = editContent.lastIndexOf('\n', start - 1) + 1
    const lineEnd = editContent.indexOf('\n', start)
    const line = editContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    // Cycle through heading levels
    const match = line.match(/^(#{1,3})\s/)
    let newLine: string
    if (!match) {
      newLine = '# ' + line
    } else if (match[1] === '#') {
      newLine = '## ' + line.slice(match[0].length)
    } else if (match[1] === '##') {
      newLine = '### ' + line.slice(match[0].length)
    } else {
      newLine = line.slice(match[0].length)
    }
    const newContent = editContent.slice(0, lineStart) + newLine + editContent.slice(lineEnd === -1 ? editContent.length : lineEnd)
    setEditContent(newContent)
    contentRef.current = newContent
    if (activeNote) scheduleAutoSave(activeNote.id, newContent)
    setTimeout(() => {
      ta.focus()
      const pos = lineStart + newLine.length
      ta.setSelectionRange(pos, pos)
    }, 10)
  }, [editContent, activeNote, scheduleAutoSave])
  const toolbarLink = useCallback(() => insertAtCursor('[', '](url)', true), [insertAtCursor])
  const toolbarList = useCallback(() => insertAtCursor('- ', '', false), [insertAtCursor])
  const toolbarImage = useCallback(() => { fileInputRef.current?.click() }, [])

  /* ── Handle image upload from file picker ── */
  const handleImageUpload = useCallback(async (file: File) => {
    const url = await uploadImage(file)
    if (url) {
      insertAtCursor(`![image](${url})\n`)
    }
  }, [uploadImage, insertAtCursor])

  /* ── Handle paste (detect images) ── */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (file) {
          const url = await uploadImage(file)
          if (url) {
            const ta = textareaRef.current
            if (ta) {
              const start = ta.selectionStart
              const insert = `![image](${url})\n`
              const newContent = editContent.slice(0, start) + insert + editContent.slice(ta.selectionEnd)
              setEditContent(newContent)
              contentRef.current = newContent
              if (activeNote) scheduleAutoSave(activeNote.id, newContent)
              setTimeout(() => {
                ta.focus()
                const pos = start + insert.length
                ta.setSelectionRange(pos, pos)
              }, 10)
            }
          }
        }
        return
      }
    }
  }, [editContent, activeNote, scheduleAutoSave, uploadImage])

  /* ── Share note ── */
  const shareNote = useCallback(async () => {
    if (!activeNote) return
    const title = stripMarkdown(editContent.split('\n').find(l => l.trim()) || '').slice(0, 50) || 'Note'
    const safeTitle = title.replace(/[^\w\s-]/g, '').trim().slice(0, 50) || 'note'
    const content = contentRef.current || editContent

    if (navigator.share) {
      try {
        const file = new File([content], `${safeTitle}.md`, { type: 'text/markdown' })
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title })
        } else {
          await navigator.share({ title, text: content })
        }
      } catch {
        // User cancelled or share failed — ignore
      }
    } else {
      // Fallback: download
      const blob = new Blob([content], { type: 'text/markdown' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${safeTitle}.md`
      a.click()
      URL.revokeObjectURL(a.href)
    }
    setMenuOpen(false)
  }, [activeNote, editContent])

  /* ── Go back ── */
  const goBack = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (activeNote) {
      doSave(activeNote.id, contentRef.current)
    }
    setActiveNote(null)
    setPreviewMode(false)
    setMenuOpen(false)
    fetchNotes(searchQuery || undefined)
  }, [activeNote, doSave, fetchNotes, searchQuery])

  /* ── Close menu on outside tap ── */
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [menuOpen])

  /* ── Extract display title from content ── */
  const displayTitle = activeNote
    ? (stripMarkdown(editContent.split('\n').find(l => l.trim()) || '').slice(0, 50) || 'Untitled')
    : ''

  /* ════════════════════════════════════════════════════════════════════
     EDITOR VIEW
     ════════════════════════════════════════════════════════════════════ */
  if (activeNote) {
    return (
      <div className="page">
        {/* Nav bar */}
        <div className="nav-bar">
          <button className="nav-btn" onClick={goBack} style={{ fontSize: 15, fontWeight: 400 }}>
            ← Notes
          </button>
          <div className="title" style={{ fontSize: 15, fontWeight: 500, opacity: 0.7 }}>
            {displayTitle}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="save-indicator">
              {saving === 'saving' ? '⟳' : saving === 'saved' ? '✓' : ''}
            </span>
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button className="nav-btn" onClick={() => setMenuOpen(m => !m)} style={{ fontSize: 18 }}>
                ⋯
              </button>
              {menuOpen && (
                <div className="menu-dropdown">
                  <button className="menu-item" onClick={togglePin}>
                    {activeNote.pinned ? '📌 Unpin' : '📌 Pin'}
                  </button>
                  <button className="menu-item" onClick={shareNote}>
                    📤 Share
                  </button>
                  <button className="menu-item menu-item-danger" onClick={() => { deleteNote(activeNote.id) }}>
                    🗑 Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Formatting toolbar */}
        <div className="editor-toolbar">
          <button className="toolbar-btn" onClick={toolbarBold} title="Bold"><b>B</b></button>
          <button className="toolbar-btn" onClick={toolbarItalic} title="Italic"><i>I</i></button>
          <button className="toolbar-btn" onClick={toolbarHeading} title="Heading">H</button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={toolbarLink} title="Link">🔗</button>
          <button className="toolbar-btn" onClick={toolbarImage} title="Image">🖼</button>
          <button className="toolbar-btn" onClick={toolbarList} title="List">☰</button>
          <div className="toolbar-divider" />
          <button
            className={`toolbar-btn${previewMode ? ' toolbar-btn-active' : ''}`}
            onClick={() => setPreviewMode(p => !p)}
            title={previewMode ? 'Edit' : 'Preview'}
          >
            {previewMode ? '✏️' : '👁'}
          </button>
        </div>

        {/* Hidden file input for image upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleImageUpload(f)
            e.target.value = ''
          }}
        />

        {/* Editor or Preview */}
        <div className="editor-area">
          {previewMode ? (
            <div className="md-preview">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{editContent}</ReactMarkdown>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={editContent}
              onChange={e => {
                const val = e.target.value
                setEditContent(val)
                contentRef.current = val
                scheduleAutoSave(activeNote.id, val)
              }}
              onPaste={handlePaste}
              placeholder="Start writing..."
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
        </div>
      </div>
    )
  }

  /* ════════════════════════════════════════════════════════════════════
     NOTES LIST VIEW
     ════════════════════════════════════════════════════════════════════ */
  return (
    <div className="page">
      {/* Nav bar */}
      <div className="nav-bar">
        <a href="/" className="nav-btn" style={{ textDecoration: 'none', fontSize: 15, fontWeight: 400 }}>
          ← Back
        </a>
        <div className="title">Notes</div>
        <button className="nav-btn" onClick={createNote} style={{ fontSize: 24, fontWeight: 300 }}>
          +
        </button>
      </div>

      {/* Search bar */}
      <div className="search-bar">
        <input
          className="search-input"
          type="text"
          placeholder="Search notes..."
          value={searchQuery}
          onChange={e => onSearch(e.target.value)}
        />
      </div>

      {/* Content */}
      <div className="content">
        {loading ? (
          <div className="loading"><div className="spinner" /></div>
        ) : notes.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📝</div>
            <div className="empty-text">
              {searchQuery ? 'No notes found' : 'No notes yet'}
            </div>
            {!searchQuery && (
              <button className="empty-btn" onClick={createNote}>+</button>
            )}
          </div>
        ) : (
          <div>
            {notes.map(note => (
              <div
                key={note.id}
                className="note-card"
                onClick={() => openNote(note.id)}
              >
                <div className="note-card-header">
                  {note.pinned && <span className="note-card-pin">📌</span>}
                  <div className="note-card-title">{stripMarkdown(note.title) || 'Untitled'}</div>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0, marginLeft: 8 }}>
                    {timeAgo(note.updated_at)}
                  </span>
                </div>
                {note.preview && (
                  <div className="note-card-preview">
                    {stripMarkdown(note.preview).slice(0, 80)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
