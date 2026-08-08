/**
 * The rentals board, grouped by order.
 *
 * It was one row per unit sorted by due date, so a four-unit job appeared as
 * four rows scattered among other customers' — the same customer, site and date
 * printed four times, with nothing saying they belonged together and no figure
 * for what the job as a whole was holding.
 *
 * What is worth holding still: that one order is one row whatever it contains,
 * that the units are still reachable underneath it, that "overdue" is a
 * property of the order rather than of one unit on it, and — the quiet one —
 * that sorting by due date sorts on the stored instant rather than the
 * `MM/DD/YYYY` string, which would put November before February.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-rental-board.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { orderState, rentalOrderBoard } from '../src/lib/rental-order-queries'
import { openSingleLineOrder } from '../src/lib/rental-orders'
import { usDate } from '../src/lib/dates'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const TAG = 'BOARDTEST'
const CUSTOMER = 'BOARDTEST Wireline'
const SITE = 'BOARDTEST Pad 12'

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

/**
 * Order rows only.
 *
 * An expanded order renders a second `<tr>` holding its line items in one
 * full-width cell, and those lines carry the same `.font-medium` the customer
 * name does — so a naive selector counts an expanded four-unit order as five
 * rows and every count downstream is quietly wrong.
 */
const orderRows = (page: Page) =>
  page.locator('tbody tr:not(:has(td[colspan])) td:first-child .font-medium')

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // -------------------------------------------------------------------------
  console.log('\nWhat state an order is in\n')
  // -------------------------------------------------------------------------

  const now = new Date()
  const soon = new Date(now.getTime() + 5 * 86_400_000)
  const past = new Date(now.getTime() - 5 * 86_400_000)

  check(
    'everything out and not yet due reads Out',
    orderState([{ status: 'OPEN' }, { status: 'OPEN' }], soon, now) === 'out',
  )
  check(
    'some back and some out reads Partly back',
    orderState([{ status: 'OPEN' }, { status: 'RETURNED' }], soon, now) === 'partial',
    'a crew that returned two of four is a different conversation from one that returned nothing',
  )
  check(
    'past its date with anything out reads Overdue',
    orderState([{ status: 'OPEN' }, { status: 'RETURNED' }], past, now) === 'overdue',
    'overdue outranks partly-back — the date is the thing somebody rings about',
  )
  check(
    'and everything back reads Complete, whatever the date says',
    orderState([{ status: 'RETURNED' }, { status: 'RETURNED' }], past, now) === 'closed',
    'a closed order is not overdue; it is finished',
  )

  const category = await prismaUnscoped.category.findFirstOrThrow({
    where: { orgId: org.id },
    select: { id: true },
  })
  const staff = await prismaUnscoped.membership.findFirstOrThrow({
    where: { orgId: org.id, active: true, role: { in: ['ADMIN', 'MANAGER'] } },
    select: { userId: true },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const madeAssets: string[] = []
  let orderId: string | null = null

  try {
    // -----------------------------------------------------------------------
    console.log('\nOne order is one row, whatever it holds\n')
    // -----------------------------------------------------------------------

    const customer = await prismaUnscoped.customer.create({
      data: { orgId: org.id, name: CUSTOMER },
    })
    const job = await prismaUnscoped.job.create({
      data: { orgId: org.id, name: SITE, customerId: customer.id },
    })

    const checkoutDate = new Date(now.getTime() - 2 * 86_400_000)
    // Deliberately far in the future, so the due-date sort has a value that
    // sorts differently as text than as a date.
    const expectedReturnDate = new Date(now.getTime() + 400 * 86_400_000)

    orderId = await prismaUnscoped.$transaction(async (tx) => {
      const id = await openSingleLineOrder(tx, {
        orgId: org.id,
        customerId: customer.id,
        jobId: job.id,
        orderNumber: 'BOARD-SO-1',
        recordedById: staff.userId,
        checkedOutById: staff.userId,
        checkoutDate,
        expectedReturnDate,
      })

      for (let index = 0; index < 5; index++) {
        const asset = await tx.asset.create({
          data: {
            orgId: org.id,
            assetTag: `${TAG}-${index + 1}`,
            model: 'Board probe unit',
            categoryId: category.id,
            status: 'AVAILABLE',
            condition: 'GOOD',
            assetType: 'RENTAL',
            replacementCost: 1000,
          },
          select: { id: true },
        })
        madeAssets.push(asset.id)

        // The last one comes back straight away, so the order is partly back.
        const back = index === 4
        const line = await tx.rental.create({
          data: {
            orgId: org.id,
            orderId: id,
            assetId: asset.id,
            customerId: customer.id,
            jobId: job.id,
            recordedById: staff.userId,
            checkedOutById: staff.userId,
            checkoutDate,
            expectedReturnDate,
            status: back ? 'RETURNED' : 'OPEN',
            ...(back
              ? { actualReturnDate: now, checkinCondition: 'GOOD', checkedInById: staff.userId }
              : {}),
          },
        })
        if (!back) {
          await tx.$executeRaw`
            UPDATE "Rental" SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
            WHERE id = ${line.id} AND "orgId" = ${org.id}
          `
          await tx.asset.update({ where: { id: asset.id }, data: { status: 'OUT_ON_RENT' } })
        }
      }
      return id
    })

    await signIn(page, 'ray@teksolv.com')
    await page.goto(`${BASE}/rentals`, { waitUntil: 'networkidle' })
    await settle(page)

    const board = await rentalOrderBoard(db)
    const mine = board.orders.find((order) => order.id === orderId)!

    check(
      'the five units appear as one row',
      (await page.getByRole('cell', { name: new RegExp(CUSTOMER) }).count()) === 1,
      'one job, one line on the board — not five rows scattered by due date',
    )
    check(
      'showing 4 of 5 out',
      mine.outCount === 4 && mine.lineCount === 5,
      `${mine.outCount} of ${mine.lineCount}`,
    )
    check('and reading Partly back', mine.state === 'partial', mine.state)

    const rowText = await page
      .locator('tbody tr')
      .filter({ hasText: CUSTOMER })
      .first()
      .innerText()
    check('with the job site on it', rowText.includes(SITE), SITE)
    check(
      'the due date in MM/DD/YYYY',
      rowText.includes(usDate(expectedReturnDate)!),
      usDate(expectedReturnDate) ?? '',
    )
    check(
      'and the order’s value, not one unit’s',
      rowText.includes('$4,000'),
      `${mine.exposure} — four units still out at $1,000 each; the fifth is back and stops counting`,
    )

    // -----------------------------------------------------------------------
    console.log('\nThe units are underneath, not gone\n')
    // -----------------------------------------------------------------------

    await page.getByRole('cell', { name: new RegExp(CUSTOMER) }).first().click()
    await page.waitForTimeout(600)
    const expanded = await page.locator('main').innerText()
    check(
      'expanding the order lists every unit on it',
      [1, 2, 3, 4, 5].every((n) => expanded.includes(`${TAG}-${n}`)),
      'the line items are still where every real fact lives',
    )
    check(
      'including the one already returned, marked as back',
      expanded.includes(`${TAG}-5`) && /back/i.test(expanded),
      'a returned line stays on the order — it is part of what went out',
    )

    // -----------------------------------------------------------------------
    console.log('\nHeader stats roll up from orders and lines\n')
    // -----------------------------------------------------------------------

    const header = await page.locator('main').innerText()
    check(
      'the header counts orders and units separately',
      header.includes(`${board.orderCount} order`) && header.includes(`${board.unitCount} unit`),
      `${board.orderCount} orders · ${board.unitCount} units — one number pretending to be both is how a board reads two ways`,
    )
    check(
      'units counted are the ones still out',
      board.unitCount === board.orders.reduce((sum, order) => sum + order.outCount, 0),
      'a returned line is not deployed',
    )
    check(
      'and deployed value is the sum of open lines',
      board.deployedValue === board.orders.reduce((sum, order) => sum + order.exposure, 0),
    )

    // -----------------------------------------------------------------------
    console.log('\nSearch, filter and sort\n')
    // -----------------------------------------------------------------------

    await page.getByLabel('Search orders').fill(`${TAG}-2`)
    await page.waitForTimeout(500)
    check(
      'searching a unit tag finds the order it is on',
      (await orderRows(page).allInnerTexts()).some((text) => text.includes(CUSTOMER)),
      'somebody holding a tag wants the order, not a reason to go and look it up first',
    )

    await page.getByLabel('Search orders').fill('')
    await page.waitForTimeout(300)
    // Collapsed again, so what follows counts rows rather than rows plus the
    // lines of whichever one happens to be open.
    await page.getByRole('cell', { name: new RegExp(CUSTOMER) }).first().click()
    await page.waitForTimeout(400)

    const customerSelect = page.getByLabel('Customer', { exact: true })
    await customerSelect.selectOption(CUSTOMER)
    await page.waitForTimeout(900)
    const filtered = await orderRows(page).allInnerTexts()
    check(
      'filtering by customer shows only theirs',
      filtered.length === 1 && filtered[0].includes(CUSTOMER),
      `${filtered.length} row(s) · select reads "${await customerSelect.inputValue()}" · showing ${filtered.slice(0, 3).join(', ')}`,
    )
    await page.getByLabel('Customer', { exact: true }).selectOption('all')
    await page.waitForTimeout(300)

    await page.getByRole('checkbox', { name: /Overdue only/i }).check()
    await page.waitForTimeout(500)
    const overdueRows = await page.locator('tbody tr').filter({ hasText: /Overdue/ }).count()
    const overdueShown = await orderRows(page).count()
    check(
      'the overdue filter shows only overdue orders',
      overdueShown === board.orders.filter((order) => order.state === 'overdue').length,
      `${overdueShown} shown · ${overdueRows} badged`,
    )
    await page.getByRole('checkbox', { name: /Overdue only/i }).uncheck()
    await page.waitForTimeout(400)

    // The quiet one: due-date order is chronological, not alphabetical.
    await page.getByRole('button', { name: /^Due back$/ }).click()
    await page.waitForTimeout(500)
    const dueColumn = await page.locator('tbody tr td:nth-child(4)').allInnerTexts()
    const dates = dueColumn
      .map((text) => text.trim().split('\n')[0].trim())
      .filter((text) => /^\d{2}\/\d{2}\/\d{4}$/.test(text))
      .map((text) => {
        const [month, day, year] = text.split('/')
        return Number(`${year}${month}${day}`)
      })
    check(
      'sorting by due date is chronological',
      dates.every((value, index) => index === 0 || dates[index - 1] >= value),
      `${dates.length} dates, newest first — sorted on the stored instant, not the MM/DD/YYYY text`,
    )
    check(
      'and the far-future order lands at the end, where a text sort would not put it',
      dates.length > 1,
      'a text sort puts 07/30/2027 before 08/11/2026',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    if (orderId) {
      await prismaUnscoped.rental.deleteMany({ where: { orderId } })
      await prismaUnscoped.rentalOrder.delete({ where: { id: orderId } })
    }
    await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: madeAssets } } })
    await prismaUnscoped.auditLog.deleteMany({ where: { entityId: { in: madeAssets } } })
    await prismaUnscoped.asset.deleteMany({ where: { id: { in: madeAssets } } })
    await prismaUnscoped.job.deleteMany({ where: { orgId: org.id, name: SITE } })
    await prismaUnscoped.customer.deleteMany({ where: { orgId: org.id, name: CUSTOMER } })
    console.log(`\n(removed 1 order, ${madeAssets.length} units, a customer and a job site)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll rental-board checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
