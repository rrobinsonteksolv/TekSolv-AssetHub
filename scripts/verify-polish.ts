/**
 * The demo path, walked and measured.
 *
 * "Nothing clipping or overflowing" is the kind of requirement that is normally
 * checked by scrolling around and squinting, which finds the obvious half. This
 * walks every screen on the path at four widths — two laptops and two phones —
 * and measures four things that each read as unfinished to somebody watching a
 * demo, or standing at a truck:
 *
 *   • **The page scrolls sideways.** Always a bug. One wide table or one
 *     unbreakable string is enough, and it is invisible until the moment a
 *     laptop is plugged into a projector at a narrower aspect.
 *   • **Text is clipped by its own box** — an element whose content is wider
 *     than its scroll container with nothing offering to scroll it.
 *   • **Images with no intrinsic size**, which are the classic cause of the
 *     page jumping as it loads.
 *   • **Console errors**, anywhere on the path.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-polish.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

/**
 * A laptop, a smaller laptop, and two phones.
 *
 * The phone widths are here rather than only in `verify:mobile` because the
 * failures this suite looks for are *width* failures — a clipped box, an
 * unbreakable string, a table that will not fold — and they are far more likely
 * at 390px than at 1440px. Running the same audit across the range is what
 * turns "it looked fine on my screen" into a measurement.
 */
const WIDTHS = [1440, 1280, 430, 390]

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

interface Problem {
  kind: string
  detail: string
}

async function audit(page: Page): Promise<Problem[]> {
  return page.evaluate(() => {
    const problems: { kind: string; detail: string }[] = []

    const doc = document.documentElement
    if (doc.scrollWidth > doc.clientWidth + 1) {
      problems.push({
        kind: 'page-scrolls-sideways',
        detail: `${doc.scrollWidth}px of content in ${doc.clientWidth}px`,
      })
    }

    for (const node of document.querySelectorAll('body *')) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      // Content wider than its box, with nothing offering to scroll it and no
      // ellipsis to admit it. `hidden` plus `text-overflow: ellipsis` is a
      // deliberate truncation; `hidden` alone on overflowing content is a clip.
      const overflowsX = node.scrollWidth > node.clientWidth + 1
      if (overflowsX && style.overflowX === 'hidden' && style.textOverflow !== 'ellipsis') {
        // A transform-scaled child legitimately overflows its clip box — that
        // is how the label preview is built.
        const scaled = [...node.children].some(
          (child) => getComputedStyle(child).transform !== 'none',
        )
        if (!scaled) {
          problems.push({
            kind: 'clipped',
            // Described inline: a *named* inner function here gets esbuild's
            // keepNames wrapper, and `__name` does not exist in the page.
            detail:
              `${node.tagName.toLowerCase()}` +
              `${typeof node.className === 'string' && node.className ? `.${node.className.split(/\s+/)[0]}` : ''}` +
              ` "${(node.textContent ?? '').trim().slice(0, 34)}"` +
              ` — ${node.scrollWidth}px in ${node.clientWidth}px`,
          })
        }
      }
    }

    for (const img of document.querySelectorAll('img')) {
      const hasSize =
        (img.getAttribute('width') && img.getAttribute('height')) ||
        img.style.width !== '' ||
        img.style.aspectRatio !== ''
      if (!hasSize && !img.src.startsWith('data:')) {
        problems.push({ kind: 'image-without-size', detail: img.src.slice(0, 70) })
      }
    }

    return problems
  })
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const asset = await prismaUnscoped.asset.findFirstOrThrow({
    where: { orgId: org.id, inspections: { some: {} } },
    select: { id: true, assetTag: true },
  })
  const truck = await prismaUnscoped.truck.findFirstOrThrow({
    where: { orgId: org.id, number: '167' },
    select: { id: true },
  })

  const routes: [string, string][] = [
    ['Dashboard', '/dashboard'],
    ['Inventory', '/inventory'],
    ['Asset · overview', `/inventory/${asset.id}`],
    ['Asset · inspections', `/inventory/${asset.id}?tab=inspections`],
    ['Asset · maintenance', `/inventory/${asset.id}?tab=maintenance`],
    ['Truck 167', `/trucks/${truck.id}`],
    ['Utilization', '/reports/utilization'],
    ['Idle capital', '/reports/utilization?view=idle&sort=idle'],
    ['Reports', '/reports'],
    ['Rentals', '/rentals'],
    ['Maintenance', '/maintenance'],
  ]

  const browser = await chromium.launch()

  try {
    for (const width of WIDTHS) {
      console.log(`\nAt ${width}px\n`)
      const phone = width < 700
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        colorScheme: 'dark',
        // Touch emulation changes hit-testing and, on some layouts, which
        // media queries apply — auditing a phone width with a mouse profile
        // would measure a screen nobody has.
        isMobile: phone,
        hasTouch: phone,
      })
      const page = await context.newPage()
      await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))

      await signIn(page, 'ray@teksolv.com')

      for (const [name, href] of routes) {
        await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(320)
        const problems = await audit(page)
        check(
          name,
          problems.length === 0,
          problems.length
            ? problems.map((problem) => `${problem.kind}: ${problem.detail}`).join('\n        ')
            : '',
        )
      }

      check(`no console errors at ${width}px`, errors.length === 0, errors.join(' | '))
      await context.close()
    }

    // -----------------------------------------------------------------------
    console.log('\nMotion is opt-out\n')
    // -----------------------------------------------------------------------

    const reduced = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    })
    const page = await reduced.newPage()
    await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
    await signIn(page, 'ray@teksolv.com')
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })

    const durations = await page.evaluate(() => {
      const out: string[] = []
      for (const node of document.querySelectorAll('body *')) {
        const style = getComputedStyle(node)
        const ms = style.transitionDuration
          .split(',')
          .map((value) => parseFloat(value) * (value.includes('ms') ? 1 : 1000))
        // Effectively instant, not literally zero. A duration of exactly 0 can
        // stop `transitionend` from firing at all, which silently breaks any
        // JavaScript waiting on it — so the standard reduced-motion value is a
        // hundredth of a millisecond, and anything at or under 1ms passes.
        if (ms.some((value) => value > 1)) {
          out.push(`${node.tagName.toLowerCase()} ${style.transitionDuration}`)
        }
      }
      return out.slice(0, 5)
    })
    check(
      'transitions are switched off for prefers-reduced-motion',
      durations.length === 0,
      durations.length ? durations.join(', ') : 'nothing animates when the OS asks it not to',
    )
    await reduced.close()
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll polish checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
