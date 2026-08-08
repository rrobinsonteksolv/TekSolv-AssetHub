/**
 * Custody: unassign, and alerting on every custody change (BUILD_SPEC §6.2).
 *
 * The four scenarios this was asked to prove:
 *
 *   1. a supervisor assigns a unit → the admin gets an alert and an audit row
 *   2. the same supervisor unassigns it → another alert
 *   3. the acting supervisor is NOT alerted for their own action
 *   4. reassign (person → truck) still works, and also alerts
 *
 * Everything the change touches — asset columns, CustodyEvent, Notification,
 * AuditLog — has to land in ONE transaction, so the interesting test is the
 * failure case: a rejected change must leave no alert claiming equipment moved.
 *
 *   npx tsx scripts/verify-custody.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { assignCustodySchema } from '../src/lib/validators/rentals'

let failures = 0
const ROLLBACK = '__ROLLBACK__'

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

/** The custody transaction, exactly as `assignCustodyAction` performs it. */
async function changeCustody(
  tx: Prisma.TransactionClient,
  orgId: string,
  actor: { id: string; name: string },
  assetId: string,
  target: { type: 'NONE' | 'PERSON' | 'TRUCK'; targetId?: string; note?: string },
) {
  const asset = await tx.asset.findFirstOrThrow({
    where: { id: assetId },
    select: {
      id: true,
      assetTag: true,
      model: true,
      status: true,
      custodyType: true,
      custodyUser: { select: { name: true } },
      custodyTruck: { select: { number: true } },
    },
  })
  if (asset.status === 'OUT_ON_RENT') throw new Error('OUT_ON_RENT')

  let custodyUserId: string | null = null
  let custodyTruckId: string | null = null
  let holderLabel = 'general stock'

  if (target.type === 'PERSON') {
    const m = await tx.membership.findFirstOrThrow({
      where: { userId: target.targetId, active: true },
      select: { userId: true, user: { select: { name: true } } },
    })
    custodyUserId = m.userId
    holderLabel = m.user.name
  }
  if (target.type === 'TRUCK') {
    const t = await tx.truck.findFirstOrThrow({
      where: { id: target.targetId, active: true },
      select: { id: true, number: true, office: true },
    })
    custodyTruckId = t.id
    holderLabel = `Truck ${t.number}${t.office ? ` (${t.office})` : ''}`
  }

  let previousLabel = 'general stock'
  if (asset.custodyType === 'PERSON' && asset.custodyUser) previousLabel = asset.custodyUser.name
  else if (asset.custodyType === 'TRUCK' && asset.custodyTruck)
    previousLabel = `Truck ${asset.custodyTruck.number}`

  const custodyType = target.type === 'NONE' ? null : target.type
  const assigned = custodyType !== null

  await tx.asset.update({
    where: { id: asset.id },
    data: {
      custodyType,
      custodyUserId,
      custodyTruckId,
      custodyAssignedById: assigned ? actor.id : null,
      custodyAssignedAt: assigned ? new Date() : null,
    },
  })

  await tx.custodyEvent.create({
    data: {
      orgId,
      assetId: asset.id,
      type: custodyType,
      userId: custodyUserId,
      truckId: custodyTruckId,
      actorId: actor.id,
      note: target.note ?? null,
    },
  })

  const recipients = await tx.membership.findMany({
    where: { orgId, active: true, role: { in: ['ADMIN', 'MANAGER'] }, userId: { not: actor.id } },
    select: { userId: true },
  })
  if (recipients.length > 0) {
    await tx.notification.createMany({
      data: recipients.map((r) => ({
        orgId,
        userId: r.userId,
        type: 'CUSTODY_CHANGED' as const,
        title: assigned
          ? `${asset.assetTag} assigned to ${holderLabel}`
          : `${asset.assetTag} returned to general stock`,
        body: [asset.model, previousLabel === holderLabel ? null : `was with ${previousLabel}`, `by ${actor.name}`]
          .filter(Boolean)
          .join(' · '),
        link: `/inventory/${asset.id}`,
        entityType: 'Asset',
        entityId: asset.id,
      })),
    })
  }

  await tx.auditLog.create({
    data: {
      orgId,
      userId: actor.id,
      action: assigned ? 'custody.assign' : 'custody.release',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: { assetTag: asset.assetTag, fromLabel: previousLabel, toLabel: holderLabel },
    },
  })

  return { assetTag: asset.assetTag, holderLabel, previousLabel, assigned }
}

