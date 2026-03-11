import { useEffect, useState, useCallback, useRef } from 'react'

const API = import.meta.env.VITE_API_BASE || '/api/app/files'

interface FileEntry {
  name: string
  is_dir: boolean
  size: number | null
  modified: string | null
  mime: string | null
}

interface DirListing {
  path: string
  root: string
  entries: FileEntry[]
}

interface Preview {
  path: string
  name: string
  mime: string
  content?: string
}

function fmtSize(b: number | null): string {
  if (b === null) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(1)} GB`
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function icon(e: FileEntry): string {
  if (e.is_dir) return '📁'
  const m = e.mime ?? ''
  const n = e.name.toLowerCase()
  if (m.startsWith('image/')) return '🖼️'
  if (m.startsWith('video/')) return '🎬'
  if (m.startsWith('audio/')) return '🎵'
  if (n.endsWith('.pdf')) return '📕'
  if (n.endsWith('.zip') || n.endsWith('.tar') || n.endsWith('.gz')) return '🗜️'
  if (n.endsWith('.py') || n.endsWith('.js') || n.endsWith('.ts') || n.endsWith('.sh')) return '💻'
  if (n.endsWith('.json') || n.endsWith('.yaml') || n.endsWith('.toml')) return '⚙️'
  if (n.endsWith('.md')) return '📝'
  return '📄'
}

function isTextFile(name: string, mime: string): boolean {
  if (mime.startsWith('text/') || mime === 'application/json') return true
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return ['md','txt','log','py','sh','yaml','yml','json','toml','cfg','ini','conf',
    'js','ts','tsx','jsx','css','html','xml','csv','sql','env','gitignore',
    'dockerfile','makefile','rs','go','c','h','cpp','hpp','java','rb','lua'].includes(ext)
}
function isMarkdownFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}
function isImageFile(mime: string) { return mime.startsWith('image/') }
function isVideoFile(mime: string) { return mime.startsWith('video/') }
function isAudioFile(mime: string) { return mime.startsWith('audio/') }
function canPreview(name: string, mime: string) {
  return isTextFile(name, mime) || isImageFile(mime) || isVideoFile(mime) || isAudioFile(mime)
}

/** Simple markdown → HTML renderer */
function renderMarkdown(md: string): string {
  // Process blocks first
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code blocks
    if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(esc(lines[i]))
        i++
      }
      i++ // skip closing ```
      out.push(`<pre style="background:var(--bg);padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.5;margin:8px 0"><code>${codeLines.join('\n')}</code></pre>`)
      continue
    }

    // Table detection: line has | and next line is separator (|---|)
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i])
        i++
      }
      out.push(renderTable(tableLines))
      continue
    }

    // Headers
    if (line.startsWith('#### ')) { out.push(`<h4 style="font-size:15px;font-weight:600;margin:14px 0 6px">${inline(esc(line.slice(5)))}</h4>`); i++; continue }
    if (line.startsWith('### ')) { out.push(`<h3 style="font-size:16px;font-weight:600;margin:16px 0 6px">${inline(esc(line.slice(4)))}</h3>`); i++; continue }
    if (line.startsWith('## ')) { out.push(`<h2 style="font-size:17px;font-weight:700;margin:18px 0 8px">${inline(esc(line.slice(3)))}</h2>`); i++; continue }
    if (line.startsWith('# ')) { out.push(`<h1 style="font-size:19px;font-weight:700;margin:20px 0 8px">${inline(esc(line.slice(2)))}</h1>`); i++; continue }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid var(--border);margin:12px 0"/>'); i++; continue }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^[-*] /, '')))}</li>`)
        i++
      }
      out.push(`<ul style="margin:6px 0;padding-left:20px">${items.join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^\d+\. /, '')))}</li>`)
        i++
      }
      out.push(`<ol style="margin:6px 0;padding-left:20px">${items.join('')}</ol>`)
      continue
    }

    // Empty line = paragraph break
    if (line.trim() === '') { out.push('<br/>'); i++; continue }

    // Raw HTML passthrough (e.g. <p>, <img>, <div>)
    if (/^\s*<[a-zA-Z]/.test(line)) { out.push(line); i++; continue }

    // Normal paragraph
    out.push(`<p style="margin:4px 0">${inline(esc(line))}</p>`)
    i++
  }

  return out.join('\n')
}

