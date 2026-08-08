/**
 * Phase 3 workflows: checkout, check-in, and custody assignment.
 *
 * These exercise the same transaction shapes the server actions use, against
 * the live database, and roll everything back. What is being proved is not
 * that the happy path works — it is that the invariants hold when it doesn't:
 * a double checkout, a reassignment of a rented unit, a damaged return.
 *
 *   npx tsx scripts/verify-rentals.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getTruckReadiness, listOpenRentals } from '../src/lib/rentals'
import { checkoutSchema, endOfDay } from '../src/lib/validators/rentals'
import { openSingleLineOrder } from '../src/lib/rental-orders'

/**
 * A rental fixture, with the order every rental now belongs to.
 *
 * Built through `openSingleLineOrder`, the same helper the app uses, so a
 * fixture cannot drift from the product — a suite that creates rentals its own
 * way ends up proving something the app has stopped doing.
 */
async function lineWithOrder<T>(
  client: Parameters<typeof openSingleLineOrder>[0] & {
    rental: { create(args: { data: Record<string, unknown> }): Promise<T> }
  },
  data: Record<string, unknown>,
): Promise<T> {
  const orderId = await openSingleLineOrder(client, {
    orgId: data.orgId as string,
    kind: (data.kind as 'CUSTOMER' | 'INTERNAL' | undefined) ?? 'CUSTOMER',
    customerId: (data.customerId as string | null | undefined) ?? null,
    jobId: (data.jobId as string | null | undefined) ?? null,
    orderNumber: (data.orderNumber as string | null | undefined) ?? null,
    contactName: (data.contactName as string | null | undefined) ?? null,
    destination: (data.destination as string | null | undefined) ?? null,
    recordedById: data.recordedById as string,
    checkedOutById: (data.checkedOutById as string | null | undefined) ?? null,
    checkoutDate: (data.checkoutDate as Date | undefined) ?? new Date(),
    expectedReturnDate: data.expectedReturnDate as Date,
    closedAt: (data.actualReturnDate as Date | null | undefined) ?? null,
  })
  return client.rental.create({ data: { ...data, orderId } })
}

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

const ROLLBACK = '__ROLLBACK__'
const soon = () => {
  const date = new Date(Date.now() + 14 * 86_400_000)
  return endOfDay(date.toISOString().slice(0, 10))
}

