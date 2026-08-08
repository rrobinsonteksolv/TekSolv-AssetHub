/**
 * Phase 4b: advance reservations (BUILD_SPEC §6.6).
 *
 * The claim being tested is narrow and load-bearing: **a reservation holds a
 * window, not a unit.** Everything below is an attempt to break that in one of
 * the two directions it can fail —
 *
 *   • too loose: a booking that doesn't actually stop a double-booking, or a
 *     RESERVED row that reserves nothing because its range was never written;
 *   • too tight: a reserved unit that can no longer go out today even though
 *     it comes back before the booking starts, which is the exact behaviour
 *     that made a status flag the wrong design in the first place.
 *
 * Everything runs against the live database inside transactions that are
 * always rolled back.
 *
 *   npx tsx scripts/verify-reservations.ts
 */
import 'dotenv/config'
import type { Prisma, Role } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import {
  BLOCKING_RENTAL_STATUSES,
  availableInWindow,
  describeConflict,
  listPickableAssets,
  windowFromNow,
} from '../src/lib/availability'
import { listReservations } from '../src/lib/reservations'
import { resolveOrgPermissions } from '../src/lib/org-permissions'
import { can } from '../src/lib/rbac'
import { isReservationConflict } from '../src/lib/errors'
import { endOfDay, reserveSchema, startOfDay } from '../src/lib/validators/rentals'
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
const ROLLBACK = '__ROLLBACK__'
const DAY = 86_400_000

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

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

/** `days` from now, snapped to the start of that day. */
const day = (days: number) => startOfDay(new Date(Date.now() + days * DAY).toISOString().slice(0, 10))
/** `days` from now, snapped to the end of that day. */
const until = (days: number) => endOfDay(new Date(Date.now() + days * DAY).toISOString().slice(0, 10))

/** The reserve transaction, exactly as the server action performs it. */
async function reserve(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  assetId: string,
  window: { start: Date; end: Date },
  args: { customerId?: string; withPeriod?: boolean } = {},
) {
  const reservation = await lineWithOrder(tx, {
      orgId,
      assetId,
      kind: 'CUSTOMER',
      customerId: args.customerId ?? null,
      recordedById: userId,
      checkoutDate: window.start,
      expectedReturnDate: window.end,
      status: 'RESERVED',
    })

  if (args.withPeriod !== false) {
    await tx.$executeRaw`
      UPDATE "Rental" SET period = tstzrange(${window.start}, ${window.end}, '[)')
      WHERE id = ${reservation.id} AND "orgId" = ${orgId}
    `
  }

  return reservation
}

/** The checkout transaction, as the server action performs it. */
async function checkout(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  assetId: string,
  expectedReturnDate: Date,
) {
  const flipped = await tx.asset.updateMany({
    where: { id: assetId, status: 'AVAILABLE', active: true },
    data: { status: 'OUT_ON_RENT', custodyType: null, custodyUserId: null, custodyTruckId: null },
  })
  if (flipped.count !== 1) throw new Error('NOT_AVAILABLE')

  const checkoutDate = new Date()
  const rental = await lineWithOrder(tx, {
      orgId,
      assetId,
      kind: 'CUSTOMER',
      recordedById: userId,
      checkoutDate,
      expectedReturnDate,
      status: 'OPEN',
    })
  await tx.$executeRaw`
    UPDATE "Rental" SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
    WHERE id = ${rental.id} AND "orgId" = ${orgId}
  `
  return rental
}

