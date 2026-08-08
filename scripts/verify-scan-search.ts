/**
 * Scan-to-search: a keyboard-wedge scanner works from anywhere in the app.
 *
 * The scanner on this floor types the contents of a code and presses Enter.
 * There is no device, no event, and nothing in the keystrokes to say a machine
 * sent them — so this suite checks the two halves that make it work anyway:
 *
 *   1. **Detection.** A burst is recognised by *cadence*. The interesting
 *      assertion is not that a fast burst fires, it is that ordinary typing
 *      never does — a false positive here hijacks the Enter key across the
 *      whole app, which is a much worse bug than a scan that does nothing.
 *   2. **Routing.** One scanned string has four possible meanings now, and the
 *      shape of the URL is what tells them apart. Each family is scanned for
 *      real, with the search box *not focused*, and the destination checked.
 *
 * Routing is asserted against the server resolver as well as through the
 * browser, because the rule that matters — that a scan is answered from the
 * caller's own organization — is not visible from a URL bar.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-scan-search.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { classifyScan } from '../src/lib/scan'
import {
  burstInFlight,
  burstIsScan,
  burstText,
  emptyBurst,
  pushKey,
  type BurstState,
} from '../src/lib/scan-burst'
import { newPublicToken } from '../src/lib/public-report'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

/** Marks everything this run creates, so cleanup never depends on a variable. */
const MARK = 'scan-search verification fixture'

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
 * Type like the wedge does: characters a few milliseconds apart, terminated by
 * an Enter in the same rhythm. `type` sends a real keydown per character
 * through CDP, so the timestamps the listener sees are the browser's own.
 */
async function scan(page: Page, text: string) {
  await page.keyboard.type(`${text}\n`, { delay: 8 })
}

/** Type like a person: the same characters, at a human pace. */
async function typeByHand(page: Page, text: string) {
  await page.keyboard.type(`${text}\n`, { delay: 160 })
}

