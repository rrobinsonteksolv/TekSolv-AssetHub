/**
 * Dates: `MM/DD/YYYY` on screen, ISO underneath.
 *
 * Three separate claims, and the second is the one that breaks quietly:
 *
 *  1. Every date a person sees reads `MM/DD/YYYY`, through one formatter.
 *  2. Nothing sorts or compares the formatted string. `'11/06/2026'` is less
 *     than `'02/02/2027'` as text, so a list ordered on the display value puts
 *     November after February and nobody notices until a due date is missed.
 *  3. A date typed the American way saves and comes back as the same day —
 *     no timezone shift, no rolling to the 5th because the server is in UTC.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-dates.ts
 */
import 'dotenv/config'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { isoDay, parseUsDate, usDate, usDateOr } from '../src/lib/dates'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

/** An ISO date loose in rendered text — what this change is meant to remove. */
const ISO_ON_SCREEN = /\b\d{4}-\d{2}-\d{2}\b/g

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

async function settle(page: Page) {
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
  return page.locator('main').innerText()
}

/** Every .ts/.tsx under src, for the "nobody rolls their own" sweep. */
function sourceFiles(dir = 'src'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // -------------------------------------------------------------------------
  console.log('\nThe formatter itself\n')
  // -------------------------------------------------------------------------

  check('a Date formats MM/DD/YYYY', usDate(new Date('2026-11-06T00:00:00Z')) === '11/06/2026')
  check('an ISO string formats the same', usDate('2026-11-06') === '11/06/2026')
  check(
    'a single-digit month and day are padded',
    usDate('2026-02-02') === '02/02/2026',
    usDate('2026-02-02') ?? 'null',
  )
  check('nothing in, nothing out', usDate(null) === null && usDate(undefined) === null)
  check('and a placeholder when one is wanted', usDateOr(null) === '—')

  check(
    'the UTC calendar day is what is read',
    usDate(new Date('2026-11-06T00:00:00.000Z')) === '11/06/2026',
    'a date-only value is midnight UTC of the day it means; reading local components west of Greenwich gives the 5th',
  )
  check(
    'so a timestamp late in the UTC day still reads that day',
    usDate(new Date('2026-11-06T23:30:00.000Z')) === '11/06/2026',
  )

  check('isoDay gives back storage form', isoDay(new Date('2026-11-06T00:00:00Z')) === '2026-11-06')
  check(
    'and round-trips a display string',
    isoDay('11/06/2026') === '2026-11-06' && usDate(isoDay('11/06/2026')) === '11/06/2026',
  )

  // -------------------------------------------------------------------------
  console.log('\nReading a date somebody typed\n')
  // -------------------------------------------------------------------------

  check('MM/DD/YYYY parses to ISO', parseUsDate('11/06/2026') === '2026-11-06')
  check('so does a single-digit form', parseUsDate('2/2/2026') === '2026-02-02')
  check('ISO is accepted too — the picker submits it', parseUsDate('2026-11-06') === '2026-11-06')
  check(
    'a day that does not exist is refused, not rolled forward',
    parseUsDate('02/30/2026') === null,
    'new Date(2026, 1, 30) silently becomes 2 March — a date that quietly becomes another date is worse than one refused',
  )
  check('and so is a month that does not exist', parseUsDate('13/01/2026') === null)
  check('nonsense is refused', parseUsDate('not a date') === null && parseUsDate('') === null)
  check(
    'a leap day is kept',
    parseUsDate('02/29/2028') === '2028-02-29' && parseUsDate('02/29/2027') === null,
    '2028 is a leap year, 2027 is not',
  )

  // -------------------------------------------------------------------------
  console.log('\nNothing sorts on what it shows\n')
  // -------------------------------------------------------------------------

  const days = ['2026-11-06', '2027-02-02', '2026-02-02']
  const byIso = [...days].sort()
  const byDisplay = [...days].map((day) => usDate(day)!).sort()
  check(
    'ISO sorts chronologically',
    byIso.join() === '2026-02-02,2026-11-06,2027-02-02',
    byIso.join(' · '),
  )
  check(
    'the display string does NOT — which is why nothing sorts on it',
    byDisplay.join() !== byIso.map((day) => usDate(day)).join(),
    `${byDisplay.join(' · ')} — November before February, exactly the bug this test exists to keep out`,
  )

  const sources = sourceFiles()

  // Scoped to the render layer on purpose. `toISOString().slice(0, 10)` in a
  // validator, a filename or a stored snapshot is *correct* — that is the ISO
  // this change is built on. What must not exist any more is a component
  // deciding for itself how a date looks.
  const rollsOwn = sources.filter(
    (file) =>
      file.endsWith('.tsx') &&
      /toISOString\(\)\.slice\(0, 10\)|toISOString\(\)\.split\(/.test(readFileSync(file, 'utf8')),
  )
  check(
    'no component rolls its own date formatter',
    rollsOwn.length === 0,
    rollsOwn.length ? rollsOwn.join(', ') : 'eleven copies of the same helper, now one',
  )

  const comparesDisplay = sources.filter((file) => {
    const text = readFileSync(file, 'utf8')
    return /usDate(Or)?\([^)]*\)\s*[<>]|sort[\s\S]{0,40}usDate\(/.test(text)
  })
  check(
    'and nothing compares or sorts a formatted date',
    comparesDisplay.length === 0,
    comparesDisplay.join(', ') || 'ordering stays on the ISO value',
  )

  // -------------------------------------------------------------------------
  console.log('\nOn the screens\n')
  // -------------------------------------------------------------------------

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  let restore: { id: string; assetTag: string; manufactureDate: Date | null } | null = null

  try {
    await signIn(page, 'ray@teksolv.com')

    const dated = await db.asset.findFirstOrThrow({
      where: { manufactureDate: { not: null } },
      orderBy: { assetTag: 'asc' },
      select: { id: true, assetTag: true, manufactureDate: true },
    })
    restore = dated

    for (const [label, url] of [
      ['the dashboard', `${BASE}/dashboard`],
      ['inventory', `${BASE}/inventory`],
      ['a unit', `${BASE}/inventory/${dated.id}`],
      ['inspections', `${BASE}/inspections`],
      ['the service queue', `${BASE}/maintenance`],
      ['reports', `${BASE}/reports`],
      ['areas', `${BASE}/areas`],
      ['kits', `${BASE}/containers`],
      ['supplies', `${BASE}/supplies`],
      ['rentals', `${BASE}/rentals`],
    ] as const) {
      await page.goto(url, { waitUntil: 'networkidle' })
      const text = await settle(page)
      const stray = [...new Set(text.match(ISO_ON_SCREEN) ?? [])]
      check(
        `${label} shows no ISO dates`,
        stray.length === 0,
        stray.length ? stray.join(', ') : 'every date on it goes through the formatter',
      )
    }

    // The unit's own dates, checked against what the database holds.
    await page.goto(`${BASE}/inventory/${dated.id}`, { waitUntil: 'networkidle' })
    const unitText = await settle(page)
    check(
      'a unit shows its manufacture date the American way',
      unitText.includes(usDate(dated.manufactureDate)!),
      `${usDate(dated.manufactureDate)} · stored ${isoDay(dated.manufactureDate)}`,
    )

    // -----------------------------------------------------------------------
    console.log('\nTyped in, stored ISO, read back the same day\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/inventory/${dated.id}/edit`, { waitUntil: 'networkidle' })
    await settle(page)

    const field = page.locator('input[name="manufactureDate"]')
    check(
      'the date field is a real picker',
      (await field.getAttribute('type')) === 'date',
      'a picker as well as typing, per the spec',
    )
    check(
      'holding the stored ISO, which is what the HTML date input wants',
      (await field.inputValue()) === isoDay(dated.manufactureDate),
      await field.inputValue(),
    )
    check(
      'and the document is en-US, so the picker reads MM/DD/YYYY',
      (await page.locator('html').getAttribute('lang')) === 'en-US',
      (await page.locator('html').getAttribute('lang')) ?? 'unset',
    )

    // Save a new date and confirm what landed in the column.
    const typed = '2029-03-07'
    await field.fill(typed)
    await page.getByRole('button', { name: /^Save/ }).click()
    await page.waitForTimeout(3_000)

    const saved = await db.asset.findUniqueOrThrow({
      where: { id: dated.id },
      select: { manufactureDate: true },
    })
    check(
      'the picker’s date saves as the day chosen',
      isoDay(saved.manufactureDate) === typed,
      `${isoDay(saved.manufactureDate)} (stored ${saved.manufactureDate?.toISOString()})`,
    )

    await page.goto(`${BASE}/inventory/${dated.id}`, { waitUntil: 'networkidle' })
    const afterText = await settle(page)
    check(
      'and reads back as 03/07/2029, not shifted a day',
      afterText.includes('03/07/2029'),
      'stored as midnight UTC of the day meant, and read back in UTC — no shift either way',
    )

    // The same date typed the American way must land identically. Submitted
    // through the server action's own parser, which is where a pasted or
    // scanner-typed value arrives.
    check(
      'the same day typed as 03/07/2029 parses to the same ISO',
      parseUsDate('03/07/2029') === typed,
      'the picker and the keyboard agree',
    )

    // -----------------------------------------------------------------------
    console.log('\nSorting still runs on the stored value\n')
    // -----------------------------------------------------------------------

    const queue = await db.maintenanceSchedule.findMany({
      where: { nextDue: { not: null } },
      orderBy: { nextDue: 'asc' },
      take: 6,
      select: { nextDue: true },
    })
    const isoOrder = queue.map((row) => isoDay(row.nextDue)!)
    check(
      'the due queue comes back in date order from the database',
      isoOrder.join() === [...isoOrder].sort().join(),
      isoOrder.map((day) => usDate(day)).join(' · '),
    )
    // The same rows sorted as *displayed* text, to show the two orders are not
    // the same thing. Skipped when the sample spans one year, where they agree
    // by coincidence and the comparison would prove nothing.
    const spansYears = new Set(isoOrder.map((day) => day.slice(0, 4))).size > 1
    if (spansYears) {
      const displayOrder = [...isoOrder.map((day) => usDate(day)!)].sort()
      check(
        'sorting the displayed strings instead would reorder them',
        displayOrder.join() !== isoOrder.map((day) => usDate(day)).join(),
        `${displayOrder.join(' · ')} — ordering is a database concern, formatting happens after it`,
      )
    } else {
      console.log('  ....  (due dates all fall in one year, so display order agrees by chance)')
    }

    // -----------------------------------------------------------------------
    console.log('\nThe sticker and the certificate agree\n')
    // -----------------------------------------------------------------------

    check(
      'both go through the one formatter',
      /usDate/.test(readFileSync(join('src', 'lib', 'labels', 'templates.ts'), 'utf8')) &&
        /usDate/.test(readFileSync(join('src', 'components', 'calibration', 'cal01-form.tsx'), 'utf8')) &&
        /usDate/.test(readFileSync(join('src', 'components', 'inspections', 'fp01-form.tsx'), 'utf8')),
      'the label on the unit and the certificate beside it cannot disagree about the order of the numbers',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    // Put the unit's date back. This suite edits a real asset to prove a
    // round trip, and a verification run must not leave the fleet changed.
    if (restore) {
      await prismaUnscoped.asset.update({
        where: { id: restore.id },
        data: { manufactureDate: restore.manufactureDate },
      })
      console.log(`
(restored ${restore.assetTag}'s manufacture date to ${isoDay(restore.manufactureDate)})`)
    }
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll date checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
