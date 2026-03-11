/**
 * Resolve the API base URL for this app.
 *
 * Uses same-origin relative path by default — works automatically in:
 * - March Deck mode (served at :8800, API at :8800/api/app/{shortcode}/)
 * - standalone mode (served at :880X, API at :880X/api/app/{shortcode}/)
 *
 * The browser resolves relative paths against the current origin,
 * so no configuration needed for different ports.
 *
 * Build-time override: set VITE_API_BASE for custom deployments.
 */
export function getApiBase(shortcode: string): string {
  return import.meta.env.VITE_API_BASE || `/api/app/${shortcode}`
}
