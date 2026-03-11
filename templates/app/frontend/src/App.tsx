import { useEffect, useState } from 'react'
import { AppShell } from '../../../../shared/ui/AppShell'

const API = import.meta.env.VITE_API_BASE || '/api/app/my-app'

export default function App() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetch(`${API}/hello`)
      .then(r => r.json())
      .then(d => setMessage(d.message))
      .catch(() => setMessage('Failed to connect'))
  }, [])

  return (
    <AppShell title="🚀 My App">
      <div style={{ padding: 16 }}>
        <p style={{ fontSize: 18 }}>{message || 'Loading...'}</p>
      </div>
    </AppShell>
  )
}
