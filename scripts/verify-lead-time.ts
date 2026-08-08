/**
 * Per-schedule lead time and staged alerting (BUILD_SPEC §6.4).
 *
 * Walks the exact scenario this feature was asked for, end to end against the
 * live database:
 *
 *   "Monthly calibration, CALENDAR, 30 days, last performed 2026-06-29, lead 7"
 *   on a 4-gas monitor →
 *     · shows overdue in the queue (29 July has passed)
 *     · logging a calibration today sets next due 30 days out
 *     · a schedule due within 7 days fires the cron alert
 *
 * Plus the thing that makes an advance warning actually work: a schedule must
 * alert when it enters its lead window *and again* when it falls due. A single
 * "already alerted" flag cannot express that — one of the two gets swallowed —
 * which is why `alertedState` records the stage.
 *
 *   npx tsx scripts/verify-lead-time.ts
 */
import 'dotenv/config'
import { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import {
  DEFAULT_LEAD_DAYS,
  hasEscalated,
  resolveSchedule,
  type ScheduleState,
} from '../src/lib/maintenance'
import { listMaintenanceQueue } from '../src/lib/maintenance-queue'
import { scheduleSchema } from '../src/lib/validators/maintenance'

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

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`)

/** The calendar reset, exactly as `logServiceAction` performs it. */
async function logService(tx: Prisma.TransactionClient, scheduleId: string, performedAt: Date) {
  const schedule = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: scheduleId } })
  return tx.maintenanceSchedule.update({
    where: { id: scheduleId },
    data: {
      lastPerformed: performedAt,
      nextDue: schedule.intervalDays
        ? new Date(performedAt.getTime() + schedule.intervalDays * DAY)
        : null,
      alertedAt: null,
      alertedState: null,
    },
  })
}

/** The sweep's decision + claim, exactly as the cron performs it. */
async function sweepOnce(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  now: Date,
): Promise<{ alerted: boolean; state: ScheduleState }> {
  const schedule = await tx.maintenanceSchedule.findUniqueOrThrow({
    where: { id: scheduleId },
    include: {
      asset: {
        select: {
          category: { select: { hoursPerDay: true } },
          rentals: { select: { checkoutDate: true, actualReturnDate: true, status: true } },
        },
      },
    },
  })

  const resolved = resolveSchedule(schedule, {
    rentals: schedule.asset.rentals,
    categoryHoursPerDay: schedule.asset.category.hoursPerDay,
    now,
  })

  if (resolved.state === 'ok') return { alerted: false, state: resolved.state }
  if (!hasEscalated(resolved.state, schedule.alertedState)) {
    return { alerted: false, state: resolved.state }
  }

  const claimed = await tx.maintenanceSchedule.updateMany({
    where: { id: scheduleId, active: true, alertedState: schedule.alertedState },
    data: { alertedAt: now, alertedState: resolved.state },
  })

  return { alerted: claimed.count === 1, state: resolved.state }
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // The scenario names a 4-gas monitor specifically.
  const monitor = await db.asset.findFirstOrThrow({
    where: { active: true, model: { contains: '4 Gas', mode: 'insensitive' } },
  })

  // -----------------------------------------------------------------------
  console.log(`\nThe scenario: "Monthly calibration" on ${monitor.assetTag}\n`)
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: monitor.id,
        label: 'Monthly calibration',
        type: 'CALIBRATION',
        basis: 'CALENDAR',
        intervalDays: 30,
        leadDays: 7,
        lastPerformed: day('2026-06-29'),
        nextDue: new Date(day('2026-06-29').getTime() + 30 * DAY),
      },
    })

    check(
      'next due is last performed + 30 days',
      schedule.nextDue?.toISOString().slice(0, 10) === '2026-07-29',
      `${schedule.nextDue?.toISOString().slice(0, 10)}`,
    )

    const resolved = resolveSchedule(schedule, { rentals: [], now: new Date() })
    check(
      'it reads OVERDUE, because 29 July has passed',
      resolved.state === 'overdue',
      `${resolved.detail} — ${resolved.note}`,
    )
    check('and carries its own lead time, not the old global 30', resolved.leadDays === 7)

    // --- log a calibration today ---------------------------------------
    const today = new Date()
    const after = await logService(tx, schedule.id, today)
    const afterResolved = resolveSchedule(after, { rentals: [], now: today })

    const daysOut = Math.round((after.nextDue!.getTime() - today.getTime()) / DAY)
    check(
      'logging a calibration today sets next due 30 days out',
      daysOut === 30,
      `next due ${after.nextDue!.toISOString().slice(0, 10)} (${daysOut}d out)`,
    )
    check('and the schedule is back on track', afterResolved.state === 'ok', afterResolved.note)
    check(
      'and the alert cycle is re-armed for next time',
      after.alertedAt === null && after.alertedState === null,
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nThe advance warning fires with time to act\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    // Due in 5 days, lead 7 → inside the window.
    const dueIn5 = new Date(Date.now() + 5 * DAY)
    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: monitor.id,
        label: 'Verify lead window',
        type: 'CALIBRATION',
        basis: 'CALENDAR',
        intervalDays: 30,
        leadDays: 7,
        lastPerformed: new Date(dueIn5.getTime() - 30 * DAY),
        nextDue: dueIn5,
      },
    })

    const resolved = resolveSchedule(schedule, { rentals: [], now: new Date() })
    check(
      'a schedule due in 5 days with lead 7 reads "due soon"',
      resolved.state === 'soon',
      `${resolved.detail} — ${resolved.note}`,
    )

    const first = await sweepOnce(tx, schedule.id, new Date())
    check(
      'the cron alerts on it — the heads-up, before it is late',
      first.alerted && first.state === 'soon',
      'this is the case that previously sent nothing at all',
    )

    const second = await sweepOnce(tx, schedule.id, new Date())
    check('a second run does not repeat the heads-up', !second.alerted)
  })

  await sandbox(async (tx) => {
    // Due in 20 days, lead 7 → outside the window, must stay quiet.
    const dueIn20 = new Date(Date.now() + 20 * DAY)
    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: monitor.id,
        label: 'Verify outside window',
        type: 'CALIBRATION',
        basis: 'CALENDAR',
        intervalDays: 30,
        leadDays: 7,
        lastPerformed: new Date(dueIn20.getTime() - 30 * DAY),
        nextDue: dueIn20,
      },
    })

    const resolved = resolveSchedule(schedule, { rentals: [], now: new Date() })
    check('a schedule due in 20 days with lead 7 is still "ok"', resolved.state === 'ok')

    const swept = await sweepOnce(tx, schedule.id, new Date())
    check('and the cron stays quiet about it', !swept.alerted)
  })

  // -----------------------------------------------------------------------
  console.log('\nEscalation: heads-up first, then the real one\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const dueIn3 = new Date(Date.now() + 3 * DAY)
    const schedule = await tx.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: monitor.id,
        label: 'Verify escalation',
        type: 'CALIBRATION',
        basis: 'CALENDAR',
        intervalDays: 30,
        leadDays: 7,
        lastPerformed: new Date(dueIn3.getTime() - 30 * DAY),
        nextDue: dueIn3,
      },
    })

    const soon = await sweepOnce(tx, schedule.id, new Date())
    check('day 1 — inside the lead window, heads-up sent', soon.alerted && soon.state === 'soon')

    const stillSoon = await sweepOnce(tx, schedule.id, new Date(Date.now() + 1 * DAY))
    check('day 2 — still just "soon", nothing repeated', !stillSoon.alerted)

    // Now let it go past due. THIS is what a single alertedAt flag would eat.
    const late = await sweepOnce(tx, schedule.id, new Date(Date.now() + 5 * DAY))
    check(
      'day 5 — now overdue, and it alerts AGAIN',
      late.alerted && late.state === 'overdue',
      'a single "already alerted" flag would have swallowed this one',
    )

    const stillLate = await sweepOnce(tx, schedule.id, new Date(Date.now() + 9 * DAY))
    check('day 9 — still overdue, but not re-sent every run', !stillLate.alerted)

    const row = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    check('the stage reached is recorded', row.alertedState === 'overdue', `${row.alertedState}`)

    // Service re-arms the whole cycle.
    await logService(tx, schedule.id, new Date())
    const rearmed = await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    check(
      'logging service re-arms it, so the next cycle warns again',
      rearmed.alertedState === null && rearmed.alertedAt === null,
    )
  })

  check(
    'the escalation rule itself: only a step up alerts',
    hasEscalated('soon', null) &&
      hasEscalated('overdue', 'soon') &&
      hasEscalated('due', 'soon') &&
      !hasEscalated('soon', 'soon') &&
      !hasEscalated('soon', 'overdue') &&
      !hasEscalated('due', 'overdue'),
  )

  // -----------------------------------------------------------------------
  console.log('\nLead time on usage schedules\n')
  // -----------------------------------------------------------------------

  {
    // 7 days at 10 hrs/day = 70 hours of notice on a 500-hour interval.
    const base = {
      id: 'u',
      label: '500-hour service',
      basis: 'USAGE' as const,
      intervalDays: null,
      intervalUsage: 500,
      hoursPerDay: 10,
      usageAnchorAt: new Date(Date.now() - 100 * DAY),
      lastPerformed: null,
      nextDue: null,
      leadDays: 7,
    }
    const rentals = [
      { checkoutDate: new Date(Date.now() - 100 * DAY), actualReturnDate: null, status: 'OPEN' as const },
    ]

    // 100 rental days × 10 hrs = 1000 accrued, so priorUsage back-solves the
    // reading we want to test. Lead 7 days × 10 hrs/day = 70 hours of notice,
    // so the "soon" line sits at 430.
    const reading = (target: number) => new Prisma.Decimal(target - 1000)

    const at420 = resolveSchedule({ ...base, priorUsage: reading(420) } as never, {
      rentals,
      now: new Date(),
    })
    check(
      'a usage schedule 80 hours out is still "ok" with 70 hours of lead',
      at420.estimatedHours === 420 && at420.state === 'ok',
      `${at420.detail} (${at420.state}) — the line is at 430`,
    )

    const at440 = resolveSchedule({ ...base, priorUsage: reading(440) } as never, {
      rentals,
      now: new Date(),
    })
    check(
      'and 60 hours out — inside the window — reads "due soon"',
      at440.estimatedHours === 440 && at440.state === 'soon',
      `${at440.detail} (${at440.state})`,
    )

    const at420Wide = resolveSchedule(
      { ...base, leadDays: 10, priorUsage: reading(420) } as never,
      { rentals, now: new Date() },
    )
    check(
      'widening the lead to 10 days (100 hrs) pulls the same reading into "soon"',
      at420Wide.state === 'soon',
      `${at420Wide.detail} (${at420Wide.state}) — the line moves to 400`,
    )
  }

  // -----------------------------------------------------------------------
  console.log('\nForm and defaults\n')
  // -----------------------------------------------------------------------

  const good = scheduleSchema.safeParse({
    assetId: 'a',
    label: 'Monthly calibration',
    basis: 'CALENDAR',
    intervalDays: '30',
    leadDays: '7',
  })
  check('the scenario parses', good.success, good.success ? '' : good.error.issues[0]?.message)
  check('lead time comes through as a number', good.success && good.data.leadDays === 7)

  check(
    'a blank lead time falls back to the default rather than to zero',
    (scheduleSchema.safeParse({
      assetId: 'a',
      label: 'x',
      basis: 'CALENDAR',
      intervalDays: '30',
      leadDays: '',
    }).data?.leadDays ?? DEFAULT_LEAD_DAYS) === DEFAULT_LEAD_DAYS,
  )

  check(
    'a negative lead time is refused',
    !scheduleSchema.safeParse({
      assetId: 'a',
      label: 'x',
      basis: 'CALENDAR',
      intervalDays: '30',
      leadDays: '-1',
    }).success,
  )

  check('the default is 7 days', DEFAULT_LEAD_DAYS === 7)

  // -----------------------------------------------------------------------
  console.log('\nThe fleet still resolves\n')
  // -----------------------------------------------------------------------

  {
    const { rows, counts } = await listMaintenanceQueue(db)
    check(
      'every seeded schedule resolves with a lead time',
      rows.every((row) => Number.isInteger(row.schedule.leadDays)),
      `${rows.length} schedules · ${counts.overdue} overdue, ${counts.due} due, ${counts.soon} soon`,
    )
  }

  const strays = await db.maintenanceSchedule.count({
    where: { OR: [{ label: { startsWith: 'Verify ' } }, { label: 'Monthly calibration' }] },
  })
  check('nothing leaked out of the sandboxes', strays === 0, `${strays} test schedules`)

  console.log(failures === 0 ? '\nAll lead-time checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
