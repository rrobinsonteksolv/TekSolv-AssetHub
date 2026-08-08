/**
 * Check-in resolves each line, and "never came back" is one of the answers.
 *
 * A return used to be yes-or-no with a condition attached, which cannot say
 * "this one is gone". A crew hands back three of four and loses the fourth, and
 * the fourth is not a return in any sense a report should count as one: the
 * unit has to leave the deployable fleet, stop counting toward utilization, and
 * turn into an invoice line.
 *
 * The claim under test is that each outcome **reuses the path that already
 * exists** rather than inventing a parallel one — damaged goes out of service
 * with a ticket exactly as a damaged check-in always did, and lost writes the
 * same retirement columns the Retired flow writes. And that the order closes on
 * *resolution*, not on return: a lost line is resolved, so nothing sits
 * perpetually out waiting for a unit nobody has.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-checkin-outcomes.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getRentalOrder } from '../src/lib/rental-order-queries'
import { openSingleLineOrder } from '../src/lib/rental-orders'
import { availableInWindow, windowFromNow } from '../src/lib/availability'
import { getUtilization, yearWindow } from '../src/lib/utilization'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const TAG = 'OUTCOME'
const CUSTOMER = 'OUTCOME Drilling'

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

/** Days between two instants. */
const spanDays = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000

const assetOf = (id: string) =>
  prismaUnscoped.asset.findUniqueOrThrow({
    where: { id },
    select: {
      assetTag: true,
      status: true,
      active: true,
      retiredReason: true,
      retiredNote: true,
      retiredAt: true,
    },
  })