/** The convert-to-pickup transaction, as the server action performs it. */
async function convert(
  tx: Prisma.TransactionClient,
  orgId: string,
  reservationId: string,
  assetId: string,
  expectedReturnDate: Date,
) {
  const now = new Date()
  const claimed = await tx.rental.updateMany({
    where: { id: reservationId, status: 'RESERVED' },
    data: { status: 'OPEN', checkoutDate: now, noShowAt: null },
  })
  if (claimed.count !== 1) throw new Error('ALREADY_HANDLED')

  const flipped = await tx.asset.updateMany({
    where: { id: assetId, status: 'AVAILABLE', active: true },
    data: { status: 'OUT_ON_RENT', custodyType: null, custodyUserId: null, custodyTruckId: null },
  })
  if (flipped.count !== 1) throw new Error('NOT_ON_SHELF')

  await tx.$executeRaw`
    UPDATE "Rental" SET period = tstzrange(${now}, ${expectedReturnDate}, '[)')
    WHERE id = ${reservationId} AND "orgId" = ${orgId}
  `
  return now
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const admin = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })
  const customer = await db.customer.findFirstOrThrow({ where: { name: 'EQT' } })

  const unit = await db.asset.findFirstOrThrow({
    where: { status: 'AVAILABLE', active: true, custodyType: null },
  })

  console.log('\nThe window is what is reserved (§6.6)\n')

  // ---------------------------------------------------------------------
  // Too loose? Prove the constraint actually stops a double-booking.
  // ---------------------------------------------------------------------
  await sandbox(async (tx) => {
    await reserve(tx, org.id, admin.id, unit.id, { start: day(10), end: until(17) }, {
      customerId: customer.id,
    })

    let rejected = false
    try {
      // Straddles the booking: starts before it, ends inside it.
      await reserve(tx, org.id, admin.id, unit.id, { start: day(14), end: until(20) })
    } catch (error) {
      rejected = isReservationConflict(error)
      if (!rejected) throw error
    }
    check('an overlapping reservation is refused by the database (23P01)', rejected)
  })

  await sandbox(async (tx) => {
    await reserve(tx, org.id, admin.id, unit.id, { start: day(3), end: until(30) })

    let rejected = false
    try {
      // A checkout today runs [now, +40d) and swallows the booking whole.
      await checkout(tx, org.id, admin.id, unit.id, until(40))
    } catch (error) {
      rejected = isReservationConflict(error)
      if (!rejected) throw error
    }
    check('a checkout that would run through a booking is refused', rejected)
  })

  // The loophole the deferred trigger exists to close: a RESERVED row with no
  // range looks like a booking on every screen and blocks nothing at all.
  {
    let refused = false
    try {
      await prismaUnscoped.$transaction(async (tx) => {
        await reserve(tx, org.id, admin.id, unit.id, { start: day(5), end: until(9) }, {
          withPeriod: false,
        })
      })
    } catch (error) {
      refused = (error as { meta?: { code?: string } })?.meta?.code === '23514' ||
        (error as { code?: string })?.code === '23514' ||
        String((error as Error)?.message ?? '').includes('carries no reservation period')
    }
    check('a RESERVED row with no period is refused at COMMIT', refused)
  }

  // ---------------------------------------------------------------------
  // Too tight? Prove a reservation does NOT take the unit off the shelf.
  // ---------------------------------------------------------------------
  console.log('\nA reserved unit is still available today (§6.6)\n')

  await sandbox(async (tx) => {
    await reserve(tx, org.id, admin.id, unit.id, { start: day(20), end: until(27) }, {
      customerId: customer.id,
    })

    const asset = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'reserving does not change the asset status',
      asset.status === 'AVAILABLE',
      `${unit.assetTag}: ${asset.status}`,
    )
    check('reserving does not touch custody', asset.custodyType === null)

    // The case a status flag gets wrong: out today, back before the booking.
    const rental = await checkout(tx, org.id, admin.id, unit.id, until(5))
    check('the same unit can still go out on a rental that ends first', Boolean(rental.id))
  })

  // Touching windows: one ends exactly as the next begins. The '[)' bounds
  // mean these do not overlap — the handover-day case.
  await sandbox(async (tx) => {
    const boundary = day(12)
    await reserve(tx, org.id, admin.id, unit.id, { start: day(5), end: boundary })
    const second = await reserve(tx, org.id, admin.id, unit.id, { start: boundary, end: until(19) })
    check('back-to-back bookings that merely touch do not conflict', Boolean(second.id))
  })

  // ---------------------------------------------------------------------
  // Pickers agree with the constraint.
  // ---------------------------------------------------------------------
  console.log('\nWindow-aware pickers (§6.6)\n')

  check(
    'RESERVED is in the blocking set the pickers use',
    BLOCKING_RENTAL_STATUSES.includes('RESERVED'),
    BLOCKING_RENTAL_STATUSES.join(', '),
  )

  await sandbox(async (tx) => {
    await reserve(tx, org.id, admin.id, unit.id, { start: day(10), end: until(17) }, {
      customerId: customer.id,
    })

    // listPickableAssets goes through the scoped client, which is a different
    // connection from `tx` — so the assertions run on the raw where-fragment
    // against this transaction instead.
    const clashing = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow({ start: day(12), end: until(14) }) },
    })
    check('a unit is not offered for a window inside its booking', clashing === 0)

    const earlier = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow({ start: day(1), end: until(4) }) },
    })
    check('the same unit IS offered for a window before its booking', earlier === 1)

    const later = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow({ start: day(25), end: until(30) }) },
    })
    check('the same unit IS offered for a window after its booking', later === 1)
  })

  // The picker's context hints, on committed data.
  {
    const pickable = await listPickableAssets(db, { start: day(1), end: until(4) }, { take: 500 })
    check(
      'the picker returns units and carries their upcoming-booking context',
      pickable.length > 0 && pickable.every((asset) => Array.isArray(asset.upcoming)),
      `${pickable.length} pickable`,
    )

    // Physical presence is a question about *now*. A unit whose rental is
    // overdue overlaps no window starting now — its window closed — but it is
    // still on a customer's site, so a checkout picker must not offer it.
    const outNow = await db.asset.count({ where: { status: 'OUT_ON_RENT', active: true } })
    const today = await listPickableAssets(db, windowFromNow(until(4)), { take: 500 })
    check(
      'a unit that is physically out is never offered for a window starting now',
      today.every((asset) => asset.status !== 'OUT_ON_RENT'),
      `${outNow} units currently out, ${today.length} offered`,
    )

    // …and the same unit is fair game for a window after it is due back.
    const overdue = await db.rental.findFirst({
      where: { status: { in: ['OPEN', 'OVERDUE'] }, expectedReturnDate: { lt: new Date() } },
      select: { assetId: true },
    })
    if (overdue) {
      check(
        'an overdue unit is still bookable for a window in the future',
        pickable.some((asset) => asset.id === overdue.assetId),
        'it is expected back, so a future window is a fair bet',
      )
    } else {
      check('an overdue unit is still bookable for a window in the future', true, 'nothing overdue — skipped')
    }
  }

  // ---------------------------------------------------------------------
  // Convert, cancel, no-show.
  // ---------------------------------------------------------------------
  console.log('\nPickup, cancellation, and no-shows (§6.6)\n')

  await sandbox(async (tx) => {
    const reservation = await reserve(tx, org.id, admin.id, unit.id, {
      start: day(2),
      end: until(9),
    })
    const pickedUpAt = await convert(tx, org.id, reservation.id, unit.id, until(9))

    const after = await tx.rental.findUniqueOrThrow({ where: { id: reservation.id } })
    const asset = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })

    check('convert flips the reservation to OPEN', after.status === 'OPEN', after.status)
    check('convert takes the unit off the shelf', asset.status === 'OUT_ON_RENT', asset.status)
    check(
      'convert re-stamps checkoutDate to the real pickup time',
      Math.abs(after.checkoutDate.getTime() - pickedUpAt.getTime()) < 1000,
      `planned ${day(2).toISOString()} → actual ${after.checkoutDate.toISOString()}`,
    )

    // The conditional write is what makes a race safe: the second attempt
    // finds nothing in RESERVED and loses.
    let lost = false
    try {
      await convert(tx, org.id, reservation.id, unit.id, until(9))
    } catch (error) {
      lost = (error as Error).message === 'ALREADY_HANDLED'
      if (!lost) throw error
    }
    check('a second convert of the same booking loses the race', lost)
  })

  await sandbox(async (tx) => {
    const reservation = await reserve(tx, org.id, admin.id, unit.id, {
      start: day(10),
      end: until(17),
    })

    await tx.rental.updateMany({
      where: { id: reservation.id, status: 'RESERVED' },
      data: { status: 'CANCELLED' },
    })
    await tx.$executeRaw`UPDATE "Rental" SET period = NULL WHERE id = ${reservation.id}`

    // The window is free the instant it is cancelled — someone else can book
    // the very same dates.
    const rebooked = await reserve(tx, org.id, admin.id, unit.id, {
      start: day(10),
      end: until(17),
    })
    check('cancelling frees the window immediately', Boolean(rebooked.id))

    const asset = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check('cancelling leaves the asset untouched', asset.status === 'AVAILABLE', asset.status)
  })

  await sandbox(async (tx) => {
    // A booking whose start has already passed, still on the shelf.
    const reservation = await reserve(tx, org.id, admin.id, unit.id, {
      start: day(-3),
      end: until(4),
    })

    const first = await tx.rental.updateMany({
      where: { id: reservation.id, status: 'RESERVED', noShowAt: null },
      data: { noShowAt: new Date() },
    })
    const second = await tx.rental.updateMany({
      where: { id: reservation.id, status: 'RESERVED', noShowAt: null },
      data: { noShowAt: new Date() },
    })
    check('the no-show sweep stamps a stale booking once', first.count === 1)
    check('re-running the sweep stamps nothing again (idempotent)', second.count === 0)

    // Collected late: converting clears the flag rather than carrying it into
    // the rental's history.
    await convert(tx, org.id, reservation.id, unit.id, until(4))
    const after = await tx.rental.findUniqueOrThrow({ where: { id: reservation.id } })
    check('a late pickup clears the no-show flag', after.noShowAt === null)
  })

  // The board's own no-show count, computed from dates rather than the column.
  {
    const { reservedCount, noShowCount } = await listReservations(db)
    check(
      'the reservation board reports counts without throwing',
      Number.isInteger(reservedCount) && Number.isInteger(noShowCount),
      `${reservedCount} reserved, ${noShowCount} not collected`,
    )
  }

  // ---------------------------------------------------------------------
  // The conflict message a clerk actually reads.
  // ---------------------------------------------------------------------
  console.log('\nConflicts explained, not raised (§6.6)\n')

  {
    const out = await db.rental.findFirst({
      where: { status: { in: ['OPEN', 'OVERDUE'] } },
      select: { assetId: true, checkoutDate: true, expectedReturnDate: true },
    })
    if (out) {
      const sentence = await describeConflict(db, out.assetId, {
        start: out.checkoutDate,
        end: out.expectedReturnDate,
      })
      check(
        'a conflict is explained with the dates that clash',
        Boolean(sentence && /\d{4}-\d{2}-\d{2}/.test(sentence)),
        sentence ?? 'no sentence produced',
      )
    } else {
      check('a conflict is explained with the dates that clash', true, 'nothing out on rent — skipped')
    }

    const clear = await describeConflict(db, unit.id, { start: day(300), end: until(310) })
    check('a unit with no clash returns null rather than a made-up sentence', clear === null)
  }

  // ---------------------------------------------------------------------
  // Validation.
  // ---------------------------------------------------------------------
  console.log('\nValidation\n')

  const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
  const base = { assetIds: ['a'], customerId: 'c', startDate: iso(2), endDate: iso(9) }

  check('a well-formed reservation parses', reserveSchema.safeParse(base).success)

  const backwards = reserveSchema.safeParse({ ...base, startDate: iso(9), endDate: iso(2) })
  check(
    'a window that ends before it starts is refused',
    !backwards.success,
    backwards.success ? '' : backwards.error.issues[0]?.message,
  )

  const backdated = reserveSchema.safeParse({ ...base, startDate: iso(-5), endDate: iso(9) })
  check(
    'a reservation cannot be backdated',
    !backdated.success,
    backdated.success ? '' : backdated.error.issues[0]?.message,
  )

  const past = reserveSchema.safeParse({ ...base, startDate: iso(-9), endDate: iso(-2) })
  check('a window that has already closed is refused', !past.success)

  const empty = reserveSchema.safeParse({ ...base, assetIds: [] })
  check(
    'an empty cart is refused',
    !empty.success,
    empty.success ? '' : empty.error.issues[0]?.message,
  )

  const noCustomer = reserveSchema.safeParse({ ...base, customerId: '' })
  check('a reservation with no customer is refused', !noCustomer.success)

  const sameDay = reserveSchema.safeParse({ ...base, startDate: iso(3), endDate: iso(3) })
  check(
    'a same-day booking is a valid non-empty range',
    sameDay.success,
    sameDay.success ? '' : sameDay.error.issues[0]?.message,
  )

  // ---------------------------------------------------------------------
  // Org-configurable permissions — the RBAC seam §6.6 introduces.
  // ---------------------------------------------------------------------
  console.log('\nPer-org permissions (§6.6)\n')

  check(
    'with no overrides, reserve is supervisor+ and a tech is refused',
    can('MANAGER' as Role, 'rental.reserve') && !can('TECHNICIAN' as Role, 'rental.reserve'),
  )

  const opened = resolveOrgPermissions({
    permissions: { 'rental.reserve': ['ADMIN', 'MANAGER', 'TECHNICIAN'] },
  })
  check(
    'an org can open reserve up to technicians',
    can('TECHNICIAN' as Role, 'rental.reserve', opened),
  )
  check(
    'opening reserve does not open checkout',
    !can('TECHNICIAN' as Role, 'rental.checkout', opened),
  )

  const smuggled = resolveOrgPermissions({
    permissions: { 'user.manage': ['VIEWER'], 'rental.reserve': ['VIEWER'] },
  })
  check(
    'a non-configurable permission cannot be overridden from settings',
    !can('VIEWER' as Role, 'user.manage', smuggled),
  )
  check(
    'a role outside the allow-list is dropped, not honoured',
    !can('VIEWER' as Role, 'rental.reserve', smuggled),
  )
  check(
    'garbage in settings resolves to the static matrix',
    Object.keys(resolveOrgPermissions({ permissions: 'nope' })).length === 0 &&
      Object.keys(resolveOrgPermissions(null)).length === 0,
  )

  // ---------------------------------------------------------------------
  // Nothing escaped.
  // ---------------------------------------------------------------------
  const leaked = await db.rental.count({ where: { status: 'RESERVED', noShowAt: { not: null } } })
  const stillAvailable = await db.asset.findUniqueOrThrow({ where: { id: unit.id } })
  check(
    'nothing leaked out of the sandboxes',
    stillAvailable.status === 'AVAILABLE',
    `${unit.assetTag}: ${stillAvailable.status}, ${leaked} flagged reservations on file`,
  )

  console.log(failures === 0 ? '\nAll reservation checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
