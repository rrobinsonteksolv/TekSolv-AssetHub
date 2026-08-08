/**
 * Phase 5: maintenance schedules, the queue, tickets, and the digest sweeps.
 *
 * The claim under test is the one BUILD_SPEC §6.4 is careful about: **usage
 * hours are estimated, calendar dates are exact, and the two reset
 * differently.** Most of what follows is an attempt to break that —
 *
 *   • a calendar reset that forgets to move `nextDue` (schedule stays overdue
 *     forever, and the alert feed with it);
 *   • a usage reset that zeroes the hours but leaves the anchor (schedule
 *     never comes due again) or moves the anchor but keeps the hours (due
 *     again immediately);
 *   • an alert sweep with no claim, which re-sends every overdue schedule on
 *     every run until a supervisor stops reading the feed.
 *
 * Everything runs against the live database inside transactions that are
 * always rolled back.
 *
 *   npx tsx scripts/verify-maintenance.ts
 */
import 'dotenv/config'
// A value import, not `import type`: the fixtures below build Prisma.Decimal
// instances, which is what the schedule columns actually hold.
import { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { resolveSchedule, rentalDaysSince, DEFAULT_HOURS_PER_DAY } from '../src/lib/maintenance'
import { listMaintenanceQueue, listTickets, ACTIONABLE } from '../src/lib/maintenance-queue'
import {
  adjustUsageSchema,
  logServiceSchema,
  scheduleSchema,
  ticketSchema,
} from '../src/lib/validators/maintenance'
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

const ago = (days: number) => new Date(Date.now() - days * DAY)

/** The calendar half of the reset, exactly as the server action performs it. */
async function logCalendarService(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  performedAt: Date,
) {
  const schedule = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: scheduleId } })
  return tx.maintenanceSchedule.update({
    where: { id: scheduleId },
    data: {
      lastPerformed: performedAt,
      nextDue: schedule.intervalDays
        ? new Date(performedAt.getTime() + schedule.intervalDays * DAY)
        : null,
      alertedAt: null,
    },
  })
}

