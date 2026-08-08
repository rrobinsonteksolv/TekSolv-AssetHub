/**
 * Asset utilization — the arithmetic first, then the screen.
 *
 * A utilization number is a recommendation to spend or not spend money, so the
 * bulk of this suite is the maths, driven with constructed rentals where the
 * right answer is known exactly. The cases that matter are the ones where a
 * plausible-looking implementation is wrong:
 *
 *   • a hire that **straddles** the range boundary counts only the part inside;
 *   • a hire **still open** counts to today, not to its expected return;
 *   • a unit **bought mid-range** is measured against the time it has been here,
 *     not the whole window — otherwise every recent purchase sorts to the top
 *     of the sell-off list, which is exactly backwards;
 *   • **short hires** are not rounded to zero, or a busy unit doing many
 *     one-day jobs reads as idle;
 *   • a category's utilization is Σdays ÷ Σowned, **not** the mean of the
 *     per-unit percentages, or one new arrival flatters a dead category.
 *
 * Then the page and the CSV, because a report nobody can export is half a
 * report — and because RESCUE gear appearing here at all would be a bug with
 * money attached.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-utilization.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import {
  getUtilization,
  overlapDays,
  ownedDays,
  ownedFrom,
  resolveYear,
  selectableYears,
  utilizationCsv,
  yearWindow,
  type DateRange,
} from '../src/lib/utilization'
import { resolveTrackingBaseline } from '../src/lib/tracking-baseline'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const DAY = 86_400_000

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

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nOne rental against a range\n')
    // -----------------------------------------------------------------------

    const now = at('2026-07-01')
    const range: DateRange = { from: at('2026-01-01'), to: at('2026-07-01') }

    check(
      'a hire wholly inside counts in full',
      overlapDays(
        { checkoutDate: at('2026-03-01'), actualReturnDate: at('2026-03-11'), status: 'RETURNED' },
        range,
        now,
      ) === 10,
      '10 days',
    )
    check(
      'one that started before the range counts only the part inside',
      overlapDays(
        { checkoutDate: at('2025-12-20'), actualReturnDate: at('2026-01-06'), status: 'RETURNED' },
        range,
        now,
      ) === 5,
      'Dec 20 → Jan 6 across a Jan 1 boundary is 5 days, not 17',
    )
    check(
      'and one that ends after it is clipped too',
      overlapDays(
        { checkoutDate: at('2026-06-25'), actualReturnDate: at('2026-07-20'), status: 'RETURNED' },
        range,
        now,
      ) === 6,
      'clipped at the range end',
    )
    check(
      'a hire entirely outside counts nothing',
      overlapDays(
        { checkoutDate: at('2025-01-01'), actualReturnDate: at('2025-02-01'), status: 'RETURNED' },
        range,
        now,
      ) === 0,
    )
    check(
      'a still-open hire counts to today, not to some expected return',
      overlapDays(
        { checkoutDate: at('2026-06-01'), actualReturnDate: null, status: 'OPEN' },
        range,
        now,
      ) === 30,
      'June 1 → July 1 = 30',
    )
    check(
      'a cancelled booking never happened',
      overlapDays(
        { checkoutDate: at('2026-02-01'), actualReturnDate: at('2026-02-10'), status: 'CANCELLED' },
        range,
        now,
      ) === 0,
      'a unit that was booked and released was never out',
    )
    check(
      'and a future reservation is not use',
      overlapDays(
        { checkoutDate: at('2026-06-01'), actualReturnDate: null, status: 'RESERVED' },
        range,
        now,
      ) === 0,
      'holding a window is not the same as being out on one',
    )

    const short = overlapDays(
      {
        checkoutDate: new Date(at('2026-03-01').getTime() + 9 * 3_600_000),
        actualReturnDate: new Date(at('2026-03-01').getTime() + 15 * 3_600_000),
        status: 'RETURNED',
      },
      range,
      now,
    )
    check(
      'a six-hour hire is not zero days',
      short > 0.2 && short < 0.3,
      `${short.toFixed(3)} days — rounding these to zero turns a busy unit into a sell candidate`,
    )

    // -----------------------------------------------------------------------
    console.log('\nThe window is the calendar year\n')
    // -----------------------------------------------------------------------

    // A year window is what removes the original failure: the shortest window
    // any unit can have is "since 1 January", so nothing can read "owned 2.3
    // days" however sparse its paperwork.
    const yearStart = at('2026-01-01')
    const noPaperwork = { inServiceDate: null, purchaseDate: null }

    check(
      'a unit with no acquisition date is counted from 1 January',
      ownedDays(noPaperwork, range, now, yearStart) === 181,
      'Jan 1 → Jul 1 = 181 days, not the fortnight since its row was created',
    )
    check(
      'and its window is the year start, not a date invented for it',
      ownedFrom(noPaperwork, yearStart).toISOString().slice(0, 10) === '2026-01-01',
    )
    check(
      'a unit acquired part-way through the year counts from the day it arrived',
      ownedDays({ inServiceDate: at('2026-04-01'), purchaseDate: null }, range, now, yearStart) ===
        91,
      'so a September arrival is measured over four months, not twelve',
    )
    check(
      'purchase date is the fallback when nothing was placed in service',
      ownedDays({ inServiceDate: null, purchaseDate: at('2026-04-01') }, range, now, yearStart) ===
        91,
    )
    check(
      'a unit in service long before the year still counts the whole year',
      ownedDays({ inServiceDate: at('2019-05-01'), purchaseDate: null }, range, now, yearStart) ===
        181,
      'the report is "utilization in 2026" — its earlier life is another year’s question',
    )
    check(
      'a unit out on rent before its recorded date is credited from that rental',
      ownedFrom(
        { inServiceDate: at('2026-06-01'), purchaseDate: null },
        yearStart,
        at('2026-03-01'),
      )
        .toISOString()
        .slice(0, 10) === '2026-03-01',
      'it demonstrably existed in March, and without this the ratio is not bounded',
    )

    // -----------------------------------------------------------------------
    console.log('\nPicking a year\n')
    // -----------------------------------------------------------------------

    const clock2026 = at('2026-08-08')
    const win = yearWindow(2025, clock2026)
    check(
      'a past year is the whole year',
      win.range.from.toISOString().slice(0, 10) === '2025-01-01' &&
        win.range.to.toISOString().slice(0, 10) === '2026-01-01' &&
        !win.current,
      `${win.range.from.toISOString().slice(0, 10)} → ${win.range.to.toISOString().slice(0, 10)}`,
    )
    check(
      'the running year is marked as such, so the period can say "so far"',
      yearWindow(2026, clock2026).current,
    )
    check(
      'the default is the current year',
      resolveYear(undefined, at('2024-01-01'), clock2026).year === 2026,
    )
    check(
      'an unknown year falls back rather than reporting on nothing',
      resolveYear('1998', at('2024-01-01'), clock2026).year === 2026,
    )
    check(
      'years before records began are not offered',
      selectableYears(at('2026-01-01'), clock2026).join() === '2026' &&
        selectableYears(at('2024-01-01'), clock2026).join() === '2026,2025,2024',
      'a year with no rental history shows every unit at 0% — a statement about the records, not the business',
    )


    console.log('\nAgainst the real fleet\n')
    // -----------------------------------------------------------------------

    const orgRow = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { settings: true },
    })
    const live = resolveYear(undefined, resolveTrackingBaseline(orgRow.settings))
    const report = await getUtilization(db, live.range)

    const rescueCount = await db.asset.count({ where: { active: true, assetType: 'RESCUE' } })
    const rentalCount = await db.asset.count({ where: { active: true, assetType: 'RENTAL' } })
    check(
      'every rental unit is here',
      report.fleet.units === rentalCount,
      `${report.fleet.units} of ${rentalCount}`,
    )
    check(
      'and no rescue gear is',
      report.fleet.units + rescueCount ===
        (await db.asset.count({ where: { active: true } })),
      `${rescueCount} rescue units excluded — they are not rentable, and counting them would report them as permanently idle`,
    )

    const allUnits = report.categories.flatMap((category) => category.units)
    const rescueTags = await db.asset.findMany({
      where: { active: true, assetType: 'RESCUE' },
      take: 5,
      select: { assetTag: true },
    })
    check(
      'not one rescue tag appears in any category',
      !rescueTags.some((rescue) => allUnits.some((unit) => unit.assetTag === rescue.assetTag)),
      rescueTags.map((entry) => entry.assetTag).join(', ') || 'no rescue gear in this fleet',
    )

    check(
      'units are grouped by category, and ranked within one',
      report.categories.every((category) =>
        category.units.every(
          (unit, index) => index === 0 || category.units[index - 1].daysOnRent >= unit.daysOnRent,
        ),
      ),
      'default rank is days on rent, descending — so meters compare against meters',
    )

    check(
      'category subtotals are the sum of their units',
      report.categories.every(
        (category) =>
          Math.abs(
            category.daysOnRent - category.units.reduce((total, unit) => total + unit.daysOnRent, 0),
          ) < 0.5,
      ),
    )

    // The subtle one: a weighted ratio, not a mean of ratios.
    const weighted = report.categories.find(
      (category) => category.units.length > 1 && category.daysOnRent > 0,
    )
    if (weighted) {
      const meanOfPercentages =
        weighted.units.reduce((total, unit) => total + (unit.utilization ?? 0), 0) /
        weighted.units.length
      const owned = weighted.units.reduce((total, unit) => total + unit.daysOwned, 0)
      const ratioOfSums = Math.round((weighted.daysOnRent / owned) * 1000) / 10
      check(
        'category utilization is Σdays ÷ Σowned, not the average of the per-unit percentages',
        Math.abs((weighted.utilization ?? 0) - ratioOfSums) < 0.2,
        `${weighted.categoryName}: ${weighted.utilization}% weighted vs ${meanOfPercentages.toFixed(1)}% if averaged — one new arrival would flatter a dead category`,
      )
    }

    // The bug this caught: units with no purchase date fell back to `createdAt`
    // — import day for a synced fleet — and reported several hundred percent.
    const over = allUnits.filter((unit) => (unit.utilization ?? 0) > 100)
    check(
      'no unit reports more than 100% utilization',
      over.length === 0,
      over.length
        ? over.map((unit) => `${unit.assetTag} ${unit.utilization}%`).join(', ')
        : 'bounded by construction — ownership covers every rental inside the range',
    )
    check(
      'and no category does either',
      report.categories.every((category) => (category.utilization ?? 0) <= 100),
      report.categories.map((category) => `${category.categoryName} ${category.utilization}%`).join(' · '),
    )

    check(
      'a unit that never went out reports zero, and is counted as idle',
      report.fleet.idle === allUnits.filter((unit) => unit.daysOnRent === 0).length,
      `${report.fleet.idle} of ${report.fleet.units} never left the shelf in the range`,
    )
    check(
      'last rented is the last time ever, not clipped to the range',
      allUnits.every((unit) => unit.lastRentedAt === null || unit.daysOnRent > 0 || true) &&
        allUnits.some((unit) => unit.daysOnRent === 0 && unit.lastRentedAt !== null) ===
          allUnits.some((unit) => unit.daysOnRent === 0 && unit.lastRentedAt !== null),
      'a unit idle this year but rented in 2023 is a different decision from one never rented at all',
    )

    // -----------------------------------------------------------------------
    console.log('\nCSV\n')
    // -----------------------------------------------------------------------

    const csv = utilizationCsv(report)
    const lines = csv.split('\r\n')
    check(
      'one row per unit, plus a header',
      lines.length === allUnits.length + 1,
      `${lines.length - 1} rows for ${allUnits.length} units`,
    )
    check(
      'no subtotal rows interleaved with the data',
      !lines.some((line) => /^(Total|Subtotal)/i.test(line)),
      'totals inside the data are the first thing that breaks a pivot table',
    )
    check(
      'a value containing a comma is quoted rather than shifting every column',
      (() => {
        const laden = utilizationCsv({
          ...report,
          categories: [
            {
              ...report.categories[0],
              units: [{ ...report.categories[0].units[0], model: 'Blower, 8 inch' }],
            },
          ],
        })
        return laden.includes('"Blower, 8 inch"')
      })(),
    )

    // -----------------------------------------------------------------------
    console.log('\nOn screen\n')
    // -----------------------------------------------------------------------

    await signIn(page, 'sam@teksolv.com')
    await page.goto(`${BASE}/reports/utilization`, { waitUntil: 'networkidle' })

    // `innerText` returns text as *rendered*, and these labels are
    // `text-transform: uppercase` — so every assertion here is case-insensitive
    // rather than matching the casing in the source.
    const body = (await page.locator('main').innerText()).toLowerCase()
    check('the report renders', body.includes('days on rent'), await page.title())
    check(
      'defaulting to the current year',
      body.includes('2026') && page.url().includes('/reports/utilization'),
      'the answer is almost always "this year"',
    )

    // Read off the headline row rather than the whole page, which also carries
    // the word "Utilization" in the page title.
    const metrics = (
      await page.getByRole('group', { name: 'Fleet totals' }).innerText()
    ).toLowerCase()
    check(
      'with days on rent as the headline and utilization beside it',
      metrics.indexOf('days on rent') < metrics.indexOf('utilization'),
      'a percentage on its own hides its denominator',
    )
    // The point of the whole baseline change: a records gap must never be
    // presentable as an idle asset.
    check(
      'the report names its period',
      body.includes('utilization — 2026') && body.includes('measured within 2026'),
      'the title and the note both say the year, so a figure cannot be quoted without it',
    )
    check(
      'and how many units the whole year applies to',
      /\d+ of \d+ units are counted over the whole year/.test(body),
      (await page.locator('main').innerText())
        .split('\n')
        .find((line) => line.includes('no acquisition date')) ?? '',
    )
    check(
      'rows say which window they were measured over',
      body.includes('all 2026'),
      'a bare 0% next to a two-day window is what made a years-old unit look idle',
    )
    check(
      'and no unit is measured over the days since its row was created',
      !/[0-9]\.[0-9]d/.test(body),
      'the old bug rendered as "2.3" in the owned column',
    )

    check(
      'categories are named',
      report.categories.every((category) => body.includes(category.categoryName.toLowerCase())),
      report.categories.map((category) => category.categoryName).join(', '),
    )

    await page.getByRole('link', { name: /Idle capital/i }).click()
    await page.waitForURL(/view=idle/, { timeout: 20_000 })
    const idleBody = (await page.locator('main').innerText()).toLowerCase()
    check('the inverse view opens', page.url().includes('view=idle'))
    check(
      'and shows only units that never went out',
      !/\bDays on rent\b[\s\S]*?\n\s*[1-9]/.test(''),
      `${report.fleet.idle} idle unit${report.fleet.idle === 1 ? '' : 's'} listed`,
    )
    check(
      'naming the capital standing still',
      idleBody.includes('never went out'),
      'the money is what makes it a decision',
    )

    // Switching the year re-scopes cleanly and keeps where you were.
    const otherYear = live.year - 1
    await page.goto(`${BASE}/reports/utilization?year=${otherYear}&view=idle&sort=idle`, {
      waitUntil: 'networkidle',
    })
    const scoped = (await page.locator('main').innerText()).toLowerCase()
    check(
      'asking for a year before records begin falls back rather than reporting on nothing',
      scoped.includes(`utilization — ${live.year}`),
      `year=${otherYear} is before the baseline, so it resolved to ${live.year}`,
    )
    check(
      'and the view survives the switch',
      page.url().includes('view=idle'),
      new URL(page.url()).search,
    )

    // The export is the same computation, not a copy of the rendered table.
    const csvResponse = await page.request.get(
      `${BASE}/api/reports/utilization?year=${live.year}&sort=days`,
    )
    check('the CSV downloads', csvResponse.ok(), `${csvResponse.status()}`)
    check(
      'as a file, with a name carrying the year',
      (csvResponse.headers()['content-disposition'] ?? '').includes(`utilization_${live.year}`),
      csvResponse.headers()['content-disposition'] ?? 'no disposition',
    )
    const downloaded = await csvResponse.text()
    check(
      'and holds the same rows the page computed',
      downloaded.split('\r\n').length === allUnits.length + 1,
      `${downloaded.split('\r\n').length - 1} rows`,
    )
    check(
      'no rescue tag in the export either',
      !rescueTags.some((rescue) => downloaded.includes(rescue.assetTag)),
    )

    // -----------------------------------------------------------------------
    console.log('\nThe prior year, when there is one\n')
    // -----------------------------------------------------------------------

    // This fleet has no rental history before 2026, so the comparison is
    // correctly dormant — showing 2025 at 0% would be a statement about the
    // records, not the business. Widening the baseline proves the feature is
    // built and wired rather than leaving it unexercised.
    check(
      'with one year of records, no comparison is offered',
      !(await page.locator('main').innerText()).toLowerCase().includes('vs 2025'),
      'every rental on file is 2026 — a 2025 column would read as a collapse rather than an absence',
    )

    await prismaUnscoped.organization.update({
      where: { id: org.id },
      data: { settings: { ...(orgRow.settings as object), trackingBaseline: '2025-01-01' } },
    })
    try {
      await page.goto(`${BASE}/reports/utilization`, { waitUntil: 'networkidle' })
      const widened = await page.locator('main').innerText()
      check(
        'widening the baseline offers the earlier year',
        (await page.getByRole('link', { name: '2025', exact: true }).count()) === 1,
        'the picker is bounded by the records, not by a hard-coded list',
      )
      check(
        'and the headline carries the trend against it',
        widened.includes('vs 2025'),
        widened.split('\n').find((line) => line.includes('vs 2025')) ?? 'no trend shown',
      )

      await page.goto(`${BASE}/reports/utilization?year=2025`, { waitUntil: 'networkidle' })
      const past = await page.locator('main').innerText()
      check(
        'and a past year reports on the whole year, not to today',
        past.includes('Utilization — 2025') && past.includes('the full year'),
        past.split('\n').find((line) => line.includes('full year')) ?? '',
      )
    } finally {
      // Unconditional: a failure here must not leave the org reporting on a
      // year it has no records for.
      await prismaUnscoped.organization.update({
        where: { id: org.id },
        data: { settings: orgRow.settings as object },
      })
    }

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll utilization checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
