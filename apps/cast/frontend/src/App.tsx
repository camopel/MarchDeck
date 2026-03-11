import { useEffect, useState, useRef, useCallback } from 'react'

const API = '/api/app/cast'

interface Device {
  name: string
  model: string
  uuid: string
  host: string
  port: number
}

interface PlaybackStatus {
  state: string
  title: string
  current_time: number
  duration: number
  volume: number
  muted: boolean
  thumb: string
}

interface Episode {
  index: number
  title: string
}

interface ExtractResult {
  m3u8_url: string
  title: string
  poster: string
  duration: number
  episodes: Episode[]
}

interface TvStatus {
  paired: boolean
  is_on: boolean | null
  error?: string
}

function formatTime(s: number): string {
  if (!s || !isFinite(s)) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function App() {
  // State
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedDevice, setSelectedDevice] = useState(() => localStorage.getItem('cast_device') || '')
  const [url, setUrl] = useState(() => localStorage.getItem('cast_url') || '')
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<PlaybackStatus | null>(null)
  const [extractResult, setExtractResult] = useState<ExtractResult | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(false)

  // TV power state
  const [tvStatus, setTvStatus] = useState<TvStatus | null>(null)
  const [tvLoading, setTvLoading] = useState(false)
  const [pairingMode, setPairingMode] = useState(false)
  const [pairingPin, setPairingPin] = useState('')
  const [pairingStep, setPairingStep] = useState<'idle' | 'waiting_pin' | 'finishing'>('idle')

  // Discover devices
  const discoverDevices = useCallback(async () => {
    setDevicesLoading(true)
    setError('')
    try {
      const res = await fetch(`${API}/devices`)
      const data = await res.json()
      const devs = data.devices || []
      setDevices(devs)
      // Restore saved device or default to first
      const saved = localStorage.getItem('cast_device')
      if (saved && devs.some((d: Device) => d.name === saved)) {
        setSelectedDevice(saved)
      } else if (devs.length > 0 && !selectedDevice) {
        setSelectedDevice(devs[0].name)
      }
    } catch (e) {
      setError('Failed to discover devices')
    } finally {
      setDevicesLoading(false)
    }
  }, [selectedDevice])

  // Check TV status
  const checkTvStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/tv/status`)
      const data: TvStatus = await res.json()
      setTvStatus(data)
    } catch {
      // ignore
    }
  }, [])

  // Toggle TV power
  const toggleTvPower = useCallback(async () => {
    setTvLoading(true)
    setError('')
    try {
      const res = await fetch(`${API}/tv/power`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Power toggle failed' }))
        throw new Error(err.detail || 'Failed')
      }
      const data = await res.json()
      setTvStatus(prev => prev ? { ...prev, is_on: data.is_on } : null)
      // Re-check after a moment
      setTimeout(checkTvStatus, 3000)
    } catch (e: any) {
      setError(e.message || 'Power toggle failed')
    } finally {
      setTvLoading(false)
    }
  }, [checkTvStatus])

  // Start pairing
  const startPairing = useCallback(async () => {
    setError('')
    setPairingStep('waiting_pin')
    try {
      const res = await fetch(`${API}/tv/pair/start`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Pairing failed' }))
        throw new Error(err.detail || 'Failed')
      }
      // Now waiting for user to enter PIN
    } catch (e: any) {
      setError(e.message || 'Pairing failed')
      setPairingStep('idle')
    }
  }, [])

  // Finish pairing with PIN
  const finishPairing = useCallback(async () => {
    if (!pairingPin.trim()) return
    setPairingStep('finishing')
    setError('')
    try {
      const res = await fetch(`${API}/tv/pair/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pairingPin.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Invalid PIN' }))
        throw new Error(err.detail || 'Failed')
      }
      const data = await res.json()
      setTvStatus({ paired: true, is_on: data.is_on })
      setPairingMode(false)
      setPairingStep('idle')
      setPairingPin('')
    } catch (e: any) {
      setError(e.message || 'Pairing failed')
      setPairingStep('idle')
    }
  }, [pairingPin])

  // Extract + Cast in one step
  const handleCast = useCallback(async () => {
    const trimmed = url.trim()
    setUrl(trimmed)
    if (!trimmed || !selectedDevice) {
      setError(!selectedDevice ? 'Select a device first' : 'Enter a URL')
      return
    }
    // Basic URL validation
    try {
      const u = new URL(trimmed)
      if (!u.protocol.startsWith('http')) throw new Error()
    } catch {
      setError('Invalid URL — enter a full web address (https://...)')
      return
    }
    setExtracting(true)
    setError('')
    setExtractResult(null)
    try {
      const res = await fetch(`${API}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Extraction failed' }))
        throw new Error(err.detail || 'Extraction failed')
      }
      const data: ExtractResult = await res.json()
      setExtractResult(data)
      setExtracting(false)

      setLoading(true)
      const castRes = await fetch(`${API}/cast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_name: selectedDevice,
          m3u8_url: data.m3u8_url,
          title: data.title,
          poster: data.poster,
        }),
      })
      if (!castRes.ok) {
        const err = await castRes.json().catch(() => ({ detail: 'Cast failed' }))
        throw new Error(err.detail || 'Cast failed')
      }
      startPolling()
    } catch (e: any) {
      setError(e.message || 'Failed')
    } finally {
      setExtracting(false)
      setLoading(false)
    }
  }, [url, selectedDevice])

  // Poll status
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/status`)
      const data: PlaybackStatus = await res.json()
      setStatus(data)
      if (data.state === 'idle' || data.state === 'unknown') {
        stopPolling()
      }
    } catch {
      // ignore
    }
  }, [])

  const startPolling = useCallback(() => {
    stopPolling()
    pollStatus()
    pollRef.current = setInterval(pollStatus, 2000)
  }, [pollStatus])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Control actions
  const sendControl = useCallback(async (action: string, value?: number) => {
    try {
      // Fire-and-forget for seek (don't await — allows rapid seeking)
      const p = fetch(`${API}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value }),
      })
      if (action !== 'seek') await p
      setTimeout(pollStatus, 500)
    } catch {
      // ignore
    }
  }, [pollStatus])

  // Long-press seek: hold button → keep seeking with escalating increments
  const seekIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const seekCountRef = useRef(0)

  const startSeek = useCallback((direction: number) => {
    // Immediate first seek
    seekCountRef.current = 0
    sendControl('seek', direction * 30)

    seekIntervalRef.current = setInterval(() => {
      seekCountRef.current++
      // Escalate: 30s for first 3, then 60s, then 120s, then 300s
      let step = 30
      if (seekCountRef.current > 8) step = 300
      else if (seekCountRef.current > 5) step = 120
      else if (seekCountRef.current > 3) step = 60
      sendControl('seek', direction * step)
    }, 400)
  }, [sendControl])

  const stopSeek = useCallback(() => {
    if (seekIntervalRef.current) {
      clearInterval(seekIntervalRef.current)
      seekIntervalRef.current = null
    }
    seekCountRef.current = 0
    setTimeout(pollStatus, 500)
  }, [pollStatus])

  // Long-press volume repeat
  const volIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startVolRepeat = useCallback((action: string) => {
    volIntervalRef.current = setInterval(() => {
      sendControl(action)
    }, 300)
  }, [sendControl])

  const stopVolRepeat = useCallback(() => {
    if (volIntervalRef.current) {
      clearInterval(volIntervalRef.current)
      volIntervalRef.current = null
    }
  }, [])

  // TV remote key commands
  const sendKey = useCallback(async (key: string) => {
    try {
      await fetch(`${API}/tv/key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
    } catch {
      // ignore
    }
  }, [])

  // Init
  useEffect(() => {
    discoverDevices()
    pollStatus()
    checkTvStatus()
    return () => {
      stopPolling()
      stopSeek()
      stopVolRepeat()
    }
  }, [])

  // Auto-start polling if already casting
  useEffect(() => {
    if (status && status.state !== 'idle' && status.state !== 'unknown' && !pollRef.current) {
      startPolling()
    }
  }, [status])

  const isCasting = status && status.state !== 'idle' && status.state !== 'unknown'
  const isPlaying = status?.state === 'playing'
  const progress = status && status.duration > 0 ? (status.current_time / status.duration) * 100 : 0

  return (
    <div className="page">
      <div className="nav-bar">
        <button className="nav-btn" onClick={() => window.location.href = '/'}>← Back</button>
        <div className="title">📺 Chromecast</div>
        <div className="spacer" />
      </div>

      <div className="content">
        {error && (
          <div className="error-banner" onClick={() => setError('')}>
            {error}
          </div>
        )}

        {/* Device + TV Power row */}
        <div className="card">
          <div className="card-header">
            <span className="card-label">Device</span>
            <div className="header-actions">
              {tvStatus?.paired && (
                <button
                  className={`power-btn ${tvStatus.is_on ? 'on' : 'off'}`}
                  onClick={toggleTvPower}
                  disabled={tvLoading}
                  title={tvStatus.is_on ? 'Turn off TV' : 'Turn on TV'}
                >
                  {tvLoading ? '⟳' : '⏻'}
                </button>
              )}
              <button className="refresh-btn" onClick={discoverDevices} disabled={devicesLoading}>
                {devicesLoading ? '⟳' : '↻'} Refresh
              </button>
            </div>
          </div>
          {devices.length === 0 ? (
            <div className="empty-text">{devicesLoading ? 'Searching...' : 'No devices found'}</div>
          ) : (
            <select
              className="device-select"
              value={selectedDevice}
              onChange={e => { setSelectedDevice(e.target.value); localStorage.setItem('cast_device', e.target.value); }}
            >
              {devices.map(d => (
                <option key={d.uuid} value={d.name}>
                  {d.name} ({d.model})
                </option>
              ))}
            </select>
          )}

          {/* Pairing section */}
          {tvStatus && !tvStatus.paired && (
            <div className="pair-section">
              {!pairingMode ? (
                <button className="pair-btn" onClick={() => { setPairingMode(true); startPairing(); }}>
                  🔗 Pair with TV for power control
                </button>
              ) : pairingStep === 'waiting_pin' ? (
                <div className="pair-pin">
                  <div className="pair-hint">Enter the PIN shown on your TV:</div>
                  <div className="pair-input-row">
                    <input
                      className="pin-input"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="PIN"
                      value={pairingPin}
                      onChange={e => setPairingPin(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && finishPairing()}
                      autoFocus
                    />
                    <button className="pair-confirm-btn" onClick={finishPairing} disabled={!pairingPin.trim()}>
                      Confirm
                    </button>
                    <button className="pair-cancel-btn" onClick={() => { setPairingMode(false); setPairingStep('idle'); setPairingPin(''); }}>
                      ✕
                    </button>
                  </div>
                </div>
              ) : (
                <div className="empty-text">Pairing...</div>
              )}
            </div>
          )}
        </div>

        {/* URL input */}
        <div className="card">
          <div className="card-label">Video URL</div>
          <div className="url-row">
            <input
              className="url-input"
              type="url"
              placeholder="Enter video page URL"
              value={url}
              onChange={e => { setUrl(e.target.value); localStorage.setItem('cast_url', e.target.value); }}
              onKeyDown={e => e.key === 'Enter' && handleCast()}
            />
            <button
              className="cast-btn"
              onClick={handleCast}
              disabled={extracting || loading || !url.trim() || !selectedDevice}
            >
              {extracting ? 'Extracting...' : loading ? 'Casting...' : '▶ Cast'}
            </button>
          </div>
        </div>

        {/* Now playing */}
        {(isCasting || extractResult) && (
          <div className="card now-playing">
            {(extractResult?.poster || status?.thumb) && (
              <div className="poster-row">
                <img
                  className="poster"
                  src={extractResult?.poster || status?.thumb}
                  alt=""
                />
                <div className="now-info">
                  <div className="now-title">{status?.title || extractResult?.title || 'Video'}</div>
                  <div className="now-state">{status?.state || 'ready'}</div>
                </div>
              </div>
            )}

            {isCasting && (
              <>
                <div className="progress-bar" onClick={(e) => {
                  if (!status?.duration) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pct = (e.clientX - rect.left) / rect.width
                  const target = pct * status.duration
                  sendControl('seek', target - status.current_time)
                }}>
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="time-row">
                  <span>{formatTime(status?.current_time || 0)}</span>
                  <span>{formatTime(status?.duration || 0)}</span>
                </div>

                <div className="controls">
                  <button className="ctrl-btn"
                    onPointerDown={() => startSeek(-1)}
                    onPointerUp={stopSeek}
                    onPointerLeave={stopSeek}
                    onContextMenu={e => e.preventDefault()}
                  >⏪ 30s</button>
                  <button className="ctrl-btn ctrl-play" onClick={() => sendControl(isPlaying ? 'pause' : 'play')}>
                    {isPlaying ? '⏸' : '▶️'}
                  </button>
                  <button className="ctrl-btn"
                    onPointerDown={() => startSeek(1)}
                    onPointerUp={stopSeek}
                    onPointerLeave={stopSeek}
                    onContextMenu={e => e.preventDefault()}
                  >30s ⏩</button>
                  <button className="ctrl-btn ctrl-stop" onClick={() => {
                    sendControl('stop')
                    setStatus(null)
                    stopPolling()
                  }}>⏹</button>
                </div>

                <div className="volume-row">
                  <button className="vol-btn vol-action"
                    onPointerDown={() => { sendControl('volume_down'); startVolRepeat('volume_down'); }}
                    onPointerUp={stopVolRepeat}
                    onPointerLeave={stopVolRepeat}
                    onContextMenu={e => e.preventDefault()}
                  >🔉 Vol−</button>
                  <button className="vol-btn vol-action"
                    onPointerDown={() => { sendControl('volume_up'); startVolRepeat('volume_up'); }}
                    onPointerUp={stopVolRepeat}
                    onPointerLeave={stopVolRepeat}
                    onContextMenu={e => e.preventDefault()}
                  >🔊 Vol+</button>
                  <button
                    className="vol-btn vol-action"
                    onClick={() => sendControl('mute')}
                  >🔇 Mute</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Episodes */}
        {extractResult && extractResult.episodes.length > 1 && (
          <div className="card">
            <div className="card-label">Episodes</div>
            <div className="episode-list">
              {extractResult.episodes.map(ep => (
                <button
                  key={ep.index}
                  className="episode-btn"
                  onClick={() => {
                    const m = url.match(/\/player\/vod\/(\d+)-(\d+)-\d+\.html/)
                    if (m) {
                      const epUrl = `https://www.olevod.com/player/vod/${m[1]}-${m[2]}-${ep.index}.html`
                      setUrl(epUrl)
                    }
                  }}
                >
                  {ep.title || `Ep ${ep.index}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* TV Remote — always show */}
        <div className="card">
          <div className="card-label">TV Remote</div>
            <div className="remote-pad">
              <div className="remote-row">
                <div className="remote-spacer" />
                <button className="remote-btn" onClick={() => sendKey('DPAD_UP')}>▲</button>
                <div className="remote-spacer" />
              </div>
              <div className="remote-row">
                <button className="remote-btn" onClick={() => sendKey('DPAD_LEFT')}>◀</button>
                <button className="remote-btn remote-ok" onClick={() => sendKey('DPAD_CENTER')}>OK</button>
                <button className="remote-btn" onClick={() => sendKey('DPAD_RIGHT')}>▶</button>
              </div>
              <div className="remote-row">
                <div className="remote-spacer" />
                <button className="remote-btn" onClick={() => sendKey('DPAD_DOWN')}>▼</button>
                <div className="remote-spacer" />
              </div>
            </div>
            <div className="remote-actions">
              <button className="remote-action-btn" onClick={() => sendKey('HOME')}>🏠 Home</button>
              <button className="remote-action-btn" onClick={() => sendKey('BACK')}>← Back</button>
              <button className="remote-action-btn" onClick={() => sendKey('MENU')}>☰ Menu</button>
            </div>
            <div className="remote-volume">
              <button className="remote-vol-btn"
                onPointerDown={() => { sendControl('volume_down'); startVolRepeat('volume_down'); }}
                onPointerUp={stopVolRepeat}
                onPointerLeave={stopVolRepeat}
                onContextMenu={e => e.preventDefault()}
              >🔉 Vol−</button>
              <button className="remote-vol-btn"
                onClick={() => sendControl('mute')}
              >🔇 Mute</button>
              <button className="remote-vol-btn"
                onPointerDown={() => { sendControl('volume_up'); startVolRepeat('volume_up'); }}
                onPointerUp={stopVolRepeat}
                onPointerLeave={stopVolRepeat}
                onContextMenu={e => e.preventDefault()}
              >🔊 Vol+</button>
            </div>
          </div>
      </div>
    </div>
  )
}
