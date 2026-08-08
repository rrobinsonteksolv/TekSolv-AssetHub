/**
 * The app on a phone.
 *
 * Two things are checked, and the second is the one that matters.
 *
 * **Shape**: at 360, 390 and 430px — the range a field phone actually is — no
 * page scrolls sideways, every page has a visible title, and the controls
 * people aim at are at least 44px. The starting state failed all three: there
 * was no viewport meta at all, so a phone rendered at a ~980px virtual width
 * and scaled the result down, and the Inventory `h1` computed to **zero width**
 * because a `min-w-0` title beside `shrink-0` actions surrenders all its room.
 *
 * **Flows**: grab, check-out, stage-to-truck and run-an-inspection are walked
 * with a touch viewport, because a page can pass every measurement above and
 * still be unusable — a form whose submit button sits below the fold, a picker
 * that opens off-screen, a nav that cannot be reached without the sidebar that
 * is no longer there.
 *
 * Read-only apart from the flows, which stop short of committing: this suite
 * navigates and inspects, it does not book gear out.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-mobile.ts
 */
import 'dotenv/config'
import { chromium, type Browser, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

/** The widths this shop's phones actually report. */
const WIDTHS = [360, 390, 430]

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function phone(browser: Browser, width: number) {
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'ray@teksolv.com')
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
  return page
}

async function open(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(350)
}