/** Make sure nothing has focus, so the burst reaches the window listener. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

/** Replay a cadence through the pure detector, the way the listener folds it. */
function detect(text: string, gapMs: number): { scan: boolean; text: string } {
  let state: BurstState = emptyBurst()
  let clock = 1_000
  for (const char of text) {
    state = pushKey(state, char, clock)
    clock += gapMs
  }
  return { scan: burstIsScan(state, clock), text: burstText(state) }
}

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow()

  // Ordered, so every run picks the same unit. An unordered findFirst let
  // Postgres choose, and it once handed back a unit whose serial was four
  // characters long — making the "partial serial" below the *whole* serial,
  // which then resolved straight to the unit and looked like a routing bug.
  const asset = await prismaUnscoped.asset.findFirstOrThrow({
    where: { orgId: org.id, serialNumber: { not: null } },
    orderBy: { assetTag: 'asc' },
    select: { id: true, assetTag: true, serialNumber: true },
  })
  const truck = await prismaUnscoped.truck.findFirstOrThrow({
    where: { orgId: org.id },
    select: { id: true, number: true },
  })
  const tech = await prismaUnscoped.user.findFirstOrThrow({
    where: { memberships: { some: { orgId: org.id } } },
    select: { id: true },
  })

  // A calibration with a public token, created here rather than borrowed from
  // the seed: the sticker's whole point is the token, and mutating a seeded
  // record to get one is how fixtures drift.
  const token = newPublicToken()
  const record = await prismaUnscoped.maintenanceRecord.create({
    data: {
      orgId: org.id,
      assetId: asset.id,
      type: 'CALIBRATION',
      performedById: tech.id,
      workDone: MARK,
      publicToken: token,
      calibration: {
        time: '09:15',
        temperatureF: 71,
        remarks: MARK,
        gases: [],
        customer: null,
        orderNumber: null,
        location: null,
        dueAt: '2027-02-02',
      },
    },
    select: { id: true },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nA scanned string knows what it is\n')
    // -----------------------------------------------------------------------

    const cal = classifyScan(`${BASE}/c/${token}`)
    check('a cal sticker reads as a calibration report', cal.kind === 'calibration', cal.kind)
    check('and yields the token, not the whole URL', cal.value === token, cal.value)

    const truckScan = classifyScan(`${BASE}/api/scan/truck/${truck.id}`)
    check('a truck label reads as a truck', truckScan.kind === 'truck', truckScan.kind)
    check(
      'and is not mistaken for an asset tagged "truck"',
      truckScan.value === truck.id,
      truckScan.value,
    )

    const assetScan = classifyScan(`${BASE}/api/scan/${asset.assetTag}`)
    check('a unit label reads as an asset', assetScan.kind === 'asset', assetScan.kind)
    check('and yields the tag', assetScan.value === asset.assetTag, assetScan.value)

    const bare = classifyScan(`  ${asset.serialNumber}  `)
    check(
      'a bare serial from a 1D gun is plain text, trimmed',
      bare.kind === 'plain' && bare.value === asset.serialNumber,
      `${bare.kind} "${bare.value}"`,
    )

    const foreign = classifyScan('https://example.com/product/9912')
    check(
      "somebody else's QR is searched, not followed",
      foreign.kind === 'plain',
      'a manufacturer sticker must not navigate an operator onto the open web',
    )

    const mangled = classifyScan(`${BASE}/c/short`)
    check(
      'a token-shaped URL that is not token-shaped enough falls through',
      mangled.kind === 'plain',
      'a mangled scan costs a regex, not a query',
    )

    // -----------------------------------------------------------------------
    console.log('\nA scanner is told from a person by cadence alone\n')
    // -----------------------------------------------------------------------

    const wedge = detect(`${BASE}/api/scan/${asset.assetTag}`, 9)
    check('9 ms between characters is a scan', wedge.scan)
    check('and the whole payload survives', wedge.text === `${BASE}/api/scan/${asset.assetTag}`)

    check(
      '160 ms — brisk human typing — is not',
      !detect(`${BASE}/api/scan/${asset.assetTag}`, 160).scan,
      'the Enter key must keep meaning what it means everywhere else',
    )
    check('nor is 60 ms, just over the line', !detect('FAM001001', 60).scan)
    check('40 ms, just under, is', detect('FAM001001', 40).scan)

    check(
      'three fast characters and Enter is not a scan',
      !detect('abc', 8).scan,
      'somebody hitting a few keys in a hurry is not holding a gun',
    )

    // A pause mid-burst starts a new one at the character that broke it, rather
    // than discarding it — otherwise every scan loses its first character.
    let paused = emptyBurst()
    paused = pushKey(paused, 'x', 0)
    paused = pushKey(paused, 'F', 900)
    for (const [index, char] of [...'AM001001'].entries()) {
      paused = pushKey(paused, char, 910 + index * 8)
    }
    check(
      'a scan that follows a pause keeps its first character',
      burstText(paused) === 'FAM001001',
      burstText(paused),
    )

    // The reason the listener intercepts at all: our labels are URLs, and "/"
    // is the shortcut that opens the palette.
    let url = emptyBurst()
    let clock = 0
    let interceptedBySlash = false
    for (const char of 'https://x') {
      url = pushKey(url, char, clock)
      if (char === '/' && !interceptedBySlash) interceptedBySlash = burstInFlight(url, clock)
      clock += 8
    }
    check(
      'the first "/" of a scanned URL is swallowed before the palette sees it',
      interceptedBySlash,
      'otherwise the palette opens a third of the way through and eats the rest',
    )

    let human = emptyBurst()
    human = pushKey(human, 'a', 0)
    human = pushKey(human, '/', 400)
    check(
      'but a "/" a person presses is left alone',
      !burstInFlight(human, 400),
      'the shortcut still works',
    )

    // -----------------------------------------------------------------------
    console.log('\nScanning with nothing focused\n')
    // -----------------------------------------------------------------------

    await signIn(page, 'sam@teksolv.com')
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })

    const focused = await page.evaluate(() => document.activeElement?.tagName ?? '')
    await blur(page)
    check(
      'the search box is not focused — this is the point of the feature',
      focused !== 'INPUT',
      `active element on load: ${focused.toLowerCase() || 'none'}`,
    )

    await scan(page, `${BASE}/api/scan/${asset.assetTag}`)
    await page.waitForURL(`**/inventory/${asset.id}`, { timeout: 20_000 })
    check(
      'scanning a unit label lands on the unit',
      page.url().includes(`/inventory/${asset.id}`),
      `${asset.assetTag} → ${new URL(page.url()).pathname}`,
    )

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await blur(page)
    await scan(page, `${BASE}/c/${token}`)
    await page.waitForURL(`**/maintenance/records/${record.id}/form`, { timeout: 20_000 })
    check(
      'scanning a cal sticker opens that calibration report',
      page.url().includes(`/maintenance/records/${record.id}/form`),
      'a tech at the bench gets the real report, not the public certificate',
    )
    check(
      'and it is the report, not a sign-in page',
      (await page.locator('text=/CAL-01/i').count()) > 0,
      await page.title(),
    )

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await blur(page)
    await scan(page, `${BASE}/api/scan/truck/${truck.id}`)
    await page.waitForURL(`**/trucks/${truck.id}`, { timeout: 20_000 })
    check(
      'scanning a truck label opens the truck',
      page.url().includes(`/trucks/${truck.id}`),
      `Truck ${truck.number}`,
    )

    // -----------------------------------------------------------------------
    console.log('\nA bare serial goes to search\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await blur(page)
    await scan(page, asset.serialNumber!)
    await page.waitForURL(`**/inventory/${asset.id}`, { timeout: 20_000 })
    check(
      'a serial that names exactly one unit opens it',
      page.url().includes(`/inventory/${asset.id}`),
      `${asset.serialNumber} → the unit carrying it`,
    )

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await blur(page)
    await scan(page, 'ZZQ-NOTHING-9911')
    const palette = page.locator('[role="dialog"][aria-label="Global search"]')
    await palette.waitFor({ state: 'visible', timeout: 20_000 })
    check(
      'a scan that matches nothing opens search holding it',
      (await palette.locator('input').inputValue()) === 'ZZQ-NOTHING-9911',
      'the operator sees what was read rather than a silent nothing',
    )
    check(
      'and says so plainly',
      (await palette.locator('text=/Nothing matches/i').count()) > 0,
      (await palette.innerText()).split('\n').slice(-3).join(' · '),
    )
    await page.keyboard.press('Escape')

    // A partial serial matches more than one unit, or none exactly — either way
    // it is a question, not an answer, and must not open a unit. Built as a
    // strict prefix and confirmed to match nothing exactly, so the assertion is
    // about the routing rule rather than about this fixture's serial length.
    const partial = asset.serialNumber!.slice(0, Math.max(2, asset.serialNumber!.length - 2))
    const exactMatches = await prismaUnscoped.asset.count({
      where: {
        orgId: org.id,
        OR: [
          { serialNumber: { equals: partial, mode: 'insensitive' } },
          { assetTag: { equals: partial, mode: 'insensitive' } },
        ],
      },
    })
    check(
      'the partial used is genuinely partial',
      partial !== asset.serialNumber && exactMatches === 0,
      `"${partial}" from "${asset.serialNumber}" — ${exactMatches} exact match(es)`,
    )

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await blur(page)
    await scan(page, partial)
    await palette.waitFor({ state: 'visible', timeout: 20_000 })
    check(
      'a partial serial searches instead of guessing a unit',
      page.url().includes('/dashboard'),
      'opening the wrong monitor is worse than showing a list',
    )
    await page.keyboard.press('Escape')

    // -----------------------------------------------------------------------
    console.log('\nWhat it does not do\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await blur(page)
    // Deliberately the *resolvable* tag: a value that would navigate if the
    // burst detector were fooled. Typing something that matches nothing would
    // pass whether the debounce worked or not.
    await typeByHand(page, asset.assetTag)
    await page.waitForTimeout(900)
    check(
      'typing a real asset tag by hand navigates nowhere',
      page.url().includes('/dashboard'),
      'the debounce is the whole safety of a global Enter listener',
    )
    check(
      'and does not open search either',
      !(await palette.isVisible()),
      'a human Enter still belongs to whatever the human is doing',
    )

    // Places that already take a scan keep their own keystrokes.
    await page.goto(`${BASE}/trucks/${truck.id}`, { waitUntil: 'networkidle' })
    const stageBox = page.locator('input[name="scan"]')
    await stageBox.click()
    await page.keyboard.type(`${BASE}/api/scan/${asset.assetTag}`, { delay: 8 })
    check(
      'a scan into the truck stage box stays in the box',
      (await stageBox.inputValue()).includes(asset.assetTag),
      'the global listener must not steal from a field that wants the scan',
    )
    check('and did not navigate away', page.url().includes(`/trucks/${truck.id}`))

    check('no uncaught client errors', errors.length === 0, errors.join(' · '))
  } finally {
    await browser.close()
    // Unconditional and keyed off the marker, not off a variable captured
    // mid-run: a failure between create and cleanup must not strand a record.
    const { count } = await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { workDone: MARK },
    })
    console.log(`\n(cleaned up ${count} verification record${count === 1 ? '' : 's'})`)
    await prismaUnscoped.$disconnect()
  }

  console.log(
    failures === 0 ? '\nAll scan-to-search checks passed.' : `\n${failures} FAILED.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
