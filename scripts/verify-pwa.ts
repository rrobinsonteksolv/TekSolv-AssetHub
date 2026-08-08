/**
 * The installable shell, and what happens when the signal goes.
 *
 * Three things have to be true for a phone to offer "Add to Home Screen", and
 * all three are easy to half-do:
 *
 *   • a **manifest** with a name, a start URL, `display: standalone` and icons
 *     at 192 and 512 — a missing size is the usual reason a browser silently
 *     declines to offer the install;
 *   • a **service worker** that actually registers and controls the page;
 *   • the **viewport meta**, without which the install produces a full-screen
 *     app rendered at a 980px virtual width, which is worse than the tab.
 *
 * The offline half is checked by actually cutting the connection with CDP
 * rather than by faking `navigator.onLine` — a banner driven by a property the
 * test sets is a banner that tests itself. What matters is the *pair*: reads
 * still work from cache, and writes are refused loudly rather than hanging.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-pwa.ts
 */
import 'dotenv/config'
import { existsSync, statSync } from 'node:fs'
import { chromium, type Page } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'ray@teksolv.com')
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'allow',
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -------------------------------------------------------------------------
    console.log('\nIt can be installed\n')
    // -------------------------------------------------------------------------

    const manifestResponse = await page.request.get(`${BASE}/manifest.webmanifest`)
    check(
      'the manifest is served, and without a login redirect',
      manifestResponse.ok(),
      // Behind the auth matcher it answers with the sign-in page, and the
      // browser reads that as a manifest it cannot parse.
      `HTTP ${manifestResponse.status()}`,
    )

    const manifest = (await manifestResponse.json()) as {
      name?: string
      short_name?: string
      start_url?: string
      display?: string
      theme_color?: string
      icons?: { sizes?: string; purpose?: string }[]
      shortcuts?: { url?: string }[]
    }

    check('it names the app', manifest.name === 'AssetHub — TekSolv', String(manifest.name))
    check(
      'launches full-screen rather than in a tab',
      manifest.display === 'standalone',
      `display: ${manifest.display}`,
    )
    check(
      'starts on the dashboard, not on a redirect',
      manifest.start_url === '/dashboard',
      `start_url: ${manifest.start_url}`,
    )
    check(
      'and carries the TekSolv maroon',
      manifest.theme_color === '#79232e',
      `theme_color: ${manifest.theme_color}`,
    )

    const sizes = (manifest.icons ?? []).map((icon) => icon.sizes)
    check(
      'with both icon sizes a launcher asks for',
      sizes.includes('192x192') && sizes.includes('512x512'),
      sizes.join(', ') || 'none',
    )
    check(
      'including a maskable one, so Android does not crop the art off',
      (manifest.icons ?? []).some((icon) => icon.purpose === 'maskable'),
      'the mark is drawn inside the middle 80% for exactly this reason',
    )

    for (const file of [
      'public/icons/icon-192.png',
      'public/icons/icon-512.png',
      'public/icons/apple-touch-icon.png',
    ]) {
      check(
        `${file} exists and is a real image`,
        existsSync(file) && statSync(file).size > 500,
        existsSync(file) ? `${Math.round(statSync(file).size / 100) / 10}kB` : 'missing',
      )
    }

    check(
      'long-pressing the icon offers Scan and Grab',
      (manifest.shortcuts ?? []).some((entry) => entry.url === '/scan') &&
        (manifest.shortcuts ?? []).some((entry) => entry.url === '/grab'),
      (manifest.shortcuts ?? []).map((entry) => entry.url).join(', '),
    )

    // -------------------------------------------------------------------------
    console.log('\nThe page is set up for a phone, not scaled down to one\n')
    // -------------------------------------------------------------------------

    await signIn(page)
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })

    const viewportMeta = await page.getAttribute('meta[name="viewport"]', 'content')
    check(
      'the viewport meta is present',
      !!viewportMeta && viewportMeta.includes('width=device-width'),
      viewportMeta ?? 'ABSENT — a phone renders at ~980px and scales the result down',
    )
    check(
      'and it covers the notch rather than letterboxing around it',
      !!viewportMeta && viewportMeta.includes('viewport-fit=cover'),
      viewportMeta ?? '',
    )
    check(
      'the manifest is linked from the document',
      (await page.locator('link[rel="manifest"]').count()) > 0,
    )
    check(
      'and an apple-touch-icon is too, for the iOS home screen',
      (await page.locator('link[rel="apple-touch-icon"]').count()) > 0,
    )

    // -------------------------------------------------------------------------
    console.log('\nThe service worker takes control\n')
    // -------------------------------------------------------------------------

    const swResponse = await page.request.get(`${BASE}/sw.js`)
    const swBody = await swResponse.text()
    check(
      'sw.js is served as a script, not as the login page',
      swResponse.ok() && swBody.includes('addEventListener'),
      `HTTP ${swResponse.status()} · ${swBody.slice(0, 40).replace(/\n/g, ' ')}`,
    )
    check(
      'and it refuses to touch anything that is not a GET',
      swBody.includes("request.method !== 'GET'"),
      'a queued write is Phase 3 work — accepting one here would lose it',
    )
    check(
      'or anything under /api/',
      swBody.includes("url.pathname.startsWith('/api/')"),
      'a cached scan resolution would send somebody to the wrong truck',
    )

    const controlled = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'no support'
      const registration = await navigator.serviceWorker.ready
      return registration.active ? 'active' : 'registered but not active'
    })
    check('it registers and becomes active', controlled === 'active', controlled)

    // -------------------------------------------------------------------------
    console.log('\nOffline says so, and refuses to pretend\n')
    // -------------------------------------------------------------------------

    // A page the worker has definitely seen, so the cached read is a real test.
    await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)

    await context.setOffline(true)
    // The banner confirms reachability with a real request rather than trusting
    // `navigator.onLine`, so it needs one poll to notice.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))

    const banner = page.locator('#offline-banner')
    await banner.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)
    check(
      'a banner appears when the connection drops',
      await banner.isVisible(),
      (await banner.textContent())?.trim() ?? 'no banner',
    )
    check(
      'and it says what you can still do',
      ((await banner.textContent()) ?? '').toLowerCase().includes('reconnect'),
      'silent failure is the thing this replaces',
    )

    // Writes are blocked while offline — the point of the banner.
    //
    // Probed on the page that was already open when the signal dropped, which
    // is the real scenario: somebody is standing at a truck with a form
    // half-filled. (Probing after an offline *navigation* would test nothing in
    // development, where the worker deliberately caches no chunks, so the
    // fallback page arrives unhydrated.)
    const submitProbe = () =>
      page.evaluate(() => {
        const form = document.createElement('form')
        form.action = '/nowhere'
        document.body.append(form)
        let reached = false
        form.addEventListener('submit', (event) => {
          reached = true
          // Never actually navigate — this is a probe, not a write.
          event.preventDefault()
        })
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
        form.remove()
        return reached
      })

    check(
      'a form submitted while offline is stopped, not left hanging',
      !(await submitProbe()),
      'a hang at a truck reads as "it went through"',
    )

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await banner.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined)
    check(
      'and it clears once the signal is back',
      !(await banner.isVisible()),
      'a banner that will not go away is the next bug report',
    )

    // The control. Without this the block above passes for a form that was
    // never going to submit anyway, and the check proves nothing.
    check(
      'while the same submit goes through once back online',
      await submitProbe(),
      'the block is conditional on being offline, not permanent',
    )

    // -------------------------------------------------------------------------
    console.log('\nAnd a page nobody cached still renders something\n')
    // -------------------------------------------------------------------------

    await context.setOffline(true)
    await page
      .goto(`${BASE}/reports/utilization`, { waitUntil: 'domcontentloaded' })
      .catch(() => undefined)
    const servedBody = (await page.textContent('body').catch(() => '')) ?? ''
    check(
      'navigating offline lands on our offline page, not the browser error',
      servedBody.includes('You are offline'),
      servedBody.slice(0, 80).replace(/\s+/g, ' ') || 'nothing rendered',
    )
    check(
      'which says why, rather than showing a blank screen',
      servedBody.includes('reconnect') || servedBody.includes('connection'),
      'a blank screen is indistinguishable from a crash',
    )
    await context.setOffline(false)

    check('no uncaught client errors', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\nAll PWA checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