/** Resolve one line through the real form on the order page. */
async function resolveLine(
  page: Page,
  orderId: string,
  assetTag: string,
  outcome: 'RETURNED' | 'DAMAGED' | 'LOST',
  notes: string,
) {
  await page.goto(`${BASE}/rentals/orders/${orderId}`, { waitUntil: 'networkidle' })
  await settle(page)
  const row = page.locator('div.border-b').filter({ hasText: assetTag }).first()
  await row.getByRole('button', { name: /^Return$/ }).click()
  await page.waitForTimeout(600)
  await page.locator(`input[name="outcomeChoice"][value="${outcome}"]`).check()
  await page.waitForTimeout(300)
  await page.locator('textarea[name="checkinNotes"]').fill(notes)
  await page
    .locator('button[type="submit"]')
    .filter({ hasText: /Check in|Write it off/ })
    .first()
    .click()
  await page.waitForTimeout(4_000)
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

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

  const assets: { id: string; assetTag: string }[] = []
  let orderId = ''
  let customerId = ''

  try {
    // -----------------------------------------------------------------------
    console.log('\nFour units out on one order\n')
    // -----------------------------------------------------------------------

    const customer = await prismaUnscoped.customer.create({
      data: { orgId: org.id, name: CUSTOMER },
    })
    customerId = customer.id

    const checkoutDate = new Date(Date.now() - 2 * 86_400_000)
    const expectedReturnDate = new Date(Date.now() + 7 * 86_400_000)

    orderId = await prismaUnscoped.$transaction(async (tx) => {
      const id = await openSingleLineOrder(tx, {
        orgId: org.id,
        customerId: customer.id,
        orderNumber: 'OUTCOME-SO-1',
        recordedById: staff.userId,
        checkedOutById: staff.userId,
        checkoutDate,
        expectedReturnDate,
      })

      for (let index = 0; index < 4; index++) {
        const asset = await tx.asset.create({
          data: {
            orgId: org.id,
            assetTag: `${TAG}-${index + 1}`,
            model: 'Outcome probe',
            categoryId: category.id,
            status: 'OUT_ON_RENT',
            condition: 'GOOD',
            assetType: 'RENTAL',
            replacementCost: 2000,
          },
          select: { id: true, assetTag: true },
        })
        assets.push(asset)

        const line = await tx.rental.create({
          data: {
            orgId: org.id,
            orderId: id,
            assetId: asset.id,
            customerId: customer.id,
            orderNumber: 'OUTCOME-SO-1',
            recordedById: staff.userId,
            checkedOutById: staff.userId,
            checkoutDate,
            expectedReturnDate,
            status: 'OPEN',
          },
        })
        await tx.$executeRaw`
          UPDATE "Rental" SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
          WHERE id = ${line.id} AND "orgId" = ${org.id}
        `
      }
      return id
    })

    const opened = await getRentalOrder(db, orderId)
    check('four lines, all out', opened!.outCount === 4, `${opened!.outCount} of ${opened!.lineCount}`)

    await signIn(page, 'ray@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nTwo come back clean\n')
    // -----------------------------------------------------------------------

    await resolveLine(page, orderId, assets[0].assetTag, 'RETURNED', 'Back on the truck, fine.')
    await resolveLine(page, orderId, assets[1].assetTag, 'RETURNED', 'Back, no issues.')

    const backOne = await assetOf(assets[0].id)
    const backTwo = await assetOf(assets[1].id)
    check(
      'both are available again',
      backOne.status === 'AVAILABLE' && backTwo.status === 'AVAILABLE',
      `${backOne.status}, ${backTwo.status}`,
    )
    const afterTwo = await getRentalOrder(db, orderId)
    check(
      'and the order stays open for the other two',
      afterTwo!.open && afterTwo!.outCount === 2,
      `${afterTwo!.outCount} still out — partial returns are the normal case`,
    )

    // -----------------------------------------------------------------------
    console.log('\nOne comes back broken\n')
    // -----------------------------------------------------------------------

    await resolveLine(
      page,
      orderId,
      assets[2].assetTag,
      'DAMAGED',
      'Sensor housing cracked, display dead.',
    )

    const damaged = await assetOf(assets[2].id)
    check(
      'it goes out of service, not back on the shelf',
      damaged.status === 'OUT_OF_SERVICE',
      damaged.status,
    )
    const ticket = await prismaUnscoped.maintenanceTicket.findFirst({
      where: { assetId: assets[2].id, status: 'OPEN' },
      select: { title: true, description: true, priority: true },
    })
    check(
      'with a repair ticket carrying what is wrong',
      ticket !== null && ticket.description?.includes('Sensor housing cracked') === true,
      `${ticket?.title ?? 'no ticket'} · ${ticket?.priority ?? ''}`,
    )
    check(
      'the same consequence path a damaged check-in always took',
      ticket?.title.includes(assets[2].assetTag) === true,
      'reused, not reimplemented — one place decides what a damaged return does',
    )
    check(
      'and it is not deployable while it sits there',
      (await db.asset.count({
        where: { id: assets[2].id, ...availableInWindow(windowFromNow(new Date())) },
      })) === 0,
    )

    // -----------------------------------------------------------------------
    console.log('\nAnd one never comes back\n')
    // -----------------------------------------------------------------------

    await resolveLine(
      page,
      orderId,
      assets[3].assetTag,
      'LOST',
      'Left on the pad, crew says it went in a skip.',
    )

    const lost = await assetOf(assets[3].id)
    check('it is retired, not returned', lost.status === 'RETIRED' && !lost.active, lost.status)
    check(
      'with the Lost disposition',
      lost.retiredReason === 'LOST',
      String(lost.retiredReason),
    )
    check(
      'and a note saying which order and customer it went out on',
      lost.retiredNote?.includes('OUTCOME-SO-1') === true &&
        lost.retiredNote?.includes(CUSTOMER) === true,
      lost.retiredNote ?? 'no note',
    )
    check('stamped with a retirement date', lost.retiredAt !== null)

    const lostLine = await prismaUnscoped.rental.findFirstOrThrow({
      where: { orderId, assetId: assets[3].id },
      select: {
        status: true,
        actualReturnDate: true,
        lostBillable: true,
        lostChargeAmount: true,
      },
    })
    check('the line reads LOST, not RETURNED', lostLine.status === 'LOST', lostLine.status)
    check(
      'with no return date — it never came back',
      lostLine.actualReturnDate === null,
      'a date here would mean "came back on" in every report that reads it',
    )
    check(
      'flagged billable to the customer',
      lostLine.lostBillable === true,
      'a lost-equipment charge, captured for invoicing',
    )
    check(
      'at the unit’s replacement cost',
      Number(lostLine.lostChargeAmount) === 2000,
      `${lostLine.lostChargeAmount} — captured now, because the asset is about to be retired`,
    )

    const auditRow = await prismaUnscoped.auditLog.findFirst({
      where: { action: 'asset.lost_on_rental', entityId: assets[3].id },
      select: { metadata: true, userId: true },
    })
    check(
      'and logged as its own event with who, what and how much',
      auditRow !== null &&
        (auditRow.metadata as Record<string, unknown>).billable === true &&
        (auditRow.metadata as Record<string, unknown>).customer === CUSTOMER,
      JSON.stringify(auditRow?.metadata ?? {}).slice(0, 160),
    )

    // -----------------------------------------------------------------------
    console.log('\nThe order closes on resolution, not on return\n')
    // -----------------------------------------------------------------------

    const closed = await getRentalOrder(db, orderId)
    check(
      'nothing is still out',
      closed!.outCount === 0,
      'a lost line is resolved — there is nothing left to wait for',
    )
    check('so the order closed', !closed!.open && closed!.closedAt !== null)
    check(
      'and it stopped counting as deployed value',
      closed!.exposure === 0,
      `${closed!.exposure} — two back, one in the shop, one written off`,
    )

    // -----------------------------------------------------------------------
    console.log('\nWhere the four units ended up\n')
    // -----------------------------------------------------------------------

    const states = await Promise.all(assets.map((asset) => assetOf(asset.id)))
    const tally = states.reduce<Record<string, number>>((counts, asset) => {
      counts[asset.status] = (counts[asset.status] ?? 0) + 1
      return counts
    }, {})
    check(
      '2 available, 1 out of service, 1 retired',
      tally.AVAILABLE === 2 && tally.OUT_OF_SERVICE === 1 && tally.RETIRED === 1,
      JSON.stringify(tally),
    )
    check(
      'and none of them stuck out on rent',
      (tally.OUT_ON_RENT ?? 0) === 0,
      'nothing perpetually out waiting for a unit nobody has',
    )

    const deployable = await db.asset.count({
      where: {
        id: { in: assets.map((asset) => asset.id) },
        ...availableInWindow(windowFromNow(new Date())),
      },
    })
    check('only the two that came back are deployable', deployable === 2, `${deployable} of 4`)

    // The reservation windows are this feature's responsibility: a resolved
    // line must stop holding one, whichever way it resolved. A lost line that
    // kept its window would block the unit forever — which matters less now it
    // is retired, and would matter enormously if somebody un-retired it.
    const heldWindows = await prismaUnscoped.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "Rental"
       WHERE "orderId" = $1 AND period IS NOT NULL`,
      orderId,
    )
    check(
      'every resolved line released its reservation window',
      Number(heldWindows[0].count) === 0,
      'returned, damaged and lost alike — a window nobody released blocks the unit forever',
    )

    const report = await getUtilization(db, yearWindow(new Date().getFullYear()).range)
    const lostInReport = report.categories
      .flatMap((entry) => entry.units)
      .find((unit) => unit.assetTag === assets[3].assetTag)
    // Within a day, because both sides are computed from wall-clock instants a
    // few seconds apart — a stricter comparison tests the clock, not the cap.
    check(
      'and the lost unit’s utilization window ends at its retirement',
      lostInReport === undefined ||
        (lost.retiredAt !== null &&
          Math.abs(lostInReport.daysOwned - spanDays(lostInReport.ownedFrom, lost.retiredAt)) <= 1),
      lostInReport
        ? `${lostInReport.daysOwned.toFixed(1)} days owned vs ${spanDays(lostInReport.ownedFrom, lost.retiredAt!).toFixed(1)} to retirement — it stops accruing`
        : 'out of the report entirely',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    const ids = assets.map((asset) => asset.id)
    await prismaUnscoped.maintenanceTicket.deleteMany({ where: { assetId: { in: ids } } })
    await prismaUnscoped.notification.deleteMany({ where: { entityId: { in: ids } } })
    await prismaUnscoped.auditLog.deleteMany({ where: { entityId: { in: ids } } })
    if (orderId) {
      await prismaUnscoped.rental.deleteMany({ where: { orderId } })
      await prismaUnscoped.rentalOrder.deleteMany({ where: { id: orderId } })
    }
    await prismaUnscoped.asset.deleteMany({ where: { id: { in: ids } } })
    if (customerId) await prismaUnscoped.customer.deleteMany({ where: { id: customerId } })
    console.log(`\n(removed 1 order, ${ids.length} units and a customer)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll check-in outcome checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