/** Rewrite relative image src in rendered HTML to use the file download API */
function resolveImages(html: string, filePath: string): string {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'))
  return html.replace(/<img\s+([^>]*?)src="([^"]+)"/g, (_match, pre, src) => {
    if (src.startsWith('http') || src.startsWith('/api/')) return _match
    // Resolve relative path against the markdown file's directory
    const abs = dir + '/' + src
    const url = `${API}/download?path=${encodeURIComponent(abs)}`
    return `<img ${pre}src="${url}"`
  })
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg);padding:2px 5px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:4px 0"/>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent)" target="_blank">$1</a>')
}

function renderTable(lines: string[]): string {
  const parseRow = (line: string) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())

  const headers = parseRow(lines[0])
  // lines[1] is separator, skip it
  const rows = lines.slice(2).map(parseRow)

  const thStyle = 'padding:8px 10px;text-align:left;font-weight:600;font-size:13px;border-bottom:2px solid var(--border);white-space:nowrap'
  const tdStyle = 'padding:6px 10px;font-size:13px;border-bottom:0.5px solid var(--border)'

  let html = '<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse">'
  html += '<thead><tr>' + headers.map(h => `<th style="${thStyle}">${inline(esc(h))}</th>`).join('') + '</tr></thead>'
  html += '<tbody>'
  for (const row of rows) {
    html += '<tr>' + row.map(c => `<td style="${tdStyle}">${inline(esc(c))}</td>`).join('') + '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

// Path is displayed via breadcrumbs directly

export default function App() {
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [deleteMode, setDeleteMode] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [swipedIdx, setSwipedIdx] = useState<number | null>(null)
  const touchRef = useRef<{ startX: number; startY: number; idx: number; currentX: number; swiping: boolean; rowW: number } | null>(null)

  const fetchDir = useCallback((p: string, hidden: boolean) => {
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams()
    if (p) qs.set('path', p)
    qs.set('show_hidden', hidden ? '1' : '0')
    fetch(`${API}/list?${qs}`)
      .then(r => { if (!r.ok) throw r; return r.json() as Promise<DirListing> })
      .then(d => { setListing(d); setPath(d.path); setLoading(false) })
      .catch(() => { setError('Failed to load'); setLoading(false) })
  }, [])

  useEffect(() => { fetchDir(path, showHidden) }, [path, showHidden, fetchDir])

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler) }
  }, [menuOpen])

  const openFile = (e: FileEntry) => {
    const full = listing?.path ? `${listing.path}/${e.name}` : e.name
    const mime = e.mime ?? ''
    if (e.is_dir) { setPreview(null); setPath(full); return }
    if (!canPreview(e.name, mime)) {
      setPreview({ path: full, name: e.name, mime, content: undefined })
      return
    }
    if (isTextFile(e.name, mime)) {
      fetch(`${API}/read?path=${encodeURIComponent(full)}`)
        .then(r => r.json())
        .then(d => setPreview({ path: full, name: e.name, mime, content: d.content }))
        .catch(() => {})
    } else {
      setPreview({ path: full, name: e.name, mime })
    }
  }

  const shareFile = async (filePath: string, name: string) => {
    if (!('share' in navigator)) return
    try {
      const blob = await fetch(`${API}/download?path=${encodeURIComponent(filePath)}`).then(r => r.blob())
      const file = new File([blob], name, { type: blob.type })
      await (navigator as any).share({ files: [file], title: name })
    } catch {}
  }

  const deleteItem = async (itemPath: string, name: string, isDir: boolean, confirm = false) => {
    if (confirm) {
      const msg = isDir ? `Delete ${name} and all contents?` : `Delete ${name}?`
      if (!window.confirm(msg)) return
    }
    try {
      const r = await fetch(`${API}/delete?path=${encodeURIComponent(itemPath)}`, { method: 'DELETE' })
      if (!r.ok) throw r
      setSwipedIdx(null)
      if (preview && preview.path === itemPath) {
        setPreview(null)
      }
      // Remove item from listing without full reload (preserves scroll)
      setListing(prev => prev ? {
        ...prev,
        entries: prev.entries.filter(e => {
          const full = prev.path ? `${prev.path}/${e.name}` : e.name
          return full !== itemPath
        }),
      } : prev)
    } catch {
      alert('Failed to delete')
    }
  }

  const downloadUrl = (p: string) => `${API}/download?path=${encodeURIComponent(p)}`
  const root = listing?.root ?? '/'

  const displayStr = path || root || '/'
  const segments = displayStr.split('/').filter(Boolean)

  // Build breadcrumbs with clickable "/" root
  const breadcrumbs = [
    { label: '/', path: '/' },
    ...segments.map((seg, i) => ({
      label: seg,
      path: '/' + segments.slice(0, i + 1).join('/'),
    })),
  ]

  // ── Full-screen preview ──
  if (preview) {
    const mime = preview.mime
    const isMd = isMarkdownFile(preview.name)
    const previewable = canPreview(preview.name, mime)
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
        <div style={{
          display: 'flex', alignItems: 'center', padding: '12px 16px',
          paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))',
          background: 'var(--card-bg)', borderBottom: '0.5px solid var(--border)',
        }}>
          <button onClick={() => setPreview(null)} style={{ fontSize: 17, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '8px' }}>← Back</button>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 8px' }}>{preview.name}</div>
          {deleteMode && (
            <button onClick={() => deleteItem(preview.path, preview.name, false, true)}
              style={{ background: 'none', border: 'none', fontSize: 15, cursor: 'pointer', color: 'var(--text-secondary)', padding: '8px' }}>
              🗑️
            </button>
          )}
          {'share' in navigator && (
            <button onClick={() => shareFile(preview.path, preview.name)}
              style={{ background: 'none', border: 'none', fontSize: 15, fontWeight: 500, cursor: 'pointer', color: 'var(--accent)', padding: '8px' }}>
              Share
            </button>
          )}
        </div>

        <div style={{ padding: isImageFile(mime) || isVideoFile(mime) ? 0 : '12px 16px' }}>
          {!previewable && (
            <div style={{ padding: '60px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 60, marginBottom: 20 }}>{(() => {
                const n = preview.name.toLowerCase()
                if (n.endsWith('.pdf')) return '📕'
                if (n.endsWith('.zip') || n.endsWith('.tar') || n.endsWith('.gz')) return '🗜️'
                return '📄'
              })()}</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 24 }}>{preview.name}</div>
              <a href={downloadUrl(preview.path)} download style={{
                display: 'inline-block', padding: '12px 32px', borderRadius: 10,
                background: 'var(--accent)', color: '#fff', fontSize: 16, fontWeight: 600,
                textDecoration: 'none', marginBottom: 12,
              }}>Download</a>
              {'share' in navigator && (
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => shareFile(preview.path, preview.name)}
                    style={{ padding: '10px 28px', borderRadius: 10, background: 'none', border: '1.5px solid var(--accent)', color: 'var(--accent)', fontSize: 15, fontWeight: 500, cursor: 'pointer' }}>
                    Share
                  </button>
                </div>
              )}
            </div>
          )}
          {previewable && isImageFile(mime) && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 'calc(100vh - 60px)', background: '#000' }}>
              <img src={downloadUrl(preview.path)} alt={preview.name} style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 60px)', objectFit: 'contain' }} />
            </div>
          )}
          {previewable && isVideoFile(mime) && (
            <div style={{ background: '#000', minHeight: 'calc(100vh - 60px)', display: 'flex', alignItems: 'center' }}>
              <video src={downloadUrl(preview.path)} controls autoPlay playsInline style={{ width: '100%', maxHeight: 'calc(100vh - 60px)' }} />
            </div>
          )}
          {previewable && isAudioFile(mime) && (
            <div style={{ padding: '40px 16px', textAlign: 'center' }}>
              <div style={{ fontSize: 60, marginBottom: 20 }}>🎵</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>{preview.name}</div>
              <audio src={downloadUrl(preview.path)} controls autoPlay style={{ width: '100%', maxWidth: 400 }} />
            </div>
          )}
          {previewable && isTextFile(preview.name, mime) && preview.content !== undefined && (
            isMd ? (
              <div style={{ background: 'var(--card-bg)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 0 0 0.5px var(--border)' }}>
                <div className="md-render" style={{ padding: 16, fontSize: 14, lineHeight: 1.7, overflow: 'auto', maxHeight: 'calc(100vh - 120px)', wordBreak: 'break-word' }}
                  dangerouslySetInnerHTML={{ __html: resolveImages(renderMarkdown(preview.content), preview.path) }} />
              </div>
            ) : (
              <div style={{ background: 'var(--card-bg)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 0 0 0.5px var(--border)' }}>
                <pre style={{
                  padding: 16, fontSize: 13, lineHeight: 1.6, overflow: 'auto',
                  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  color: 'var(--text)', maxHeight: 'calc(100vh - 120px)',
                }}>{preview.content}</pre>
              </div>
            )
          )}
        </div>
        <style>{cssVars}</style>
      </div>
    )
  }

  // ── Directory listing ──
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>
      {/* Nav bar */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '12px 16px',
        paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))',
        background: 'var(--card-bg)', borderBottom: '0.5px solid var(--border)',
      }}>
        <a href="/" style={{
          fontSize: 15, color: 'var(--accent)', textDecoration: 'none',
          padding: '4px 8px 4px 0', flexShrink: 0, whiteSpace: 'nowrap',
        }}>← Back</a>
        <div style={{ flex: 1, fontSize: 17, fontWeight: 600, textAlign: 'center' }}>File Browser</div>
        {/* Menu button */}
        <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={() => setMenuOpen(m => !m)} style={{
            background: 'none', border: 'none', fontSize: 20, cursor: 'pointer',
            color: 'var(--text-secondary)', padding: '4px 8px', lineHeight: 1,
          }}>⋯</button>
          {menuOpen && (
            <div style={{
              position: 'absolute', right: 0, top: '100%', marginTop: 6,
              background: 'var(--card-bg)', borderRadius: 12, padding: '8px 0',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)', border: '0.5px solid var(--border)',
              minWidth: 180, zIndex: 100,
            }}>
              {/* Hidden files toggle */}
              <div onClick={() => setShowHidden(h => !h)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', cursor: 'pointer',
              }}>
                <span style={{ fontSize: 14, color: 'var(--text)' }}>Hidden files</span>
                <div style={{
                  background: showHidden ? 'var(--accent)' : 'var(--border)',
                  borderRadius: 12, width: 40, height: 24, position: 'relative',
                  transition: 'background 0.2s', flexShrink: 0,
                }}>
                  <span style={{
                    position: 'absolute', top: 2, left: showHidden ? 18 : 2,
                    width: 20, height: 20, borderRadius: 10, background: '#fff',
                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </div>
              </div>
              {/* Delete mode toggle */}
              <div onClick={() => setDeleteMode(d => !d)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px', cursor: 'pointer',
              }}>
                <span style={{ fontSize: 14, color: deleteMode ? '#FF3B30' : 'var(--text)' }}>Delete mode</span>
                <div style={{
                  background: deleteMode ? '#FF3B30' : 'var(--border)',
                  borderRadius: 12, width: 40, height: 24, position: 'relative',
                  transition: 'background 0.2s', flexShrink: 0,
                }}>
                  <span style={{
                    position: 'absolute', top: 2, left: deleteMode ? 18 : 2,
                    width: 20, height: 20, borderRadius: 10, background: '#fff',
                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Breadcrumbs */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2, padding: '8px 16px',
        fontSize: 13, color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'nowrap',
        background: 'var(--card-bg)', borderBottom: '0.5px solid var(--border)',
      }}>
        {breadcrumbs.map((bc, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {i > 0 && <span style={{ color: 'var(--text-secondary)', margin: '0 2px', fontSize: 11 }}>›</span>}
            <button onClick={() => setPath(bc.path)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 4, fontSize: 13,
                color: i === breadcrumbs.length - 1 ? 'var(--text)' : 'var(--accent)',
                fontWeight: i === breadcrumbs.length - 1 ? 600 : 400,
              }}>{bc.label}</button>
          </span>
        ))}
      </div>

      {/* Listing — flush under breadcrumbs */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}><div style={spinnerStyle} /></div>
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>⚠️ {error}</div>
      ) : listing && listing.entries.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>📂 Empty folder</div>
      ) : listing && (
        <div>
          {listing.entries.map((e, i) => {
            const itemPath = listing.path ? `${listing.path}/${e.name}` : e.name
            const isOpen = swipedIdx === i
            const SWIPE_W = 80

            const onTouchStart = (ev: React.TouchEvent) => {
              if (!deleteMode) return
              const t = ev.touches[0]
              const rowW = ev.currentTarget.getBoundingClientRect().width
              touchRef.current = { startX: t.clientX, startY: t.clientY, idx: i, currentX: isOpen ? -SWIPE_W : 0, swiping: false, rowW }
            }

            const onTouchMove = (ev: React.TouchEvent) => {
              if (!deleteMode) return
              const ref = touchRef.current
              if (!ref || ref.idx !== i) return
              const t = ev.touches[0]
              const dx = t.clientX - ref.startX
              const dy = t.clientY - ref.startY

              // Lock direction: if vertical movement dominates, bail out
              if (!ref.swiping && Math.abs(dy) > Math.abs(dx)) {
                touchRef.current = null
                return
              }
              ref.swiping = true

              // Clamp swipe to max 25% of row width
              const maxSwipe = ref.rowW * 0.3
              const base = isOpen ? -SWIPE_W : 0
              ref.currentX = Math.max(-maxSwipe, Math.min(0, base + dx))

              const row = ev.currentTarget.querySelector<HTMLElement>('[data-row-inner]')
              if (row) {
                row.style.transition = 'none'
                row.style.transform = `translateX(${ref.currentX}px)`
              }

              const del = ev.currentTarget.querySelector<HTMLElement>('[data-delete-btn]')
              if (del) {
                const exposed = Math.abs(ref.currentX)
                del.style.width = `${Math.max(SWIPE_W, exposed)}px`
              }
            }

            const onTouchEnd = (ev: React.TouchEvent) => {
              if (!deleteMode) return
              const ref = touchRef.current
              if (!ref || ref.idx !== i || !ref.swiping) {
                touchRef.current = null
                return
              }

              const row = ev.currentTarget.querySelector<HTMLElement>('[data-row-inner]')
              const del = ev.currentTarget.querySelector<HTMLElement>('[data-delete-btn]')
              const swipedFar = Math.abs(ref.currentX) > SWIPE_W / 2

              if (swipedFar) {
                // Stay open — snap to SWIPE_W
                if (row) {
                  row.style.transition = 'transform 0.25s ease'
                  row.style.transform = `translateX(-${SWIPE_W}px)`
                }
                if (del) {
                  del.style.transition = 'width 0.25s ease'
                  del.style.width = `${SWIPE_W}px`
                }
                setSwipedIdx(i)
              } else {
                // Snap back closed
                if (row) {
                  row.style.transition = 'transform 0.25s ease'
                  row.style.transform = 'translateX(0)'
                }
                if (del) {
                  del.style.transition = 'width 0.25s ease'
                  del.style.width = '0px'
                }
                setSwipedIdx(null)
              }
              touchRef.current = null
            }

            return (
              <div key={i} style={{ position: 'relative', overflow: 'hidden', background: 'var(--card-bg)' }}
                onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
              >
                {/* Red delete button — starts at width:0, expands only during active swipe */}
                {deleteMode && (
                <div data-delete-btn="" style={{
                  position: 'absolute', right: 0, top: 0, bottom: 0,
                  width: isOpen ? SWIPE_W : 0,
                  overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: '#FF3B30', color: '#fff', fontSize: 14, fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'width 0.25s ease',
                }} onClick={(ev) => { ev.stopPropagation(); deleteItem(itemPath, e.name, e.is_dir) }}>
                  Delete
                </div>
                )}
                {/* Sliding row content */}
                <div data-row-inner="" onClick={() => { if (swipedIdx !== null) { setSwipedIdx(null); return } openFile(e) }} style={{
                  ...rowStyle, background: 'var(--card-bg)', position: 'relative', zIndex: 1,
                  borderBottom: i < listing.entries.length - 1 ? '0.5px solid var(--border)' : 'none',
                  transform: isOpen ? `translateX(-${SWIPE_W}px)` : 'translateX(0)',
                  transition: 'transform 0.25s ease',
                  willChange: 'transform',
                }}>
                  <span style={{ fontSize: 18, width: 28, textAlign: 'center', flexShrink: 0 }}>{icon(e)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: e.name.startsWith('.') ? 'var(--text-secondary)' : 'var(--text)',
                    }}>{e.name}</div>
                    {!e.is_dir && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                        {[fmtSize(e.size), fmtDate(e.modified)].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  {e.is_dir && <span style={{ color: 'var(--text-secondary)', fontSize: 18, flexShrink: 0 }}>›</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <style>{cssVars}</style>
    </div>
  )
}

const cssVars = `
  :root { --bg: #f2f2f7; --card-bg: #fff; --text: #1c1c1e; --text-secondary: #8e8e93; --border: rgba(0,0,0,0.1); --accent: #007AFF; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --card-bg: #1c1c1e; --text: #f2f2f7; --text-secondary: #8e8e93; --border: rgba(255,255,255,0.1); --accent: #64D2FF; color-scheme: dark; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); }
  @keyframes spin { to { transform: rotate(360deg) } }
  .md-render strong { font-weight: 600; }
  .md-render em { font-style: italic; }
  .md-render li { padding-left: 4px; }
  .md-render a { text-decoration: none; }
  .md-render a:hover { text-decoration: underline; }
`

const spinnerStyle: React.CSSProperties = {
  width: 24, height: 24, margin: '0 auto',
  border: '2.5px solid var(--border)', borderTopColor: 'var(--accent)',
  borderRadius: '50%', animation: 'spin 0.7s linear infinite',
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '11px 16px', cursor: 'pointer',
  borderBottom: '0.5px solid var(--border)',
}
