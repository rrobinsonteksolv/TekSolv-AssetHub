/**
 * The Supplies page at scale.
 *
 * It was a stack of expandable cards, which reads pleasantly at five items and
 * stops working at sixty: nothing to search, no column to sort, no way to see
 * only what needs ordering, and opening one row pushed every other off the
 * screen. The per-office breakdown and the lots lived *inside* the row, printed
 * as a run of inline spans — `25-3007 ×5 · 09/14/2025` — that wrapped into each
 * other until two dates overlapped and neither could be read.
 *
 * So this suite creates a catalogue of its own and drives the page at that
 * size. The point is not that the table renders; it is that a person can still
 * find one item among sixty, see the twenty that need ordering, and read a lot's
 * expiry without guessing.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-supplies-view.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { supplyCategory } from '../src/lib/supply-categories'
import { parseBulkConsumables } from '../src/lib/validators/consumables'
import { usDate } from '../src/lib/dates'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const TAG = 'VSUP'

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
}

const rowsOnScreen = (page: Page) => page.locator('tbody tr td:first-child .font-medium')

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // ---------------------------------------------------------------------------
  console.log('\nCategories, derived from what the record already says\n')
  // ---------------------------------------------------------------------------

  check(
    'listing what is inside makes it calibration gas',
    supplyCategory({ name: 'Anything at all', gasComponents: [{ gas: 'H2S' }] }) === 'gas',
  )
  check(
    'a cartridge is a filter even when its name says gas',
    supplyCategory({ name: 'Acid gas cartridge' }) === 'filters',
    'checked before the gas rule, or every respirator cartridge files with the cylinders',
  )
  check(
    'a cylinder with no gas type recorded still reads as gas',
    supplyCategory({ name: '4-gas MSA Blend' }) === 'gas',
  )
  check('gloves are PPE', supplyCategory({ name: 'Nitrile gloves, large' }) === 'ppe')
  check(
    'and anything unrecognised lands in Consumables',
    supplyCategory({ name: 'Zip ties, 8in' }) === 'consumables',
    'the honest limit of deriving rather than storing a category',
  )

  // ---------------------------------------------------------------------------
  console.log('\nPasting a list reads it line by line\n')
  // ---------------------------------------------------------------------------

  const pasted = parseBulkConsumables(
    ['Gloves, box, GLV-1', 'Quad gas, cylinder, GAS-1, lots', 'X', 'Gloves', '', '# a comment'].join(
      '\n',
    ),
    'each',
  )
  check('blank lines and comments are skipped', pasted.length === 4, `${pasted.length} rows read`)
  check(
    'columns after the name are unit then SKU',
    pasted[0].unit === 'box' && pasted[0].sku === 'GLV-1' && !pasted[0].lotTracked,
  )
  check(
    'the word "lots" anywhere marks it lot-tracked',
    pasted[1].lotTracked && pasted[1].unit === 'cylinder',
  )
  check('a too-short name is rejected, not guessed at', pasted[2].error !== null, pasted[2].error ?? '')
  check(
    'and a repeat inside the same paste is caught',
    pasted[3].error !== null,
    `${pasted[3].error} — one bad line does not throw the other fifty-nine away`,
  )

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const made: string[] = []

  try {
    await signIn(page, 'ray@teksolv.com')

    // -------------------------------------------------------------------------
    console.log('\nAdding sixty items without sixty dialogs\n')
    // -------------------------------------------------------------------------

    const lines: string[] = []
    for (let index = 1; index <= 60; index++) {
      const kind = index % 4
      const name =
        kind === 0
          ? `${TAG} cal gas ${index} 34L`
          : kind === 1
            ? `${TAG} P100 filter ${index}`
            : kind === 2
              ? `${TAG} gloves ${index}`
              : `${TAG} zip ties ${index}`
      lines.push(`${name}, each, ${TAG}-${index}${kind === 0 || kind === 1 ? ', lots' : ''}`)
    }

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByRole('button', { name: /Add several/i }).click()
    await page.locator('textarea[name="text"]').fill(lines.join('\n'))
    await page.waitForTimeout(600)

    const previewText = (await page.locator('[role="dialog"]').innerText()).toLowerCase()
    check(
      'the preview says what will land before anything is written',
      previewText.includes('60 will be added'),
      previewText.split('\n').find((line) => line.includes('will be added')) ?? 'no preview',
    )

    await page.getByRole('button', { name: /^Add 60 items$/ }).click()
    await page.waitForTimeout(6_000)
    await settle(page)

    const created = await db.consumable.findMany({
      where: { name: { startsWith: TAG } },
      select: { id: true, name: true, lotTracked: true, unit: true },
    })
    made.push(...created.map((row) => row.id))
    check('all sixty landed', created.length === 60, `${created.length} created`)
    check(
      'with lot tracking where the line said so',
      created.filter((row) => row.lotTracked).length === 30,
      `${created.filter((row) => row.lotTracked).length} lot-tracked`,
    )

    // Re-pasting the same list must not duplicate.
    await page.getByRole('button', { name: /Add several/i }).click()
    await page.locator('textarea[name="text"]').fill(lines.slice(0, 5).join('\n'))
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /^Add 5 items$/ }).click()
    await page.waitForTimeout(4_000)
    check(
      're-pasting a list adds nothing twice',
      (await db.consumable.count({ where: { name: { startsWith: TAG } } })) === 60,
      'an item that already exists is left alone, so a list can be re-pasted to add what is new on it',
    )

    // -------------------------------------------------------------------------
    console.log('\nFinding one item among sixty-five\n')
    // -------------------------------------------------------------------------

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)

    const total = await db.consumable.count()
    check('the page is a table, not a stack of cards', (await page.locator('table thead').count()) > 0)
    check(
      `all ${total} items render`,
      (await rowsOnScreen(page).count()) === total,
      `${await rowsOnScreen(page).count()} rows`,
    )

    await page.getByLabel('Search supplies').fill('zip ties 3')
    await page.waitForTimeout(500)
    const hits = await rowsOnScreen(page).allInnerTexts()
    check(
      'search narrows to what was typed',
      hits.length > 0 && hits.every((text) => /zip ties 3/i.test(text)),
      `${hits.length} row(s): ${hits.slice(0, 3).join(', ')}`,
    )
    check(
      'and says how much of the catalogue is showing',
      (await page.locator('main').innerText()).includes(`of ${total} items`),
    )

    await page.getByLabel('Search supplies').fill('')
    await page.waitForTimeout(400)

    // -------------------------------------------------------------------------
    console.log('\nFilters, which are the point at this size\n')
    // -------------------------------------------------------------------------

    const groups = await page.locator('tbody th').allInnerTexts()
    check(
      'the list is grouped by category',
      groups.some((text) => /calibration gas/i.test(text)) &&
        groups.some((text) => /ppe/i.test(text)),
      groups.slice(0, 4).map((text) => text.split('\n')[0]).join(' · '),
    )

    await page.getByLabel('Category', { exact: true }).selectOption('ppe')
    await page.waitForTimeout(500)
    const ppeRows = await rowsOnScreen(page).allInnerTexts()
    check(
      'filtering to a category shows only that category',
      ppeRows.length > 0 && ppeRows.every((text) => supplyCategory({ name: text }) === 'ppe'),
      `${ppeRows.length} PPE rows`,
    )
    await page.getByLabel('Category', { exact: true }).selectOption('all')
    await page.waitForTimeout(400)

    // Make one item low so the reorder filter has something real to find.
    const [subject] = created
    const office = await db.location.findFirstOrThrow({
      where: { active: true, type: { in: ['OFFICE', 'WAREHOUSE'] } },
      select: { id: true, name: true },
    })
    await prismaUnscoped.consumableStock.create({
      data: {
        orgId: org.id,
        consumableId: subject.id,
        locationId: office.id,
        onHand: 1,
        reorderPoint: 10,
      },
    })

    await page.reload({ waitUntil: 'networkidle' })
    await settle(page)
    await page.getByRole('button', { name: /At reorder/ }).click()
    await page.waitForTimeout(500)
    const lowRows = await rowsOnScreen(page).allInnerTexts()
    check(
      'the reorder filter finds it',
      lowRows.some((text) => text.includes(subject.name)),
      `${lowRows.length} at or below reorder point`,
    )
    check(
      'and every row it shows is actually low',
      (await page.locator('tbody tr td:nth-child(4)').allInnerTexts()).every((text) =>
        /low/i.test(text),
      ),
      'a filter that shows anything else is worse than no filter',
    )

    // -------------------------------------------------------------------------
    console.log('\nSorting, on the stored number\n')
    // -------------------------------------------------------------------------

    await page.getByRole('button', { name: /^All \d+$/ }).click()
    await page.waitForTimeout(400)
    await page.getByRole('checkbox', { name: 'Group by category' }).uncheck()
    await page.getByRole('button', { name: /^On hand$/ }).click()
    await page.waitForTimeout(500)

    const totals = (await page.locator('tbody tr td:nth-child(2)').allInnerTexts()).map((text) =>
      Number(text.trim().split('\n')[0]),
    )
    const numeric = totals.filter((value) => Number.isFinite(value))
    check(
      'sorting by on-hand orders numerically, biggest first',
      numeric.every((value, index) => index === 0 || numeric[index - 1] >= value),
      `${numeric.slice(0, 6).join(' · ')} …`,
    )

    await page.getByRole('button', { name: /^On hand$/ }).click()
    await page.waitForTimeout(500)
    const flipped = (await page.locator('tbody tr td:nth-child(2)').allInnerTexts())
      .map((text) => Number(text.trim().split('\n')[0]))
      .filter((value) => Number.isFinite(value))
    check(
      'and clicking again flips it',
      flipped.every((value, index) => index === 0 || flipped[index - 1] <= value),
      `${flipped.slice(0, 6).join(' · ')} …`,
    )

    // -------------------------------------------------------------------------
    console.log('\nThe detail panel, where the lots became readable\n')
    // -------------------------------------------------------------------------

    // Give a lot-tracked item two lots at one office, one of them expiring.
    // Deliberately not `subject` — that one already carries a stock row from
    // the reorder check above, and a second create on the same (item, office)
    // is what the unique index is there to refuse.
    const lotItem = created.find((row) => row.lotTracked && row.id !== subject.id)!
    const soon = new Date(Date.now() + 10 * 86_400_000)
    const later = new Date(Date.now() + 700 * 86_400_000)
    await prismaUnscoped.consumableStock.create({
      data: {
        orgId: org.id,
        consumableId: lotItem.id,
        locationId: office.id,
        onHand: 12,
        reorderPoint: 2,
      },
    })
    for (const [lotNumber, quantity, expiresAt] of [
      ['LOT-SOON', 5, soon],
      ['LOT-LATER', 7, later],
    ] as const) {
      await prismaUnscoped.consumableLot.create({
        data: {
          orgId: org.id,
          consumableId: lotItem.id,
          locationId: office.id,
          lotNumber,
          quantity,
          expiresAt,
          receivedAt: new Date(),
        },
      })
    }

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByLabel('Search supplies').fill(lotItem.name)
    await page.waitForTimeout(500)
    await page.getByRole('cell', { name: new RegExp(lotItem.name) }).first().click()

    const drawer = page.locator('[role="dialog"]')
    await drawer.waitFor({ state: 'visible', timeout: 10_000 })
    const drawerText = await drawer.innerText()

    check('clicking a row opens a panel, not an inline expansion', await drawer.isVisible())
    check(
      'the office breakdown is in it',
      drawerText.includes(office.name),
      'out of the row, where it used to push everything else off the screen',
    )
    check(
      'the lots are a table with a column each',
      (await drawer.locator('table').count()) >= 2 &&
        drawerText.includes('LOT-SOON') &&
        drawerText.includes('LOT-LATER'),
      'four facts — which lot, how many, when, whether it counts — want four columns',
    )
    check(
      'each expiry is one readable date, in MM/DD/YYYY',
      drawerText.includes(usDate(soon)!) && drawerText.includes(usDate(later)!),
      `${usDate(soon)} and ${usDate(later)} — the old inline run overlapped two dates into one`,
    )
    check(
      'and the soonest-expiring lot is listed first',
      drawerText.indexOf('LOT-SOON') < drawerText.indexOf('LOT-LATER'),
      'the order the shelf will actually empty',
    )
    check(
      'the quantities are not run together as ×5 ×7',
      !/×\s*5/.test(drawerText) && drawerText.includes('12'),
      'a quantity in its own column, not a suffix on a lot number',
    )

    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    check('Escape closes it', (await drawer.count()) === 0)

    // -------------------------------------------------------------------------
    console.log('\nThe ledger promise, still kept\n')
    // -------------------------------------------------------------------------

    const pageText = (await page.locator('main').innerText()).toLowerCase()
    check(
      'the traceability line is still on the page',
      pageText.includes('every number here traces to a row'),
      'a claim about traceability is worth keeping, and worth showing the trace for',
    )
    check('with the movement feed under it', pageText.includes('recent movement'))

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.consumableTxn.deleteMany({ where: { consumableId: { in: made } } })
    await prismaUnscoped.consumableLot.deleteMany({ where: { consumableId: { in: made } } })
    await prismaUnscoped.consumableStock.deleteMany({ where: { consumableId: { in: made } } })
    await prismaUnscoped.consumable.deleteMany({ where: { id: { in: made } } })
    console.log(`\n(removed ${made.length} test supply items)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll supplies-view checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