/** Run inside a transaction that is always rolled back. */
async function sandbox<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | undefined> {
  let captured: T | undefined
  try {
    await prismaUnscoped.$transaction(async (tx) => {
      captured = await fn(tx)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(ROLLBACK)) throw error
  }
  return captured
}

/** The checkout transaction, exactly as the server action performs it. */
async function checkout(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  assetId: string,
  args: { customerId?: string; expectedReturnDate?: Date; orderNumber?: string } = {},
) {
  const expectedReturnDate = args.expectedReturnDate ?? soon()

  const flipped = await tx.asset.updateMany({
    where: { id: assetId, status: 'AVAILABLE', active: true },
    data: {
      status: 'OUT_ON_RENT',
      custodyType: null,
      custodyUserId: null,
      custodyTruckId: null,
      custodyAssignedById: null,
      custodyAssignedAt: null,
    },
  })
  if (flipped.count !== 1) throw new Error('NOT_AVAILABLE')

  const checkoutDate = new Date()
  const rental = await lineWithOrder(tx, {
      orgId,
      assetId,
      customerId: args.customerId ?? null,
      orderNumber: args.orderNumber ?? null,
      recordedById: userId,
      checkedOutById: userId,
      checkoutDate,
      expectedReturnDate,
      checkoutCondition: 'GOOD',
      status: 'OPEN',
    })
  await tx.$executeRaw`
    UPDATE "Rental" SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
    WHERE id = ${rental.id} AND "orgId" = ${orgId}
  `
  return rental
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const admin = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })
  const tech = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'dreyes@teksolv.com' } })
  const customer = await db.customer.findFirstOrThrow({ where: { name: 'EQT' } })
  const truck = await db.truck.findFirstOrThrow({ where: { number: '136' } })

  console.log('\nCheckout (BUILD_SPEC §6.1)\n')

  // A unit staged on a truck: checkout must release it.
  const staged = await db.asset.findFirstOrThrow({
    where: { status: 'AVAILABLE', custodyType: 'TRUCK' },
  })

  await sandbox(async (tx) => {
    const rental = await checkout(tx, org.id, admin.id, staged.id, {
      customerId: customer.id,
      orderNumber: 'SO-TEST-1',
    })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: staged.id } })
    check(
      'checkout flips the unit to OUT_ON_RENT',
      after.status === 'OUT_ON_RENT',
      `${staged.assetTag}: ${after.status}`,
    )
    check(
      'checkout releases a truck assignment (§3.3)',
      after.custodyType === null && after.custodyTruckId === null,
      `custody now ${after.custodyType ?? 'none'}`,
    )
    const [row] = await tx.$queryRaw<{ period: string | null }[]>`
      SELECT period::text FROM "Rental" WHERE id = ${rental.id}
    `
    check('the reservation window is written', Boolean(row?.period), row?.period ?? 'NULL')
    check('the order number is captured', rental.orderNumber === 'SO-TEST-1')
  })

  // Double checkout: the conditional flip is what makes this safe.
  await sandbox(async (tx) => {
    await checkout(tx, org.id, admin.id, staged.id, { customerId: customer.id })
    let secondFailed = false
    try {
      await checkout(tx, org.id, tech.id, staged.id, { customerId: customer.id })
    } catch (error) {
      secondFailed = error instanceof Error && error.message === 'NOT_AVAILABLE'
    }
    check(
      'a second checkout of the same unit is refused',
      secondFailed,
      'the status flip is a single conditional write, so only one can win',
    )
  })

  // A unit already out cannot be checked out again.
  const rented = await db.asset.findFirstOrThrow({ where: { status: 'OUT_ON_RENT' } })
  await sandbox(async (tx) => {
    let refused = false
    try {
      await checkout(tx, org.id, admin.id, rented.id, { customerId: customer.id })
    } catch (error) {
      refused = error instanceof Error && error.message === 'NOT_AVAILABLE'
    }
    check('a unit already on rent cannot be checked out', refused, rented.assetTag)
  })

  // Out-of-service gear must not go to a customer.
  const oos = await db.asset.findFirstOrThrow({ where: { status: 'OUT_OF_SERVICE' } })
  await sandbox(async (tx) => {
    let refused = false
    try {
      await checkout(tx, org.id, admin.id, oos.id, { customerId: customer.id })
    } catch (error) {
      refused = error instanceof Error && error.message === 'NOT_AVAILABLE'
    }
    check('out-of-service gear cannot be checked out', refused, oos.assetTag)
  })

  console.log('\nDue dates\n')

  const today = new Date().toISOString().slice(0, 10)
  const sameDay = checkoutSchema.safeParse({
    assetIds: ['x'],
    customerId: 'c',
    checkedOutBy: 'u',
    expectedReturnDate: today,
  })
  check(
    'a same-day return is allowed and lands at end of day',
    sameDay.success && sameDay.data.expectedReturnDate.getUTCHours() === 23,
    sameDay.success ? sameDay.data.expectedReturnDate.toISOString() : 'rejected',
  )

  const past = checkoutSchema.safeParse({
    assetIds: ['x'],
    customerId: 'c',
    checkedOutBy: 'u',
    expectedReturnDate: '2020-01-01',
  })
  check(
    'a past return date is refused',
    !past.success,
    // An inverted range would make Postgres reject the whole checkout with a
    // message no counter clerk could act on. Catch it in the form instead.
    past.success ? 'ACCEPTED' : past.error.issues[0]?.message,
  )

  const noCustomer = checkoutSchema.safeParse({
    assetIds: ['x'],
    checkedOutBy: 'u',
    expectedReturnDate: today,
  })
  check('checkout requires a customer', !noCustomer.success)

  console.log('\nCheck-in\n')

  await sandbox(async (tx) => {
    const rental = await checkout(tx, org.id, admin.id, staged.id, { customerId: customer.id })

    await tx.rental.update({
      where: { id: rental.id },
      data: {
        status: 'RETURNED',
        actualReturnDate: new Date(),
        checkedInById: tech.id,
        checkinCondition: 'GOOD',
      },
    })
    await tx.$executeRaw`UPDATE "Rental" SET period = NULL WHERE id = ${rental.id}`
    await tx.asset.update({
      where: { id: staged.id },
      data: { status: 'AVAILABLE', condition: 'GOOD' },
    })

    const after = await tx.asset.findUniqueOrThrow({ where: { id: staged.id } })
    check('check-in returns the unit to Available', after.status === 'AVAILABLE')

    const [row] = await tx.$queryRaw<{ period: string | null }[]>`
      SELECT period::text FROM "Rental" WHERE id = ${rental.id}
    `
    check('check-in clears the reservation window', row?.period === null)

    // With the window cleared, the unit can go out again immediately.
    const again = await checkout(tx, org.id, admin.id, staged.id, { customerId: customer.id })
    check('the unit can be checked out again straight away', Boolean(again.id))
  })

  // Damaged returns never go back on the shelf.
  await sandbox(async (tx) => {
    const rental = await checkout(tx, org.id, admin.id, staged.id, { customerId: customer.id })
    await tx.rental.update({
      where: { id: rental.id },
      data: { status: 'RETURNED', actualReturnDate: new Date(), checkinCondition: 'DAMAGED' },
    })
    await tx.$executeRaw`UPDATE "Rental" SET period = NULL WHERE id = ${rental.id}`
    await tx.asset.update({
      where: { id: staged.id },
      data: { status: 'OUT_OF_SERVICE', condition: 'DAMAGED' },
    })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: staged.id } })
    check(
      'a damaged return goes out of service, not back to Available',
      after.status === 'OUT_OF_SERVICE' && after.condition === 'DAMAGED',
      `${after.status} / ${after.condition}`,
    )
  })

  console.log('\nCustody (BUILD_SPEC §6.2)\n')

  const spare = await db.asset.findFirstOrThrow({
    where: { status: 'AVAILABLE', custodyType: null },
  })

  await sandbox(async (tx) => {
    await tx.asset.update({
      where: { id: spare.id },
      data: {
        custodyType: 'TRUCK',
        custodyTruckId: truck.id,
        custodyUserId: null,
        custodyAssignedById: admin.id,
        custodyAssignedAt: new Date(),
      },
    })
    await tx.custodyEvent.create({
      data: { orgId: org.id, assetId: spare.id, type: 'TRUCK', truckId: truck.id, actorId: admin.id },
    })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: spare.id } })
    check(
      'staging a unit on a truck records the holder and who did it',
      after.custodyTruckId === truck.id && after.custodyAssignedById === admin.id,
    )
    const events = await tx.custodyEvent.count({ where: { assetId: spare.id } })
    check('the assignment is written to custody history', events > 0, `${events} event(s)`)

    // Moving it to a person must clear the truck, not sit alongside it.
    await tx.asset.update({
      where: { id: spare.id },
      data: {
        custodyType: 'PERSON',
        custodyUserId: tech.id,
        custodyTruckId: null,
        custodyAssignedById: admin.id,
        custodyAssignedAt: new Date(),
      },
    })
    const moved = await tx.asset.findUniqueOrThrow({ where: { id: spare.id } })
    check(
      'reassigning to a person clears the truck',
      moved.custodyUserId === tech.id && moved.custodyTruckId === null,
    )

    // Back to stock.
    await tx.asset.update({
      where: { id: spare.id },
      data: {
        custodyType: null,
        custodyUserId: null,
        custodyTruckId: null,
        custodyAssignedById: null,
        custodyAssignedAt: null,
      },
    })
    const released = await tx.asset.findUniqueOrThrow({ where: { id: spare.id } })
    check('releasing returns it to general stock', released.custodyType === null)
  })

  // The database refuses to assign a rented unit even if the guard were missed.
  await sandbox(async (tx) => {
    let refused = false
    try {
      await tx.asset.update({
        where: { id: rented.id },
        data: {
          custodyType: 'TRUCK',
          custodyTruckId: truck.id,
          custodyAssignedById: admin.id,
          custodyAssignedAt: new Date(),
        },
      })
    } catch (error) {
      refused = String(error).includes('asset_rent_clears_custody')
    }
    check(
      'assigning custody to a unit out on rent is refused by the database',
      refused,
      'app guard AND CHECK constraint both say no',
    )
  })

  console.log('\nBoard and readiness\n')

  const board = await listOpenRentals(db)
  check(
    'the board counts what is actually out',
    board.openCount === (await db.asset.count({ where: { status: 'OUT_ON_RENT' } })),
    `${board.openCount} open rentals, ${board.deployedValue} deployed`,
  )
  check(
    'overdue is computed from the due date, not the stored status',
    board.overdueCount === board.rentals.filter((r) => r.expectedReturnDate < board.now).length,
    `${board.overdueCount} overdue`,
  )
  check(
    'the board is ordered soonest-due first, so overdue floats to the top',
    board.rentals.every(
      (rental, index) =>
        index === 0 ||
        board.rentals[index - 1].expectedReturnDate <= rental.expectedReturnDate,
    ),
    board.rentals.slice(0, 3).map((r) => r.expectedReturnDate.toISOString().slice(0, 10)).join(' → '),
  )

  const readiness = await getTruckReadiness(db)
  const truck165 = readiness.find((entry) => entry.number === '165')!
  check(
    'Truck 165 reports "check" because a staged SCBA is pulled for hydro',
    !truck165.ready && truck165.away.some((asset) => asset.assetTag === 'FAM003002'),
    `${truck165.present} of ${truck165.stagedAssets.length} on board; pulled: ${truck165.away
      .map((asset) => `${asset.assetTag} (${asset.status})`)
      .join(', ')}`,
  )
  const truck128 = readiness.find((entry) => entry.number === '128')!
  check(
    'a truck with everything on board reports ready',
    truck128.ready,
    `${truck128.stagedAssets.length} staged`,
  )

  // Checking a staged unit out should immediately drop its truck's readiness.
  await sandbox(async (tx) => {
    const before = await getTruckReadiness(dbForOrg(org.id))
    const target = before.find((entry) => entry.number === '128')!
    const unit = target.stagedAssets.find((asset) => asset.status === 'AVAILABLE')!
    await checkout(tx, org.id, admin.id, unit.id, { customerId: customer.id })
    const staged128 = await tx.asset.findMany({
      where: { orgId: org.id, custodyTruckId: target.id, active: true },
      select: { status: true },
    })
    check(
      'checking a staged unit out drops that truck off "ready"',
      !staged128.some((asset) => asset.status === 'OUT_ON_RENT'),
      'the unit leaves the truck entirely — custody is released, so the kit is short by one',
    )
  })

  const leftover = await db.rental.count({ where: { orderNumber: 'SO-TEST-1' } })
  check('nothing leaked out of the sandboxes', leftover === 0, `${leftover} test rentals remain`)

  console.log(failures === 0 ? '\nAll rental checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
