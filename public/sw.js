/* eslint-disable no-restricted-globals */
/**
 * AssetHub service worker — the app shell, and an honest offline state.
 *
 * Scope, stated plainly, because a service worker that quietly does more than
 * you think is how data goes missing:
 *
 *   • **Reads may be served stale.** A navigation is tried on the network
 *     first and falls back to the last copy in the cache, so a flaky yard
 *     connection shows the page you had rather than a blank screen.
 *   • **Writes are never touched.** Anything that is not a GET goes straight
 *     to the network. A queued check-in is Phase 3 work and needs conflict
 *     handling against the custody and rental invariants; pretending to accept
 *     one here would be worse than refusing it, because the operator would walk
 *     away believing the unit was booked out.
 *   • **Nothing under `/api/` is cached.** Those answers are about where gear
 *     *is right now* — a cached scan resolution would send somebody to the
 *     wrong truck.
 *
 * In development it caches nothing at all. Next's dev chunks are not
 * content-hashed, and a service worker holding yesterday's chunk is a
 * debugging session nobody enjoys; the offline fallback still works, which is
 * the part worth exercising locally.
 */

const VERSION = 'v1'
const SHELL = `assethub-shell-${VERSION}`
const PAGES = `assethub-pages-${VERSION}`

const MODE = new URL(self.location.href).searchParams.get('mode') ?? 'production'
const DEV = MODE === 'development'

/** The offline page, and the icons it and the launcher need. */
const PRECACHE = ['/offline', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // `reload` so an install never re-precaches from the HTTP cache and
      // pins a stale shell for the life of the version.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('assethub-') && key !== SHELL && key !== PAGES)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

function cacheable(request) {
  if (request.method !== 'GET') return false
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return false
  // Auth and API answers are about *now*; a stale one is a wrong one.
  if (url.pathname.startsWith('/api/')) return false
  return true
}

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Writes go to the network, untouched, always.
  if (!cacheable(request)) return

  const url = new URL(request.url)

  // ---- navigations: network first, last-known copy second, offline page last
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!DEV && response.ok) {
            const copy = response.clone()
            caches.open(PAGES).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request, { ignoreSearch: true })
          if (cached) return cached
          const offline = await caches.match('/offline')
          return (
            offline ??
            new Response('<h1>Offline</h1>', {
              status: 503,
              headers: { 'Content-Type': 'text/html' },
            })
          )
        }),
    )
    return
  }

  // ---- static assets: cache first, because they are content-hashed
  const isStatic =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/brand/')

  if (!isStatic || DEV) return

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(SHELL).then((cache) => cache.put(request, copy))
          }
          return response
        }),
    ),
  )
})