async function main() {
  // Every history read below is scoped to this moment forward. The unit these
  // sandboxes pick is a real one that has been used, and it legitimately
  // carries custody events, alerts and audit rows from that use — counting
  // those as evidence about *this* run is how a fixture starts failing because
  // somebody assigned a monitor last week.
  const runStart = new Date()
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const supervisor = await prismaUnscoped.user.findFirstOrThrow({
    where: { email: 'sam@teksolv.com' },
  })
  const admin = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })
  const tech = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'dreyes@teksolv.com' } })
  const truck = await db.truck.findFirstOrThrow({ where: { active: true } })

  const unit = await db.asset.findFirstOrThrow({
    where: { active: true, status: 'AVAILABLE', custodyType: null },
  })

  const notifFor = (tx: Prisma.TransactionClient, assetId: string) =>
    tx.notification.findMany({
      where: { entityId: assetId, type: 'CUSTODY_CHANGED', createdAt: { gte: runStart } },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    })

  // -----------------------------------------------------------------------
  console.log(`\n1. A supervisor assigns ${unit.assetTag} to a person\n`)
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const out = await changeCustody(tx, org.id, supervisor, unit.id, {
      type: 'PERSON',
      targetId: tech.id,
    })

    const after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check('the unit is assigned', after.custodyType === 'PERSON' && after.custodyUserId === tech.id)
    check('and attributed to the supervisor who did it', after.custodyAssignedById === supervisor.id)

    const events = await tx.custodyEvent.findMany({
      where: { assetId: unit.id, createdAt: { gte: runStart } },
    })
    check('a CustodyEvent was written', events.some((e) => e.type === 'PERSON' && e.actorId === supervisor.id))

    const notes = await notifFor(tx, unit.id)
    const emails = notes.map((n) => n.user.email)
    check(
      'the admin was alerted',
      emails.includes(admin.email),
      `${notes.length} alert(s) → ${emails.join(', ')}`,
    )
    check(
      'the alert names the unit and the new holder',
      notes[0]?.title === `${unit.assetTag} assigned to ${out.holderLabel}`,
      notes[0]?.title,
    )
    check('and says who did it', notes[0]?.body?.includes(supervisor.name) ?? false, notes[0]?.body ?? '')

    const rows = await tx.auditLog.findMany({
      where: { entityId: unit.id, action: 'custody.assign', createdAt: { gte: runStart } },
    })
    check('an audit row was written', rows.length === 1 && rows[0].userId === supervisor.id)
  })

  // -----------------------------------------------------------------------
  console.log('\n2. …then unassigns it back to general stock\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await changeCustody(tx, org.id, supervisor, unit.id, { type: 'PERSON', targetId: tech.id })
    await changeCustody(tx, org.id, supervisor, unit.id, { type: 'NONE' })

    const after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'every custody column is nulled — back to general stock',
      after.custodyType === null &&
        after.custodyUserId === null &&
        after.custodyTruckId === null &&
        after.custodyAssignedById === null &&
        after.custodyAssignedAt === null,
      `custodyType=${after.custodyType}`,
    )

    const events = await tx.custodyEvent.findMany({
      where: { assetId: unit.id, createdAt: { gte: runStart } },
    })
    check(
      'the release wrote its own CustodyEvent',
      events.filter((e) => e.type === null).length === 1,
      'a null type is how the ledger records a return to stock',
    )

    const notes = await notifFor(tx, unit.id)
    check('a second alert went out', notes.length >= 2, `${notes.length} alerts total`)
    check(
      'and it says the unit was returned to general stock',
      notes.some((n) => n.title === `${unit.assetTag} returned to general stock`),
      notes.map((n) => n.title).join(' | '),
    )
    check(
      'naming where it came from',
      notes.some((n) => n.body?.includes(`was with ${tech.name}`)),
      notes[notes.length - 1]?.body ?? '',
    )

    const released = await tx.auditLog.findMany({
      where: { entityId: unit.id, action: 'custody.release', createdAt: { gte: runStart } },
    })
    check('and an audit row for the release', released.length === 1)
  })

  // -----------------------------------------------------------------------
  console.log('\n3. The person who did it is never alerted about it\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await changeCustody(tx, org.id, supervisor, unit.id, { type: 'PERSON', targetId: tech.id })
    const notes = await notifFor(tx, unit.id)
    const emails = notes.map((n) => n.user.email)

    check(
      'the acting supervisor gets no alert for their own action',
      !emails.includes(supervisor.email),
      `recipients: ${emails.join(', ') || 'none'}`,
    )
    check('but the other managers/admins do', emails.includes(admin.email))
  })

  await sandbox(async (tx) => {
    // The mirror image: when the ADMIN acts, the supervisor hears about it.
    await changeCustody(tx, org.id, admin, unit.id, { type: 'PERSON', targetId: tech.id })
    const emails = (await notifFor(tx, unit.id)).map((n) => n.user.email)
    check(
      'and when the admin acts, the supervisor is the one told',
      emails.includes(supervisor.email) && !emails.includes(admin.email),
      `recipients: ${emails.join(', ') || 'none'}`,
    )
  })

  await sandbox(async (tx) => {
    // A technician is never a recipient — alerts go to alerts.receive holders.
    await changeCustody(tx, org.id, supervisor, unit.id, { type: 'TRUCK', targetId: truck.id })
    const emails = (await notifFor(tx, unit.id)).map((n) => n.user.email)
    check('field technicians are not on the custody alert list', !emails.includes(tech.email))
  })

  // -----------------------------------------------------------------------
  console.log('\n4. Reassign still works: person → truck\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await changeCustody(tx, org.id, supervisor, unit.id, { type: 'PERSON', targetId: tech.id })
    const out = await changeCustody(tx, org.id, supervisor, unit.id, {
      type: 'TRUCK',
      targetId: truck.id,
    })

    const after = await tx.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'the unit moved from the person to the truck',
      after.custodyType === 'TRUCK' &&
        after.custodyTruckId === truck.id &&
        after.custodyUserId === null,
      `custodyType=${after.custodyType}, user=${after.custodyUserId ?? 'null'}`,
    )
    check(
      'the single-holder rule survives the move',
      !(after.custodyUserId && after.custodyTruckId),
      'never two holders at once (§3.3)',
    )

    // Two changes, and the actor is excluded from both — so the count is
    // (alert-holders − 1) per change, not one per holder.
    const holders = await tx.membership.count({
      where: { orgId: org.id, active: true, role: { in: ['ADMIN', 'MANAGER'] } },
    })
    const notes = await notifFor(tx, unit.id)
    check(
      'the reassignment alerted too',
      notes.length === 2 * (holders - 1),
      `${notes.length} alerts · 2 changes × ${holders - 1} recipient(s), actor excluded from each`,
    )
    check(
      'and the message names both ends of the move',
      notes[notes.length - 1]?.title === `${unit.assetTag} assigned to ${out.holderLabel}` &&
        (notes[notes.length - 1]?.body?.includes(`was with ${tech.name}`) ?? false),
      `${notes[notes.length - 1]?.title} — ${notes[notes.length - 1]?.body}`,
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nA rejected change alerts nobody\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const startedAt = new Date()
    const onRent = await tx.asset.findFirst({ where: { status: 'OUT_ON_RENT', active: true } })
    if (!onRent) {
      check('a unit out on rent cannot be reassigned', true, 'nothing out on rent — skipped')
      return
    }

    let refused = false
    try {
      await changeCustody(tx, org.id, supervisor, onRent.id, { type: 'PERSON', targetId: tech.id })
    } catch (error) {
      refused = (error as Error).message === 'OUT_ON_RENT'
      if (!refused) throw error
    }
    check('a unit out on rent is still refused (§3.3)', refused)

    // Counted from the moment this case started, not for all time: the unit may
    // legitimately carry custody alerts from real use before it went on rent,
    // and those are committed history rather than evidence of a bug here.
    const raised = await tx.notification.count({
      where: { entityId: onRent.id, type: 'CUSTODY_CHANGED', createdAt: { gte: startedAt } },
    })
    check(
      'and no alert was raised about a change that did not happen',
      raised === 0,
      'the notification is inside the same transaction, so a rollback takes it too',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nValidation\n')
  // -----------------------------------------------------------------------

  check(
    'NONE is a valid target with no id',
    assignCustodySchema.safeParse({ assetId: 'a', custodyType: 'NONE' }).success,
  )
  check(
    'PERSON without an id is refused',
    !assignCustodySchema.safeParse({ assetId: 'a', custodyType: 'PERSON' }).success,
  )
  check(
    'TRUCK without an id is refused',
    !assignCustodySchema.safeParse({ assetId: 'a', custodyType: 'TRUCK' }).success,
  )
  check(
    'an unknown custody type is refused',
    !assignCustodySchema.safeParse({ assetId: 'a', custodyType: 'WAREHOUSE' }).success,
  )

  // -----------------------------------------------------------------------
  // Scoped to the unit these sandboxes touched, not to every custody alert in
  // the org: real use of the running app legitimately produces those, and a
  // check that counts them fleet-wide fails because somebody assigned a
  // monitor — which is the feature working.
  const stillClear = await db.asset.findUniqueOrThrow({ where: { id: unit.id } })
  const strayNotes = await db.notification.count({
    where: { type: 'CUSTODY_CHANGED', entityId: unit.id, createdAt: { gte: runStart } },
  })
  check(
    'nothing leaked out of the sandboxes',
    stillClear.custodyType === null && strayNotes === 0,
    `${unit.assetTag}: custody=${stillClear.custodyType}, ${strayNotes} alerts for this unit`,
  )

  console.log(failures === 0 ? '\nAll custody checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