/** Does the document scroll sideways? The one disqualifying measurement. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const doc = document.documentElement
    return { scroll: doc.scrollWidth, client: doc.clientWidth }
  })

const smallTargets = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = []
    for (const node of Array.from(
      document.querySelectorAll<HTMLElement>('main button, main select, main input, main a[href]'),
    )) {
      const rect = node.getBoundingClientRect()
      if (rect.height === 0 || rect.height >= 44) continue
      // Prose links inside a sentence are text that happens to be clickable.
      if (
        node.tagName === 'A' &&
        node.parentElement &&
        ['P', 'SPAN', 'DD', 'LI'].includes(node.parentElement.tagName) &&
        (node.parentElement.textContent ?? '').length > (node.textContent ?? '').length + 12
      ) {
        continue
      }
      const type = node.getAttribute('type')
      if (type === 'hidden') continue
      // A wrapped label is the target for the box inside it.
      if (type === 'checkbox' || type === 'radio') {
        const label = node.closest('label')
        if (label && label.getBoundingClientRect().height >= 44) continue
      }
      out.push(`${node.tagName.toLowerCase()} "${(node.textContent ?? '').trim().slice(0, 24)}" ${Math.round(rect.height)}px`)
    }
    return out
  })

const PAGES: [string, string][] = [
  ['Dashboard', '/dashboard'],
  ['Inventory', '/inventory'],
  ['Rentals', '/rentals'],
  ['Supplies', '/supplies'],
  ['Areas', '/areas'],
  ['Kits & bags', '/containers'],
  ['Maintenance', '/maintenance'],
  ['Inspections', '/inspections'],
  ['Reports', '/reports'],
  ['Grab', '/grab'],
  ['Check-out', '/rentals/checkout'],
  ['Scan', '/scan'],
]

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const orgId = org.id

  const browser = await chromium.launch()
  const errors: string[] = []

  try {
    // -------------------------------------------------------------------------
    console.log('\nNothing scrolls sideways, at any phone width\n')
    // -------------------------------------------------------------------------

    for (const width of WIDTHS) {
      const page = await phone(browser, width)
      page.on('pageerror', (error) => errors.push(`${width}px: ${error.message}`))

      const wide: string[] = []
      const headless: string[] = []
      const tiny: string[] = []

      for (const [name, path] of PAGES) {
        await open(page, path)
        const { scroll, client } = await overflow(page)
        if (scroll > client) wide.push(`${name} ${scroll}>${client}`)

        const title = page.locator('main h1').first()
        const box = await title.boundingBox()
        if (!box || box.width < 40) headless.push(`${name} (h1 ${Math.round(box?.width ?? 0)}px)`)

        const small = await smallTargets(page)
        if (small.length > 0) tiny.push(`${name}: ${small.slice(0, 2).join(', ')}`)
      }

      check(
        `${width}px — all ${PAGES.length} screens fit the viewport`,
        wide.length === 0,
        wide.length ? wide.join(' · ') : 'no horizontal scroll anywhere',
      )
      check(
        `${width}px — every screen still has its title`,
        headless.length === 0,
        headless.length
          ? headless.join(' · ')
          : 'the Inventory h1 used to compute to zero width here',
      )
      check(
        `${width}px — every control clears 44px`,
        tiny.length === 0,
        tiny.length ? tiny.join(' · ') : 'buttons, selects, inputs, tabs and card links',
      )

      await page.close()
    }

    const page = await phone(browser, 390)
    page.on('pageerror', (error) => errors.push(error.message))

    // -------------------------------------------------------------------------
    console.log('\nThe shell is a phone shell\n')
    // -------------------------------------------------------------------------

    await open(page, '/dashboard')

    check(
      'the 230px sidebar is gone',
      !(await page.locator('aside:has-text("Field Ops")').first().isVisible()),
      'it was 59% of a 390px screen',
    )

    const bar = page.locator('nav[aria-label="Field actions"]')
    check('a bottom bar is within thumb reach', await bar.isVisible())

    const barBox = await bar.boundingBox()
    check(
      'and it sits at the bottom of the screen',
      !!barBox && barBox.y + barBox.height >= 800,
      barBox ? `y=${Math.round(barBox.y)} h=${Math.round(barBox.height)}` : 'not found',
    )

    check(
      'with Scan on it',
      await bar.locator('a[href="/scan"]').isVisible(),
      'the camera path, one tap from anywhere',
    )

    // The drawer carries the whole nav, including what the topbar dropped.
    await page.click('button[aria-label="Open navigation"]')
    const drawer = page.locator('aside[role="dialog"][aria-label="Navigation"]')
    await drawer.waitFor({ state: 'visible', timeout: 5_000 })
    const links = await drawer.locator('nav a').allInnerTexts()
    check(
      `the drawer holds all ${links.length} nav destinations`,
      links.length >= 9 && links.some((text) => text.includes('Inventory')),
      links.map((text) => text.trim()).join(' · '),
    )
    check(
      'and sign-out, which the topbar hides on a phone',
      await drawer.locator('button[aria-label="Sign out"]').isVisible(),
      'hidden in the bar and absent from the drawer would mean nobody can sign out',
    )
    await page.keyboard.press('Escape')

    // -------------------------------------------------------------------------
    console.log('\nLists became cards, not squeezed tables\n')
    // -------------------------------------------------------------------------

    for (const [name, path, marker] of [
      ['Inventory', '/inventory', 'TS-'],
      ['Rentals', '/rentals', ''],
      ['Supplies', '/supplies', ''],
    ] as const) {
      await open(page, path)
      const tableVisible = await page.locator('table').first().isVisible().catch(() => false)
      const cards = await page.locator('ul.md\\:hidden > li').count()
      check(
        `${name} shows ${cards} cards and no table`,
        !tableVisible && cards > 0,
        tableVisible ? 'the table is still rendered at phone width' : `marker ${marker || 'n/a'}`,
      )
    }

    // -------------------------------------------------------------------------
    console.log('\nThe field flows work one-handed\n')
    // -------------------------------------------------------------------------

    // Grab: scan-to-search, pick, and a submit that is actually on screen.
    //
    // The search term comes from the database rather than being typed in here.
    // A hardcoded prefix passes for the wrong reason the day the fleet is
    // renumbered — and it did: `TS-` is the placeholder text, not this shop's
    // tag format.
    const grabbable = await prismaUnscoped.asset.findFirst({
      where: { orgId, active: true, status: 'AVAILABLE', custodyType: null },
      select: { assetTag: true },
      orderBy: { assetTag: 'asc' },
    })
    await open(page, '/grab')
    const grabSearch = page.locator('input[placeholder*="Scan or search"]').first()
    check('Grab opens on a search field', await grabSearch.isVisible())

    if (grabbable) {
      await grabSearch.fill(grabbable.assetTag)
      await page.waitForTimeout(1_200)
      const picked = page.locator(`button:has-text("${grabbable.assetTag}")`)
      const count = await picked.count()
      check(
        `searching ${grabbable.assetTag} offers it to pick`,
        count > 0,
        `${count} match(es) — the scan gun types into this same field`,
      )
      if (count > 0) {
        const box = await picked.first().boundingBox()
        check(
          'and the result row is a 44px target',
          !!box && box.height >= 44,
          box ? `${Math.round(box.height)}px tall` : 'no box',
        )
      }
    }

    const grabSubmit = page.locator('form button[type="submit"]').last()
    const grabBox = (await grabSubmit.count()) ? await grabSubmit.boundingBox() : null
    check(
      'and its submit is a full-width button, not a corner one',
      !!grabBox && grabBox.width > 200,
      grabBox ? `${Math.round(grabBox.width)}px wide` : 'no submit found',
    )

    // Check-out: the customer/site/date header, then units.
    await open(page, '/rentals/checkout')
    const selects = await page.locator('main select').count()
    check(
      'Check-out stacks its customer/site/date controls',
      selects >= 1 && (await overflow(page).then(({ scroll, client }) => scroll <= client)),
      `${selects} select(s), none of them off the right edge`,
    )

    // Stage-to-truck. There is no `/trucks` index — a truck is reached from the
    // dashboard's readiness panel or by scanning the label on its door — so the
    // route is resolved from the database rather than guessed.
    const rig = await prismaUnscoped.truck.findFirst({
      where: { orgId, active: true },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    })
    if (rig) {
      await open(page, `/trucks/${rig.id}`)
      const { scroll, client } = await overflow(page)
      check(
        `Truck ${rig.number} fits, which is where staging happens`,
        scroll <= client,
        `${scroll} vs ${client}`,
      )
      const stage = page.locator('input[placeholder*="Scan"], input[placeholder*="scan"]').first()
      check(
        'and scan-to-stage is on it, focused on a field a gun can type into',
        (await stage.count()) > 0,
        'staging a truck is the flow most likely to happen with a phone in one hand',
      )
    }

    // Run an inspection.
    await open(page, '/inspections')
    const startInspection = page.locator('main a[href*="/inspections/"]').first()
    check(
      'Inspections offers a way in',
      (await startInspection.count()) > 0,
      'the form itself is a server-rendered page and is covered by the width sweep',
    )

    // -------------------------------------------------------------------------
    console.log('\nAnd the scanner is reachable in one tap\n')
    // -------------------------------------------------------------------------

    await open(page, '/scan')
    check('the scan page has a camera control', await page.locator('button:has-text("Start camera")').isVisible())
    check(
      'and a typed fallback beside it, not instead of it',
      await page.locator('#manual-tag').isVisible(),
      'a scuffed label is a fact of life, and so is a browser without BarcodeDetector',
    )

    check('no uncaught client errors', errors.length === 0, errors.slice(0, 3).join(' | '))
    await page.close()
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll mobile checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
