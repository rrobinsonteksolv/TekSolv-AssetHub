/**
 * Multi-item rentals: one order, many assets.
 *
 * A rental used to be one asset. Customers take several things at once, so four
 * monitors on one truck were four unrelated records with the customer typed
 * four times, no way to bring them back together, and no figure for what one
 * job is holding.
 *
 * The order **groups** rentals; it does not replace them. That is the claim
 * most worth testing, because it is the one a refactor quietly breaks: every
 * line is still its own rental, with its own custody flip, its own reservation
 * window and its own return. If the grouping had taken any of that over, a
 * partial return would be impossible and the GIST constraint would have nothing
 * to hold.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-rental-orders.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getRentalOrder, exposureByCustomer } from '../src/lib/rental-order-queries'
import { listPickableAssets, windowFromNow } from '../src/lib/availability'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const CUSTOMER = 'ORDERTEST Drilling Co'

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

const statusOf = (assetId: string) =>
  prismaUnscoped.asset
    .findUniqueOrThrow({ where: { id: assetId }, select: { status: true } })
    .then((row) => row.status)

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // Four available units — the shape of the owner's example (three monitors and
  // an SRL). Picked by availability rather than by category, so the suite does
  // not fail because the demo fleet happens to have two monitors on the shelf
  // rather than three: what is being tested is four lines on one order.
  // Through the picker's own query, so the fixture cannot pick units the form
  // will not offer — an AVAILABLE unit staged on a truck is not pickable, and
  // choosing four of those would fail on the fixture rather than the feature.
  const units = (await listPickableAssets(db, windowFromNow(new Date()), { take: 4 })).map(
    (asset) => ({ id: asset.id, assetTag: asset.assetTag }),
  )

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  let orderId: string | null = null

  try {
    check('four available units to work with', units.length === 4, units.map((u) => u.assetTag).join(', '))

    await signIn(page, 'ray@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nFour units, one order, one action\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/rentals/checkout`, { waitUntil: 'networkidle' })
    await settle(page)

    // Typed and Entered, one after another — what a barcode scanner sends.
    for (const unit of units) {
      await page.getByLabel('Add a unit').fill(unit.assetTag)
      await page.getByLabel('Add a unit').press('Enter')
      await page.waitForTimeout(250)
    }

    check(
      'scanning tag after tag builds the list',
      (await page.locator('input[name="assetIds"]').count()) === 4,
      `${await page.locator('input[name="assetIds"]').count()} lines staged — the box clears after each, ready for the next scan`,
    )

    // Customer, site and due date asked once for the whole order.
    // "+ New customer" is a button that swaps the select for a text box, not
    // an option inside it.
    await page.getByRole('button', { name: /New customer/i }).click()
    await page.locator('input[name="newCustomerName"]').fill(CUSTOMER)
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    await page.locator('input[name="expectedReturnDate"]').fill(due)

    const outBy = page.locator('select[name="checkedOutBy"]')
    if ((await outBy.count()) > 0) {
      const options = await outBy.locator('option').evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value && value !== 'COUNTER'),
      )
      if (options[0]) await outBy.selectOption(options[0])
    }

    // The submit button, not the page heading of the same words.
    await page.locator('button[type="submit"]').filter({ hasText: /Check out/i }).first().click()
    await page.waitForTimeout(4_000)
    if (!/\/rentals\/orders\//.test(page.url())) {
      const complaints = await page.locator('.text-danger, [role="alert"]').allInnerTexts()
      console.log(`        form refused: ${complaints.join(' | ') || 'no message shown'}`)
    }
    await page.waitForURL(/\/rentals\/orders\//, { timeout: 20_000 })
    await settle(page)
    orderId = page.url().split('/').pop()!

    const order = await getRentalOrder(db, orderId)
    check('one order was created', order !== null, orderId)
    check('with four lines', order!.lineCount === 4, `${order!.lineCount}`)
    check(
      'one customer, asked once',
      order!.customer?.name === CUSTOMER,
      order!.customer?.name ?? 'none',
    )
    check(
      'and one due date across the order',
      new Set(order!.lines.map((line) => line.expectedReturnDate.toISOString())).size === 1,
      'set once on the form, not retyped per unit',
    )

    // -----------------------------------------------------------------------
    console.log('\nEvery invariant still lives on the asset\n')
    // -----------------------------------------------------------------------

    const statuses = await Promise.all(units.map((unit) => statusOf(unit.id)))
    check(
      'all four assets are out on rent',
      statuses.every((status) => status === 'OUT_ON_RENT'),
      statuses.join(', '),
    )
    check(
      'each holding nothing — checkout releases custody',
      (await db.asset.count({
        where: { id: { in: units.map((u) => u.id) }, custodyType: null },
      })) === 4,
      'the order groups the lines; it does not take custody over from them',
    )

    const periods = await prismaUnscoped.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "Rental"
       WHERE "orderId" = $1 AND period IS NOT NULL`,
      orderId,
    )
    check(
      'and each line reserved its own window',
      Number(periods[0].count) === 4,
      'the GIST constraint reads the line row, so every line needs its own period',
    )

    // The constraint still bites: a second checkout of the same unit is refused.
    let refused = false
    try {
      await prismaUnscoped.$executeRawUnsafe(
        `INSERT INTO "Rental" ("id","orgId","orderId","assetId","recordedById","checkoutDate","expectedReturnDate","status","period","createdAt","updatedAt","kind","checkoutMethod","checkoutCondition")
         SELECT 'clash-probe', "orgId", "orderId", "assetId", "recordedById", "checkoutDate", "expectedReturnDate", 'OPEN', period, NOW(), NOW(), 'CUSTOMER', 'TECH', 'GOOD'
         FROM "Rental" WHERE "orderId" = $1 LIMIT 1`,
        orderId,
      )
    } catch {
      refused = true
    }
    check(
      'and the database still refuses to double-book a unit',
      refused,
      'rental_no_overlap is on the line row, and grouping lines did not weaken it',
    )

    check(
      'every line agrees with its order about customer and dates',
      order!.lines.every(
        (line) =>
          line.expectedReturnDate.getTime() === order!.expectedReturnDate.getTime() &&
          line.checkoutDate.getTime() === order!.checkoutDate.getTime(),
      ),
      'the copies exist because the constraint needs them; this is what stops them drifting',
    )

    // -----------------------------------------------------------------------
    console.log('\nValue rolls up by order and by customer\n')
    // -----------------------------------------------------------------------

    const expected = await db.asset
      .findMany({
        where: { id: { in: units.map((u) => u.id) } },
        select: { replacementCost: true },
      })
      .then((rows) => rows.reduce((sum, row) => sum + Number(row.replacementCost ?? 0), 0))
    check(
      'the order is worth the sum of its open lines',
      Math.round(order!.exposure) === Math.round(expected),
      `${order!.exposure} vs ${expected}`,
    )

    const byCustomer = await exposureByCustomer(db)
    const entry = byCustomer.find((row) => row.name === CUSTOMER)
    check(
      'and the customer rollup counts the order once and its units four times',
      entry?.orders === 1 && entry?.units === 4,
      `${entry?.orders} order(s), ${entry?.units} units, ${entry?.exposure}`,
    )

    // -----------------------------------------------------------------------
    console.log('\nPartial return: one back, three still out\n')
    // -----------------------------------------------------------------------

    const first = order!.lines[0]
    await page.goto(`${BASE}/rentals/orders/${orderId}`, { waitUntil: 'networkidle' })
    await settle(page)

    const firstRow = page.locator('div.border-b').filter({ hasText: first.asset.assetTag }).first()
    await firstRow.getByRole('button', { name: /^Return$/ }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /Check in/i }).first().click()
    await page.waitForTimeout(4_000)

    check(
      'the returned unit is available again',
      (await statusOf(first.asset.id)) === 'AVAILABLE',
      first.asset.assetTag,
    )
    const partial = await getRentalOrder(db, orderId)
    check('the order is still open', partial!.open && partial!.closedAt === null)
    check(
      'with three still out and one back',
      partial!.outCount === 3 && partial!.returnedCount === 1,
      `${partial!.outCount} out · ${partial!.returnedCount} back`,
    )
    check(
      'and its value dropped to what is still out',
      partial!.exposure < order!.exposure,
      `${order!.exposure} → ${partial!.exposure} — a unit back is no longer money in a field`,
    )
    check(
      'the other three are untouched',
      (await Promise.all(
        units.slice(1).map((unit) => statusOf(unit.id)),
      )).every((status) => status === 'OUT_ON_RENT'),
      'returning a line returns that line',
    )

    // -----------------------------------------------------------------------
    console.log('\nReturn the rest: the order closes itself\n')
    // -----------------------------------------------------------------------

    for (const line of partial!.lines.filter((row) => row.status === 'OPEN' || row.status === 'OVERDUE')) {
      await page.goto(`${BASE}/rentals/orders/${orderId}`, { waitUntil: 'networkidle' })
      await settle(page)
      const row = page.locator('div.border-b').filter({ hasText: line.asset.assetTag }).first()
      await row.getByRole('button', { name: /^Return$/ }).click()
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: /Check in/i }).first().click()
      await page.waitForTimeout(3_500)
    }

    const closed = await getRentalOrder(db, orderId)
    check('every unit is back', closed!.outCount === 0, `${closed!.returnedCount} of ${closed!.lineCount}`)
    check(
      'and the order closed itself',
      !closed!.open && closed!.closedAt !== null,
      'derived from the lines — nothing counts them separately',
    )
    check(
      'with nothing left on hire against that customer',
      (await exposureByCustomer(db)).every((row) => row.name !== CUSTOMER),
      'value on hire follows the lines that are actually out',
    )
    check(
      'all four assets available again',
      (await Promise.all(units.map((unit) => statusOf(unit.id)))).every(
        (status) => status === 'AVAILABLE',
      ),
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    if (orderId) {
      const lines = await prismaUnscoped.rental.findMany({
        where: { orderId },
        select: { id: true, assetId: true },
      })
      await prismaUnscoped.auditLog.deleteMany({
        where: { entityId: { in: lines.map((line) => line.assetId) } },
      })
      await prismaUnscoped.rental.deleteMany({ where: { orderId } })
      await prismaUnscoped.rentalOrder.delete({ where: { id: orderId } })
      await prismaUnscoped.asset.updateMany({
        where: { id: { in: lines.map((line) => line.assetId) } },
        data: { status: 'AVAILABLE' },
      })
    }
    await prismaUnscoped.customer.deleteMany({ where: { orgId: org.id, name: CUSTOMER } })
    console.log('\n(order, lines and test customer removed)')
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll rental-order checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
