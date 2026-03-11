/* March Deck Service Worker — handles push notifications and offline shell */

const CACHE_NAME = 'marchdeck-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim())
})

/* Push notification handler */
self.addEventListener('push', event => {
  if (!event.data) return

  let data
  try {
    data = event.data.json()
  } catch {
    data = { title: 'Notification', body: event.data.text() }
  }

  const options = {
    body: data.body ?? '',
    icon: data.icon ?? '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag ?? 'default',
    data: { url: data.url ?? '/' },
    vibrate: [200, 100, 200],
    requireInteraction: true,
  }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'March Deck', options)
  )
})

/* Notification click → focus/open the app */
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const urlPath = event.notification.data?.url ?? '/'
  const targetUrl = new URL(urlPath, self.location.origin).href

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Try to focus an existing PWA window and navigate it
        for (const client of windowClients) {
          if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
            // For sub-app URLs (/app/*), do a full navigation via the client
            return client.focus().then(c => {
              c.navigate(targetUrl)
              return c
            })
          }
        }
        // No existing window — open. On iOS PWA this may open Safari,
        // so use the root URL and let the user navigate from there.
        return clients.openWindow(targetUrl).catch(() => clients.openWindow('/'))
      })
  )
})