/** The usage half. Both fields move together or the estimate is wrong. */
async function logUsageService(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  performedAt: Date,
) {
  return tx.maintenanceSchedule.update({
    where: { id: scheduleId },
    data: { priorUsage: 0, usageAnchorAt: performedAt, lastPerformed: performedAt, alertedAt: null },
  })
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const admin = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })

  // Ordered, and with no rental history of its own.
  //
  // An unordered `findFirst` returns whatever Postgres feels like, so this
  // sometimes landed on a unit that had already been out — and the usage
  // arithmetic below, which counts *every* rental against the schedule anchor,
  // then measured the fixture's ten days plus somebody else's four. The test
  // read as a broken estimate when it was a broken fixture.
  const asset = await db.asset.findFirstOrThrow({
    where: { status: 'AVAILABLE', active: true, rentals: { none: {} } },
    orderBy: { assetTag: 'asc' },
    include: { category: { select: { hoursPerDay: true } } },
  })

  // -----------------------------------------------------------------------
  console.log('\nThe arithmetic (§6.4)\n')
  // -----------------------------------------------------------------------

  const now = new Date()

  check(
    'a cancelled rental accrues no usage — it never happened',
    rentalDaysSince(
      [{ checkoutDate: ago(10), actualReturnDate: ago(3), status: 'CANCELLED' }],
      null,
      now,
    ) === 0,
  )

  check(
    'a closed rental accrues exactly its days',
    rentalDaysSince(
      [{ checkoutDate: ago(10), actualReturnDate: ago(3), status: 'RETURNED' }],
      null,
      now,
    ) === 7,
  )

  check(
    'an open rental accrues up to today, not to its due date',
    rentalDaysSince([{ checkoutDate: ago(5), actualReturnDate: null, status: 'OPEN' }], null, now) === 5,
  )

  check(
    'days before the anchor are not counted twice after a reset',
    rentalDaysSince(
      [{ checkoutDate: ago(30), actualReturnDate: ago(2), status: 'RETURNED' }],
      ago(10),
      now,
    ) === 8,
    'a rental spanning the reset only accrues the part after it',
  )

  // A usage schedule at exactly its interval is due; a calendar one is exact.
  const usageAtInterval = resolveSchedule(
    {
      id: 'u1',
      label: '500-hour service',
      basis: 'USAGE',
      intervalDays: null,
      intervalUsage: 500,
      hoursPerDay: 10,
      priorUsage: new Prisma.Decimal(0),
      usageAnchorAt: ago(50),
      lastPerformed: null,
      nextDue: null,
    },
    { rentals: [{ checkoutDate: ago(50), actualReturnDate: null, status: 'OPEN' }], now },
  )
  check(
    'a usage schedule trips exactly at its interval',
    usageAtInterval.state === 'due' && usageAtInterval.estimatedHours === 500,
    `${usageAtInterval.detail} — ${usageAtInterval.note}`,
  )
  check('a usage reading is always labelled an estimate', usageAtInterval.isEstimate)

  const calendarOverdue = resolveSchedule(
    {
      id: 'c1',
      label: 'Annual flow test',
      basis: 'CALENDAR',
      intervalDays: 365,
      intervalUsage: null,
      hoursPerDay: null,
      priorUsage: new Prisma.Decimal(0),
      usageAnchorAt: null,
      lastPerformed: ago(400),
      nextDue: ago(35),
    },
    { rentals: [], now },
  )
  check(
    'a calendar schedule past its date is overdue, and exact',
    calendarOverdue.state === 'overdue' && calendarOverdue.isEstimate === false,
    `${calendarOverdue.detail} — ${calendarOverdue.note}`,
  )

  check(
    'hours-per-day falls back to the category, then to 8',
    resolveSchedule(
      {
        id: 'u2',
        label: 'x',
        basis: 'USAGE',
        intervalDays: null,
        intervalUsage: 100,
        hoursPerDay: null,
        priorUsage: new Prisma.Decimal(0),
        usageAnchorAt: ago(1),
        lastPerformed: null,
        nextDue: null,
      },
      { rentals: [{ checkoutDate: ago(1), actualReturnDate: null, status: 'OPEN' }], now },
    ).estimatedHours === DEFAULT_HOURS_PER_DAY,
  )

  // -----------------------------------------------------------------------
  console.log('\nLog service resets the right clock (§6.4)\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        label: 'Verify annual test',
        type: 'INSPECTION',
        basis: 'CALENDAR',
        intervalDays: 365,
        lastPerformed: ago(400),
        nextDue: ago(35),
        alertedAt: new Date(),
      },
    })

    const before = resolveSchedule(schedule, { rentals: [], now })
    check('a stale calendar schedule starts overdue', before.state === 'overdue')

    const performedAt = new Date()
    const after = await logCalendarService(tx, schedule.id, performedAt)

    const resolved = resolveSchedule(after, { rentals: [], now })
    check(
      'logging service pushes next due a full interval forward',
      Math.round((after.nextDue!.getTime() - performedAt.getTime()) / DAY) === 365,
      `next due ${after.nextDue!.toISOString().slice(0, 10)}`,
    )
    check('and the schedule is no longer overdue', resolved.state === 'ok', resolved.note)
    check(
      'the alert flag is cleared, so the NEXT time it comes due it alerts again',
      after.alertedAt === null,
    )
  })

  await sandbox(async (tx) => {
    // A unit that has been out continuously: 60 rental days at 10 hrs/day.
    await lineWithOrder(tx, {
        orgId: org.id,
        assetId: asset.id,
        recordedById: admin.id,
        checkoutDate: ago(60),
        expectedReturnDate: ago(55),
        actualReturnDate: ago(1),
        status: 'RETURNED',
      })

    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        label: 'Verify 500-hour service',
        type: 'PREVENTIVE',
        basis: 'USAGE',
        intervalUsage: 500,
        hoursPerDay: 10,
        priorUsage: 0,
        usageAnchorAt: ago(60),
        alertedAt: new Date(),
      },
    })

    const rentals = await tx.rental.findMany({
      where: { assetId: asset.id },
      select: { checkoutDate: true, actualReturnDate: true, status: true },
    })

    // Expectation computed from the asset's actual rentals rather than a magic
    // 590: the unit is chosen by `findFirst` with no ordering, so which one it
    // is — and whether it carries seeded rental history overlapping the anchor
    // — changes with row order. Asserting the arithmetic is the point anyway.
    const expectedHours = rentalDaysSince(rentals, ago(60), now) * 10
    const before = resolveSchedule(schedule, { rentals, now })
    check(
      'the usage estimate accrues from rental days',
      before.estimatedHours === expectedHours,
      `${before.detail} — ${rentalDaysSince(rentals, ago(60), now)} rental days × 10 hrs/day`,
    )
    check('and it has tripped', before.state === 'due')

    const performedAt = new Date()
    const after = await logUsageService(tx, schedule.id, performedAt)
    const resolvedAfter = resolveSchedule(after, { rentals, now })

    check(
      'logging service zeroes the accrued hours',
      resolvedAfter.estimatedHours === 0,
      resolvedAfter.detail,
    )
    check('and the schedule is back on track', resolvedAfter.state === 'ok')
    check(
      'both the hours AND the anchor move — neither alone is correct',
      Number(after.priorUsage) === 0 &&
        after.usageAnchorAt?.getTime() === performedAt.getTime(),
      `priorUsage=${after.priorUsage}, anchor=${after.usageAnchorAt?.toISOString()}`,
    )
    check('the alert flag is cleared', after.alertedAt === null)

    // The reading is banked on the record before the reset destroys it.
    const record = await tx.maintenanceRecord.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        scheduleId: schedule.id,
        type: 'PREVENTIVE',
        performedById: admin.id,
        performedAt,
        workDone: 'Verify service',
        usageAtService: before.estimatedHours,
      },
    })
    check(
      'the record keeps the reading the meter showed at service',
      Number(record.usageAtService) === expectedHours,
      `${record.usageAtService} hrs banked before the reset zeroed it`,
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nReturning a unit to the shelf\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await tx.asset.update({ where: { id: asset.id }, data: { status: 'IN_MAINTENANCE' } })
    const flipped = await tx.asset.updateMany({
      where: { id: asset.id, status: { in: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] } },
      data: { status: 'AVAILABLE' },
    })
    check('service on a unit in the shop returns it to Available', flipped.count === 1)
  })

  await sandbox(async (tx) => {
    // The guard that matters: a unit that went out on rent between the form
    // loading and the submit must not be yanked back to Available.
    //
    // Custody is cleared alongside the status because the Phase 1 CHECK
    // constraint refuses OUT_ON_RENT with a holder attached — the fixture has
    // to do what checkout does, or the database rejects it (§3.3).
    await tx.asset.update({
      where: { id: asset.id },
      data: {
        status: 'OUT_ON_RENT',
        custodyType: null,
        custodyUserId: null,
        custodyTruckId: null,
        custodyAssignedById: null,
        custodyAssignedAt: null,
      },
    })
    const flipped = await tx.asset.updateMany({
      where: { id: asset.id, status: { in: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] } },
      data: { status: 'AVAILABLE' },
    })
    check(
      'service on a unit that is out on rent does NOT flip it to Available',
      flipped.count === 0,
      'a conditional write, not a blind one',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nManual reading adjustment (§6.4)\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await lineWithOrder(tx, {
        orgId: org.id,
        assetId: asset.id,
        recordedById: admin.id,
        checkoutDate: ago(20),
        expectedReturnDate: ago(15),
        actualReturnDate: ago(10),
        status: 'RETURNED',
      })
    const rentals = await tx.rental.findMany({
      where: { assetId: asset.id },
      select: { checkoutDate: true, actualReturnDate: true, status: true },
    })

    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        label: 'Verify adjust',
        type: 'PREVENTIVE',
        basis: 'USAGE',
        intervalUsage: 500,
        hoursPerDay: 10,
        priorUsage: 0,
        usageAnchorAt: ago(20),
      },
    })
    const before = resolveSchedule(schedule, { rentals, now })
    check('the estimate starts from rental days', before.estimatedHours === 100, before.detail)

    // SET is authoritative: someone read a real meter.
    const stamped = new Date()
    const set = await tx.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { priorUsage: 512, usageAnchorAt: stamped, alertedAt: null },
    })
    const afterSet = resolveSchedule(set, { rentals, now })
    check(
      'SET replaces the estimate with the real reading',
      afterSet.estimatedHours === 512,
      afterSet.detail,
    )

    // ADD banks off-rental runtime without disturbing accrual.
    const added = await tx.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { priorUsage: Number(set.priorUsage) + 40 },
    })
    const afterAdd = resolveSchedule(added, { rentals, now })
    check(
      'ADD banks extra hours on top, leaving the anchor alone',
      afterAdd.estimatedHours === 552 &&
        added.usageAnchorAt?.getTime() === stamped.getTime(),
      afterAdd.detail,
    )
    check('adjusting past the interval trips the schedule', afterAdd.state === 'due')
  })

  // -----------------------------------------------------------------------
  console.log('\nThe alert sweep only fires once (§6.4)\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        label: 'Verify sweep',
        type: 'INSPECTION',
        basis: 'CALENDAR',
        intervalDays: 365,
        lastPerformed: ago(400),
        nextDue: ago(35),
      },
    })

    const first = await tx.maintenanceSchedule.updateMany({
      where: { id: schedule.id, alertedAt: null, active: true },
      data: { alertedAt: new Date() },
    })
    const second = await tx.maintenanceSchedule.updateMany({
      where: { id: schedule.id, alertedAt: null, active: true },
      data: { alertedAt: new Date() },
    })

    check('the sweep claims an overdue schedule once', first.count === 1)
    check('a second run claims nothing — no duplicate alert', second.count === 0)

    // …and after service it is armed again.
    await logCalendarService(tx, schedule.id, new Date())
    const rearmed = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    check('service re-arms the alert for next time', rearmed.alertedAt === null)
  })

  await sandbox(async (tx) => {
    // The rentals sweep, same shape: the status flip is the claim.
    const rental = await lineWithOrder(tx, {
        orgId: org.id,
        assetId: asset.id,
        recordedById: admin.id,
        checkoutDate: ago(20),
        expectedReturnDate: ago(3),
        status: 'OPEN',
      })
    await tx.$executeRaw`
      UPDATE "Rental" SET period = tstzrange(${ago(20)}, ${ago(3)}, '[)') WHERE id = ${rental.id}
    `

    const first = await tx.rental.updateMany({
      where: { id: rental.id, status: 'OPEN' },
      data: { status: 'OVERDUE' },
    })
    const second = await tx.rental.updateMany({
      where: { id: rental.id, status: 'OPEN' },
      data: { status: 'OVERDUE' },
    })
    check('a late rental is marked overdue once', first.count === 1)
    check('re-running the sweep marks nothing again', second.count === 0)

    const [period] = await tx.$queryRaw<{ period: string | null }[]>`
      SELECT period::text FROM "Rental" WHERE id = ${rental.id}
    `
    check(
      'going overdue does not release the unit — both statuses hold the window',
      Boolean(period?.period),
      period?.period ?? 'NULL',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nTickets\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await tx.asset.update({ where: { id: asset.id }, data: { status: 'OUT_OF_SERVICE' } })

    const first = await tx.maintenanceTicket.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        title: 'O2 sensor drifts',
        priority: 'HIGH',
        status: 'OPEN',
      },
    })
    const second = await tx.maintenanceTicket.create({
      data: {
        orgId: org.id,
        assetId: asset.id,
        title: 'Case latch broken',
        priority: 'LOW',
        status: 'OPEN',
      },
    })

    // Resolving one ticket must not put a unit with two faults back on the shelf.
    await tx.maintenanceTicket.update({ where: { id: first.id }, data: { status: 'RESOLVED' } })
    const otherLive = await tx.maintenanceTicket.count({
      where: { assetId: asset.id, id: { not: first.id }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    })
    check(
      'clearing one fault does not make a unit with two faults safe',
      otherLive === 1,
      'the second ticket blocks the return to service',
    )

    await tx.maintenanceTicket.update({ where: { id: second.id }, data: { status: 'RESOLVED' } })
    const nowLive = await tx.maintenanceTicket.count({
      where: { assetId: asset.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    })
    check('with every ticket cleared the unit can go back', nowLive === 0)
  })

  {
    const { tickets, liveCount } = await listTickets(db)
    check(
      'the ticket board reads without throwing',
      Array.isArray(tickets) && Number.isInteger(liveCount),
      `${liveCount} live`,
    )
  }

  // -----------------------------------------------------------------------
  console.log('\nThe queue (§6.4)\n')
  // -----------------------------------------------------------------------

  {
    const { rows, counts } = await listMaintenanceQueue(db)
    check(
      'the queue resolves every active schedule on the fleet',
      rows.length > 0,
      `${rows.length} schedules · ${counts.overdue} overdue, ${counts.due} due, ${counts.soon} soon`,
    )

    const states = rows.map((row) => row.schedule.state)
    const rank = { overdue: 0, due: 1, soon: 2, ok: 3 } as const
    check(
      'it is sorted worst-first, so the top of the screen is the work',
      states.every((state, index) => index === 0 || rank[states[index - 1]] <= rank[state]),
      states.join(' → '),
    )

    check(
      'every usage row is flagged as an estimate, every calendar row is not',
      rows.every((row) => row.schedule.isEstimate === (row.schedule.basis === 'USAGE')),
    )

    const actionable = rows.filter((row) => ACTIONABLE.includes(row.schedule.state))
    check(
      'the actionable set is exactly due + overdue',
      actionable.length === counts.due + counts.overdue,
      `${actionable.length} actionable`,
    )
  }

  // -----------------------------------------------------------------------
  console.log('\nValidation\n')
  // -----------------------------------------------------------------------

  const today = new Date().toISOString().slice(0, 10)

  check(
    'a well-formed service log parses',
    logServiceSchema.safeParse({
      assetId: 'a',
      workDone: 'Replaced the O2 sensor',
      performedAt: today,
    }).success,
  )

  const noWork = logServiceSchema.safeParse({ assetId: 'a', workDone: 'x', performedAt: today })
  check(
    'a service log with no description of the work is refused',
    !noWork.success,
    noWork.success ? '' : noWork.error.issues[0]?.message,
  )

  const negativeCost = logServiceSchema.safeParse({
    assetId: 'a',
    workDone: 'Replaced the sensor',
    performedAt: today,
    cost: '-5',
  })
  check('a negative cost is refused', !negativeCost.success)

  const calendarNoInterval = scheduleSchema.safeParse({
    assetId: 'a',
    label: 'Annual test',
    basis: 'CALENDAR',
  })
  check(
    'a calendar schedule with no interval is refused',
    !calendarNoInterval.success,
    calendarNoInterval.success ? '' : calendarNoInterval.error.issues[0]?.message,
  )

  const usageNoInterval = scheduleSchema.safeParse({
    assetId: 'a',
    label: '500-hour',
    basis: 'USAGE',
  })
  check('a usage schedule with no hour interval is refused', !usageNoInterval.success)

  check(
    'a usage schedule does not need a day interval',
    scheduleSchema.safeParse({
      assetId: 'a',
      label: '500-hour',
      basis: 'USAGE',
      intervalUsage: '500',
    }).success,
  )

  const badHoursPerDay = scheduleSchema.safeParse({
    assetId: 'a',
    label: '500-hour',
    basis: 'USAGE',
    intervalUsage: '500',
    hoursPerDay: '30',
  })
  check('more than 24 hours per day is refused', !badHoursPerDay.success)

  const negativeReading = adjustUsageSchema.safeParse({ scheduleId: 's', mode: 'SET', hours: '-1' })
  check('a negative meter reading is refused', !negativeReading.success)

  check(
    'a reading correction parses',
    adjustUsageSchema.safeParse({ scheduleId: 's', mode: 'SET', hours: '512' }).success,
  )

  const noTitle = ticketSchema.safeParse({ assetId: 'a', title: 'x' })
  check('a ticket with no real title is refused', !noTitle.success)

  check(
    'the out-of-service checkbox arrives as a boolean',
    ticketSchema.safeParse({ assetId: 'a', title: 'Sensor drift', takeOutOfService: 'on' }).data
      ?.takeOutOfService === true,
  )

  // -----------------------------------------------------------------------
  const stillThere = await db.asset.findUniqueOrThrow({ where: { id: asset.id } })
  const strays = await db.maintenanceSchedule.count({ where: { label: { startsWith: 'Verify ' } } })
  check(
    'nothing leaked out of the sandboxes',
    stillThere.status === 'AVAILABLE' && strays === 0,
    `${asset.assetTag}: ${stillThere.status}, ${strays} test schedules left behind`,
  )

  console.log(failures === 0 ? '\nAll maintenance checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
