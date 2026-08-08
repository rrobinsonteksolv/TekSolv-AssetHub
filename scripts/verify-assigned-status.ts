/**
 * "Assigned" is a display state, not a stored one (BUILD_SPEC §3.4).
 *
 * A monitor that is Bucky's is not free to take, but it *is* physically on the
 * shelf and in working order — so `Asset.status` stays AVAILABLE and the label
 * is derived from status + custody at the point of display. The rule this
 * protects: status answers "where is this unit right now", and only changes
 * inside a transaction that also writes the record explaining why. Custody is
 * a different question and lives in different columns.
 *
 * What is verified here:
 *   1. an assigned unit shows "Assigned", not "Available" — and nothing was
 *      written to get that (the stored status is untouched)
 *   2. it is not in the free-to-take pool the grab/checkout/reserve pickers use
 *   3. custody can still be changed freely — person → person, person → truck,
 *      and back to general stock — because availability never gates it
 *   4. unassigning puts it straight back in the pool, green again
 *
 *   npx tsx scripts/verify-assigned-status.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import {
  DISPLAY_LABEL,
  displayStatus,
  isFreeToTake,
  type DisplayStatus,
} from '../src/lib/asset-status'
import { availableInWindow, listPickableAssets, windowFromNow } from '../src/lib/availability'
import { STATUS_LABEL } from '../src/components/ui/status-badge'

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

/** The custody write, as `assignCustodyAction` performs it. */
async function setCustody(
  tx: Prisma.TransactionClient,
  assetId: string,
  actorId: string,
  target: { type: 'PERSON' | 'TRUCK' | null; userId?: string; truckId?: string },
) {
  await tx.asset.update({
    where: { id: assetId },
    data: {
      custodyType: target.type,
      custodyUserId: target.type === 'PERSON' ? (target.userId ?? null) : null,
      custodyTruckId: target.type === 'TRUCK' ? (target.truckId ?? null) : null,
      custodyAssignedById: target.type ? actorId : null,
      custodyAssignedAt: target.type ? new Date() : null,
    },
  })
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const supervisor = await prismaUnscoped.user.findFirstOrThrow({
    where: { email: 'sam@teksolv.com' },
  })
  const tech = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'dreyes@teksolv.com' } })
  const other = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })
  const truck = await db.truck.findFirstOrThrow({ where: { active: true } })

  const unit = await db.asset.findFirstOrThrow({
    where: { active: true, status: 'AVAILABLE', custodyType: null },
  })

  // -----------------------------------------------------------------------
  console.log('\nThe derivation is pure and only ever promotes AVAILABLE\n')
  // -----------------------------------------------------------------------

  check('available + no holder → Available', displayStatus('AVAILABLE', null) === 'AVAILABLE')
  check('available + a person → Assigned', displayStatus('AVAILABLE', 'PERSON') === 'ASSIGNED')
  check('available + a truck → Assigned', displayStatus('AVAILABLE', 'TRUCK') === 'ASSIGNED')

  check(
    'out on rent is never relabelled',
    displayStatus('OUT_ON_RENT', null) === 'OUT_ON_RENT' &&
      displayStatus('OUT_ON_RENT', 'TRUCK') === 'OUT_ON_RENT',
    'the CHECK constraint forbids custody on a rented unit anyway',
  )
  check(
    'a staged unit in the shop still says In Maintenance',
    displayStatus('IN_MAINTENANCE', 'TRUCK') === 'IN_MAINTENANCE',
    'that is the "pulled from Truck 165" case the readiness panel reports on',
  )
  check(
    'out of service and retired are untouched',
    displayStatus('OUT_OF_SERVICE', 'PERSON') === 'OUT_OF_SERVICE' &&
      displayStatus('RETIRED', 'TRUCK') === 'RETIRED',
  )

  check('Assigned is amber-labelled', DISPLAY_LABEL.ASSIGNED === 'Assigned')
  check(
    'free-to-take is exactly "shows green Available"',
    isFreeToTake('AVAILABLE', null) &&
      !isFreeToTake('AVAILABLE', 'PERSON') &&
      !isFreeToTake('OUT_ON_RENT', null),
  )

  // The form and the filter must keep offering only real enum values —
  // "Assigned" is not something you can set a unit to.
  check(
    'the stored-status list has no ASSIGNED value to pick',
    !Object.keys(STATUS_LABEL).includes('ASSIGNED'),
    Object.keys(STATUS_LABEL).join(', '),
  )
  check(
    'but the display list does',
    Object.keys(DISPLAY_LABEL).includes('ASSIGNED') &&
      Object.keys(DISPLAY_LABEL).length === Object.keys(STATUS_LABEL).length + 1,
  )

  // -----------------------------------------------------------------------
  console.log(`\nAssigning ${unit.assetTag} changes the label, not the column\n`)
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await setCustody(tx, unit.id, supervisor.id, { type: 'PERSON', userId: tech.id })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })

    check(
      'the stored status is STILL AVAILABLE — nothing was written to it',
      after.status === 'AVAILABLE',
      'status keeps meaning "where is this unit physically" (§3.4)',
    )
    check(
      'but it displays as Assigned, not Available',
      displayStatus(after.status, after.custodyType) === 'ASSIGNED',
      `badge reads "${DISPLAY_LABEL[displayStatus(after.status, after.custodyType) as DisplayStatus]}"`,
    )

    // …and it drops out of the free pool.
    const inPool = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow(windowFromNow(new Date(Date.now() + 7 * DAY))) },
    })
    check('and it is no longer in the free-to-take pool', inPool === 0)
  })

  await sandbox(async (tx) => {
    await setCustody(tx, unit.id, supervisor.id, { type: 'TRUCK', truckId: truck.id })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'staging on a truck reads Assigned too',
      after.status === 'AVAILABLE' && displayStatus(after.status, after.custodyType) === 'ASSIGNED',
      `Truck ${truck.number}`,
    )
    const inPool = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow(windowFromNow(new Date(Date.now() + 7 * DAY))) },
    })
    check('and a staged unit is not offered either', inPool === 0)
  })

  // -----------------------------------------------------------------------
  console.log('\nThe pickers all agree — one helper, three screens\n')
  // -----------------------------------------------------------------------

  {
    // Live data: nothing the pickers offer may be an assigned unit.
    const soon = windowFromNow(new Date(Date.now() + 7 * DAY))
    const now = await listPickableAssets(db, soon, { take: 500 })
    const held = await db.asset.count({
      where: { active: true, status: 'AVAILABLE', custodyType: { not: null } },
    })

    check(
      'the grab / checkout picker offers only general-stock units',
      now.every((asset) => isFreeToTake(asset.status, null)),
      `${now.length} offered, ${held} assigned units on the fleet and none of them listed`,
    )
    check(
      'and the assigned ones really are excluded, not just absent',
      held > 0,
      'there is genuinely something being filtered out here',
    )

    // A future window is the reserve picker: same rule.
    const future = { start: new Date(Date.now() + 30 * DAY), end: new Date(Date.now() + 37 * DAY) }
    const later = await listPickableAssets(db, future, { take: 500 })
    const assignedIds = new Set(
      (
        await db.asset.findMany({
          where: { active: true, custodyType: { not: null } },
          select: { id: true },
        })
      ).map((row) => row.id),
    )
    check(
      'the reserve picker excludes them too — the label must hold for a booking as well',
      later.every((asset) => !assignedIds.has(asset.id)),
      `${later.length} bookable for a window 30 days out`,
    )
  }

  // -----------------------------------------------------------------------
  console.log('\nCustody is a separate dimension: reassignment is never blocked\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    // person → person, on a unit that is currently "Assigned" and therefore
    // out of the availability pool. Availability must not gate this at all.
    await setCustody(tx, unit.id, supervisor.id, { type: 'PERSON', userId: tech.id })
    await setCustody(tx, unit.id, supervisor.id, { type: 'PERSON', userId: other.id })
    let after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'an assigned unit can be reassigned person → person',
      after.custodyType === 'PERSON' && after.custodyUserId === other.id,
    )

    // person → truck
    await setCustody(tx, unit.id, supervisor.id, { type: 'TRUCK', truckId: truck.id })
    after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'and reassigned person → truck',
      after.custodyType === 'TRUCK' &&
        after.custodyTruckId === truck.id &&
        after.custodyUserId === null,
    )
    check('with the single-holder rule intact', !(after.custodyUserId && after.custodyTruckId))
    check(
      'and it still reads Assigned throughout',
      displayStatus(after.status, after.custodyType) === 'ASSIGNED',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nUnassigning puts it straight back in the pool\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await setCustody(tx, unit.id, supervisor.id, { type: 'PERSON', userId: tech.id })

    const beforePool = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow(windowFromNow(new Date(Date.now() + 7 * DAY))) },
    })
    check('assigned: out of the pool', beforePool === 0)

    await setCustody(tx, unit.id, supervisor.id, { type: null })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })

    check(
      'unassigned: shows green Available again',
      displayStatus(after.status, after.custodyType) === 'AVAILABLE',
      `badge reads "${DISPLAY_LABEL[displayStatus(after.status, after.custodyType) as DisplayStatus]}"`,
    )

    const afterPool = await tx.asset.count({
      where: { id: unit.id, ...availableInWindow(windowFromNow(new Date(Date.now() + 7 * DAY))) },
    })
    check('and is grabbable again', afterPool === 1)
  })

  // -----------------------------------------------------------------------
  console.log('\nThe dashboard counts the same way\n')
  // -----------------------------------------------------------------------

  {
    const { getDashboard } = await import('../src/lib/dashboard')
    const data = await getDashboard(db)
    // Scoped to RENTAL, because that is what the dashboard's fleet KPIs mean.
    // Rescue gear is owned equipment that never goes out on a rental, so
    // counting it here would make "free to take" read as a rental pool forty
    // units larger than it is — the same reason it is out of utilization.
    const storedAvailable = await db.asset.count({
      where: { active: true, status: 'AVAILABLE', assetType: 'RENTAL' },
    })

    check(
      'the dashboard splits stored-AVAILABLE into free and assigned',
      data.fleet.available + data.fleet.assigned === storedAvailable,
      `${data.fleet.available} free + ${data.fleet.assigned} assigned = ${storedAvailable} stored AVAILABLE (rental)`,
    )
    check(
      'so "free" never overstates what someone can actually take',
      data.fleet.available <= storedAvailable,
    )
  }

  // -----------------------------------------------------------------------
  const untouched = await db.asset.findUniqueOrThrow({ where: { id: unit.id } })
  check(
    'nothing leaked out of the sandboxes',
    untouched.custodyType === null && untouched.status === 'AVAILABLE',
    `${unit.assetTag}: ${untouched.status} / custody ${untouched.custodyType ?? 'none'}`,
  )

  console.log(failures === 0 ? '\nAll assigned-status checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
