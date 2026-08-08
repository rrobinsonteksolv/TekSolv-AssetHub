/**
 * Phase 4: field self-checkout, consumable decrement, manager alerts, and the
 * window-aware availability helper.
 *
 * The interesting cases are the failures. A grab is one transaction on purpose
 * — if the last monitor goes to someone else mid-submit, the supplies must not
 * decrement and no alert may claim equipment moved.
 *
 *   npx tsx scripts/verify-grab.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listPickableAssets, windowFromNow, availableInWindow } from '../src/lib/availability'
import { notifyManagers } from '../src/lib/notifications'
import { grabSchema } from '../src/lib/validators/grab'
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
/** The destination the atomicity case uses — never a real one. */
const FAILED_DESTINATION = 'Nowhere'

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

/** The grab transaction, matching the server action. Throws like it does. */
async function grab(
  tx: Prisma.TransactionClient,
  orgId: string,
  actorId: string,
  takerId: string,
  input: {
    assetIds: string[]
    supplies: Record<string, number>
    destination: string
    /** Which office's shelf the supplies come off — stock is per office. */
    locationId?: string
  },
) {
  const expectedReturnDate = new Date(Date.now() + 7 * 86_400_000)
  const checkoutDate = new Date()
  const internal = await tx.customer.findFirstOrThrow({ where: { orgId, internal: true } })
  const labels: string[] = []

  for (const assetId of input.assetIds) {
    const asset = await tx.asset.findFirstOrThrow({ where: { id: assetId } })
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
    if (flipped.count !== 1) throw new Error(`TAKEN:${asset.assetTag}`)

    const rental = await lineWithOrder(tx, {
        orgId,
        assetId,
        kind: 'INTERNAL',
        customerId: internal.id,
        destination: input.destination,
        recordedById: actorId,
        checkedOutById: takerId,
        checkoutDate,
        expectedReturnDate,
        checkoutCondition: 'GOOD',
        status: 'OPEN',
      })
    await tx.$executeRaw`
      UPDATE "Rental" SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
      WHERE id = ${rental.id} AND "orgId" = ${orgId}
    `
    labels.push(asset.assetTag)
  }

  for (const [consumableId, quantity] of Object.entries(input.supplies)) {
    if (quantity <= 0) continue
    const consumable = await tx.consumable.findFirstOrThrow({ where: { id: consumableId } })
    // Stock is per office now, so the decrement names a shelf. Without the
    // locationId this would be "somewhere in the org", which is not a place
    // anybody can take a box of glasses from.
    const decremented = await tx.consumableStock.updateMany({
      where: { consumableId, locationId: input.locationId, onHand: { gte: quantity } },
      data: { onHand: { decrement: quantity } },
    })
    if (decremented.count !== 1) throw new Error(`SHORT:${consumable.name}`)
    await tx.consumableTxn.create({
      data: {
        locationId: input.locationId,
        orgId,
        consumableId,
        qtyDelta: -quantity,
        reason: 'GRAB',
        destination: input.destination,
        userId: takerId,
      },
    })
    labels.push(`${quantity}x ${consumable.name}`)
  }

  await notifyManagers(tx as never, {
    orgId,
    excludeUserId: actorId,
    type: 'EQUIPMENT_TAKEN',
    title: 'Someone took equipment',
    body: `${labels.join(', ')} → ${input.destination}`,
  })

  return labels
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const tech = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'dreyes@teksolv.com' } })
  const admin = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })
  const glasses = await db.consumable.findFirstOrThrow({ where: { name: 'Safety glasses' } })
  const calGas = await db.consumable.findFirstOrThrow({ where: { name: 'H2S cal gas (34L)' } })

  // Stock is per office, so this run has to name one. Ask which office actually
  // stocks the glasses rather than naming a warehouse that may not — the same
  // discipline every other fixture here follows.
  const shelf = await db.consumableStock.findFirstOrThrow({
    where: { consumableId: glasses.id },
    include: { location: { select: { id: true, name: true } } },
    orderBy: { onHand: 'desc' },
  })
  const office = shelf.location
  const openingStock = shelf.onHand

  console.log('\nWindow-aware availability (BUILD_SPEC §6.6)\n')

  const now = new Date()
  const week = windowFromNow(new Date(now.getTime() + 7 * 86_400_000), now)
  const pickable = await listPickableAssets(db, week)
  const tags = pickable.map((asset) => asset.assetTag)

  check(
    'a unit out on rent right now is not offered',
    !tags.includes('FAM001007'),
    `${tags.length} pickable`,
  )
  check(
    'a unit in maintenance is not offered',
    !tags.includes('FAM001009') && !tags.includes('FAM003002'),
  )
  check('an out-of-service unit is not offered', !tags.includes('FAM001012'))

  // A genuinely general-stock unit — looked up rather than hard-coded, because
  // "which seeded unit happens to be unassigned" changes the moment anybody
  // uses the app.
  const freeUnit = await db.asset.findFirst({
    where: { active: true, status: 'AVAILABLE', custodyType: null },
    select: { assetTag: true },
  })
  check(
    'a general-stock unit is offered',
    freeUnit ? tags.includes(freeUnit.assetTag) : true,
    freeUnit ? freeUnit.assetTag : 'nothing in general stock — skipped',
  )

  // Reversed deliberately. This previously asserted that staging on a truck is
  // "not unavailability" and a staged unit stayed grabbable. It is now the
  // opposite: an assigned unit shows as "Assigned" rather than green
  // "Available" (`src/lib/asset-status.ts`), and a picker that still offered it
  // would contradict that label — a monitor that is Bucky's is not free to
  // take. Unassign it first; that step is what drops the truck's readiness.
  check(
    'a unit staged on a truck is NOT offered — it belongs to that truck',
    !tags.includes('FAM003001'),
  )
  // Ask which unit is actually assigned to somebody rather than naming one.
  // A hard-coded tag here has broken twice already: custody is real data that
  // moves as the app gets used, and a fixture that names a row is asserting
  // about the seed rather than about the rule.
  const assigned = await db.asset.findFirst({
    where: { active: true, custodyType: 'PERSON' },
    select: { assetTag: true, custodyUser: { select: { name: true } } },
  })
  check(
    'and neither is one assigned to a person',
    assigned ? !tags.includes(assigned.assetTag) : true,
    assigned
      ? `${assigned.assetTag} is ${assigned.custodyUser?.name ?? 'someone'}'s`
      : 'nothing is assigned to a person right now — skipped',
  )

  // The point of a range: a unit out today is free for a window after it
  // returns. The rental has to be one that is still *due* — an overdue unit's
  // "after it comes back" window would start in the past and therefore include
  // now, and a unit that is physically out is not available now no matter what
  // its dates say (see `availableInWindow`).
  const rented = await db.rental.findFirstOrThrow({
    where: { status: { in: ['OPEN', 'OVERDUE'] }, expectedReturnDate: { gt: new Date() } },
    orderBy: { expectedReturnDate: 'asc' },
    include: { asset: { select: { assetTag: true } } },
  })
  const afterReturn = {
    start: new Date(rented.expectedReturnDate.getTime() + 86_400_000),
    end: new Date(rented.expectedReturnDate.getTime() + 8 * 86_400_000),
  }
  const later = await db.asset.findMany({
    where: availableInWindow(afterReturn),
    select: { assetTag: true },
  })
  check(
    'a unit out today IS available for a window after it comes back',
    later.some((asset) => asset.assetTag === rented.asset.assetTag),
    `${rented.asset.assetTag} is due ${rented.expectedReturnDate.toISOString().slice(0, 10)}, free after`,
  )

  console.log('\nGrab (BUILD_SPEC §6.3)\n')

  // Whatever is genuinely in general stock — the picker's own first offer.
  const spare = pickable[0]
  if (!spare) throw new Error('nothing in general stock to grab; re-seed the fleet')

  // The staged unit is fetched directly, NOT from `pickable`: a unit on a truck
  // is no longer offered. The grab action still clears custody defensively,
  // and that path is now reachable only by a race — someone stages a unit
  // between the picker rendering and the submit landing. Worth keeping honest,
  // so this drives it deliberately.
  const staged = await db.asset.findFirstOrThrow({
    where: { active: true, status: 'AVAILABLE', custodyType: 'TRUCK' },
    select: { id: true, assetTag: true },
  })

  await sandbox(async (tx) => {
    const before = await tx.consumableStock.findFirstOrThrow({
      where: { consumableId: glasses.id, locationId: office.id },
    })

    await grab(tx, org.id, tech.id, tech.id, {
      assetIds: [spare.id, staged.id],
      supplies: { [glasses.id]: 2 },
      locationId: office.id,
      destination: 'Marcellus Pad 7',
    })

    const asset = await tx.asset.findUniqueOrThrow({ where: { id: spare.id } })
    check('grabbed gear flips to OUT_ON_RENT', asset.status === 'OUT_ON_RENT')

    const stagedAfter = await tx.asset.findUniqueOrThrow({ where: { id: staged.id } })
    check(
      'a staged unit that slips through a race is still released from its truck',
      stagedAfter.custodyType === null && stagedAfter.custodyTruckId === null,
      `${staged.assetTag} — the picker no longer offers it, but the action stays defensive`,
    )

    const rental = await tx.rental.findFirstOrThrow({
      where: { assetId: spare.id, status: 'OPEN' },
      include: { customer: { select: { internal: true } } },
    })
    check(
      'the grab lands on the rental ledger as an INTERNAL rental',
      rental.kind === 'INTERNAL' && rental.customer?.internal === true,
      `destination "${rental.destination}"`,
    )
    const [row] = await tx.$queryRaw<{ period: string | null }[]>`
      SELECT period::text FROM "Rental" WHERE id = ${rental.id}
    `
    check('the reservation window is written for a grab too', Boolean(row?.period))

    const after = await tx.consumableStock.findFirstOrThrow({
      where: { consumableId: glasses.id, locationId: office.id },
    })
    check(
      'supplies decrement, from the office they were taken from',
      after.onHand === before.onHand - 2,
      `${office.name}: ${before.onHand} → ${after.onHand}`,
    )

    const txns = await tx.consumableTxn.count({
      where: { consumableId: glasses.id, qtyDelta: -2, destination: 'Marcellus Pad 7' },
    })
    check('a ledger row explains the decrement', txns === 1)

    // Scoped by this grab's destination, not to every EQUIPMENT_TAKEN row in
    // the org: real grabs made through the running app are committed data, and
    // counting them here would fail because somebody used the product.
    const alerts = await tx.notification.findMany({
      where: { orgId: org.id, type: 'EQUIPMENT_TAKEN', body: { contains: 'Marcellus Pad 7' } },
      include: { user: { select: { email: true } } },
    })
    const recipients = alerts.map((alert) => alert.user.email).sort()
    check(
      'managers and admins are alerted, and only them',
      recipients.length === 2 &&
        recipients.includes('ray@teksolv.com') &&
        recipients.includes('sam@teksolv.com'),
      recipients.join(', '),
    )
    check(
      'the alert names the gear and where it went',
      alerts[0].body?.includes(spare.assetTag) === true &&
        alerts[0].body?.includes('Marcellus Pad 7') === true,
      alerts[0].body ?? '',
    )
  })

  // A supervisor grabbing shouldn't notify themselves.
  await sandbox(async (tx) => {
    await grab(tx, org.id, admin.id, admin.id, {
      assetIds: [spare.id],
      supplies: {},
      destination: 'Yard',
    })
    const alerts = await tx.notification.findMany({
      where: { orgId: org.id, type: 'EQUIPMENT_TAKEN', body: { contains: 'Yard' } },
      include: { user: { select: { email: true } } },
    })
    check(
      'the person doing the grabbing is not alerted about themselves',
      !alerts.some((alert) => alert.user.email === 'ray@teksolv.com'),
      alerts.map((alert) => alert.user.email).join(', ') || '(none)',
    )
  })

  console.log('\nAtomicity — the part that matters\n')

  await sandbox(async (tx) => {
    const beforeStock = (
      await tx.consumableStock.findFirstOrThrow({
        where: { consumableId: glasses.id, locationId: office.id },
      })
    ).onHand

    // Someone else takes the second unit a moment before we submit.
    await tx.asset.update({ where: { id: staged.id }, data: { status: 'IN_MAINTENANCE' } })

    let failed = ''
    try {
      await grab(tx, org.id, tech.id, tech.id, {
        assetIds: [spare.id, staged.id],
        supplies: { [glasses.id]: 2 },
        locationId: office.id,
        destination: FAILED_DESTINATION,
      })
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error)
    }
    check('a grab naming an unavailable unit is refused', failed.startsWith('TAKEN:'), failed)

    // In the real action this whole transaction rolls back. Simulated here by
    // checking that the guard fires *before* anything downstream is written.
    const stock = (
      await tx.consumableStock.findFirstOrThrow({
        where: { consumableId: glasses.id, locationId: office.id },
      })
    ).onHand
    check(
      'supplies are untouched when the equipment step fails',
      stock === beforeStock,
      `${beforeStock} → ${stock}`,
    )
    // Counted against a destination this run never used, so the org's real
    // grab history cannot mask a regression here.
    const alerts = await tx.notification.count({
      where: { orgId: org.id, type: 'EQUIPMENT_TAKEN', body: { contains: FAILED_DESTINATION } },
    })
    check('no alert claims equipment moved when it did not', alerts === 0, `${alerts} alert(s)`)
  })

  await sandbox(async (tx) => {
    let failed = ''
    try {
      await grab(tx, org.id, tech.id, tech.id, {
        assetIds: [],
        supplies: { [calGas.id]: 999 },
        destination: FAILED_DESTINATION,
      })
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error)
    }
    check('taking more supplies than exist is refused', failed.startsWith('SHORT:'), failed)
  })

  await sandbox(async (tx) => {
    let refused = false
    try {
      const shelf = await tx.consumableStock.findFirstOrThrow({
        where: { consumableId: calGas.id },
      })
      await tx.consumableStock.update({ where: { id: shelf.id }, data: { onHand: -1 } })
    } catch (error) {
      refused = String(error).includes('consumable_stock_on_hand_non_negative')
    }
    check('the database refuses negative stock regardless of code path', refused)
  })

  console.log('\nValidation\n')

  const empty = grabSchema.safeParse({ takenById: 'u', destination: 'Pad 7', assetIds: [], supplies: {} })
  check('an empty cart is refused', !empty.success, empty.success ? '' : empty.error.issues[0]?.message)

  const noDestination = grabSchema.safeParse({
    takenById: 'u',
    destination: '',
    assetIds: ['a'],
    supplies: {},
  })
  check(
    'a grab with no destination is refused',
    !noDestination.success,
    noDestination.success ? '' : noDestination.error.issues[0]?.message,
  )

  // Supplies come off a specific shelf now, so a supplies-only grab has to say
  // which office. Equipment does not — a serialized unit is wherever it is —
  // which is why the office is only required when supplies are in the cart.
  const suppliesNoOffice = grabSchema.safeParse({
    takenById: 'u',
    destination: 'Pad 7',
    assetIds: [],
    supplies: { x: 2 },
  })
  check(
    'taking supplies without naming an office is refused',
    !suppliesNoOffice.success,
    suppliesNoOffice.success ? '' : suppliesNoOffice.error.issues[0]?.message,
  )

  const suppliesOnly = grabSchema.safeParse({
    takenById: 'u',
    destination: 'Pad 7',
    assetIds: [],
    supplies: { x: 2 },
    locationId: 'office-1',
  })
  check('supplies alone, from a named office, are a valid grab', suppliesOnly.success)

  const equipmentOnly = grabSchema.safeParse({
    takenById: 'u',
    destination: 'Pad 7',
    assetIds: ['a'],
    supplies: {},
  })
  check(
    'equipment alone still needs no office — a unit is wherever it is',
    equipmentOnly.success,
  )

  const stock = await db.consumableStock.findFirstOrThrow({
    where: { consumableId: glasses.id, locationId: office.id },
  })
  check(
    'nothing leaked out of the sandboxes',
    stock.onHand === openingStock,
    `${stock.onHand} on hand at ${office.name}, opened at ${openingStock}`,
  )

  console.log(failures === 0 ? '\nAll grab checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
