/**
 * The command menu survives keystrokes that carry no `key`.
 *
 * The bug: the global keydown listener called `event.key.toLowerCase()`
 * unguarded. `key` is typed as `string` but is genuinely absent on events the
 * browser routes through here — autofill, and synthetic events dispatched by
 * password managers and extensions. Because the listener is on `window`, the
 * TypeError escaped to the React error boundary and took the whole app down on
 * a stray keystroke, rather than failing quietly inside one widget.
 *
 * The same handler now also stands aside during IME composition, where every
 * keydown reports `keyCode` 229 and the Enter that commits a candidate would
 * otherwise be read as "open the highlighted search result".
 *
 * Both halves are asserted: the app must survive the events that used to crash
 * it, *and* ⌘K, "/" and the arrow keys must still work — a guard that returned
 * early on everything would pass the first half and break the feature.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-command-menu.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
}

/**
 * Is the command menu open?
 *
 * Keyed on the dialog itself, not on "some search box is visible" — several
 * pages carry their own filter input, and matching those made a closed menu
 * look open.
 */
const menuOpen = (page: Page) =>
  page.locator('[role="dialog"][aria-label="Global search"]').isVisible()

async function main() {
  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()

  // Every uncaught client error, including the one this fixes. Next's dev
  // overlay swallows nothing here — `pageerror` fires before React sees it.
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'sam@teksolv.com')
    await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' })

    // --- the keystrokes that used to crash it -----------------------------
    console.log('\nKeystrokes with no key\n')

    // Dispatched rather than typed, because a real keyboard cannot produce
    // them — which is exactly why the bug survived manual testing. This is the
    // shape a password manager's synthetic event and an autofill event arrive
    // in: a KeyboardEvent with `key` left undefined.
    //
    // Passed as source rather than as a function, because tsx compiles this
    // file with esbuild's keep-names transform and the injected `__name` helper
    // does not exist in the page.
    const dispatched: string[] = await page.evaluate(`(() => {
      const results = []
      function fire(label, init, keyCodeOverride) {
        try {
          const event = new KeyboardEvent('keydown', Object.assign({ bubbles: true }, init))
          if (keyCodeOverride !== undefined) {
            Object.defineProperty(event, 'keyCode', { get: () => keyCodeOverride })
          }
          window.dispatchEvent(event)
          results.push(label + ': dispatched')
        } catch (error) {
          results.push(label + ': threw ' + error.message)
        }
      }

      // A plain Event dispatched as 'keydown'. This is the one that actually
      // reproduces the crash: 'key' is undefined, not empty. The KeyboardEvent
      // constructor defaults 'key' to '' no matter what you pass it, so a
      // KeyboardEvent can never be the culprit — which is why the first version
      // of this test passed against the unfixed code.
      try {
        window.dispatchEvent(new Event('keydown', { bubbles: true }))
        results.push('plain Event: dispatched')
      } catch (error) {
        results.push('plain Event: threw ' + error.message)
      }

      // A KeyboardEvent with 'key' forced undefined, as an extension shim can
      // leave it after monkey-patching the event.
      try {
        const forced = new KeyboardEvent('keydown', { bubbles: true })
        Object.defineProperty(forced, 'key', { get: () => undefined })
        window.dispatchEvent(forced)
        results.push('forced undefined key: dispatched')
      } catch (error) {
        results.push('forced undefined key: threw ' + error.message)
      }

      // An empty string is not undefined but is equally meaningless.
      fire('empty key', { key: '' })
      // Mid-composition: an IME reports 229 for every key building a candidate.
      fire('IME keydown', { key: 'Process' }, 229)
      fire('IME composing flag', { key: 'a', isComposing: true })
      // And the Enter that commits a candidate, which must not be a shortcut.
      fire('IME commit', { key: 'Enter' }, 229)
      return results
    })()`)

    check(
      'events with no usable key dispatch without throwing',
      dispatched.every((line) => line.endsWith('dispatched')),
      dispatched.join(' · '),
    )
    check(
      'and nothing reached the error boundary',
      errors.length === 0,
      errors.join(' | ') || 'no uncaught client errors',
    )
    check(
      'the app is still on its feet, not showing an error screen',
      await page.getByRole('button', { name: /Search equipment, customers/ }).isVisible(),
      'the topbar search control is still rendered',
    )
    check('and none of them opened the menu', !(await menuOpen(page)))

    // --- the shortcuts still work -----------------------------------------
    console.log('\nThe shortcuts\n')

    await page.keyboard.press('Control+k')
    await page.waitForTimeout(300)
    check('Ctrl-K opens the command menu', await menuOpen(page))

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Escape closes it', !(await menuOpen(page)))

    // "/" only when not already typing in a field — the guard must not have
    // eaten the branch that decides that.
    await page.keyboard.press('/')
    await page.waitForTimeout(300)
    check('"/" opens it from anywhere else on the page', await menuOpen(page))

    // --- and it still searches ---------------------------------------------
    const input = page.locator('input[placeholder*="Scan a tag"]')
    await input.fill('FAM')

    // Waited for, not slept through. The search is debounced and then goes to
    // the server, so a fixed pause is a guess about how busy the machine is —
    // and this one flaked only in a long sweep, where it is busiest.
    let searched = false
    for (let attempt = 0; attempt < 40 && !searched; attempt++) {
      searched = (await page.locator('body').innerText()).includes('FAM')
      if (!searched) await page.waitForTimeout(250)
    }
    const hits = page.locator('[role="option"], a[href^="/inventory/"], button')
    check('typing still searches', searched, `${await hits.count()} candidate row(s) rendered`)

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await page.waitForTimeout(200)
    check('the arrow keys still move without throwing', errors.length === 0)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Escape still closes it after a search', !(await menuOpen(page)))

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }

  console.log(failures === 0 ? '\nAll command-menu checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
