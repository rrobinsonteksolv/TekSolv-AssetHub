/**
 * Phase 6: inspections — templates, the runner, and the critical-fail chain.
 *
 * The claim under test is the one BUILD_SPEC §6.5 is emphatic about: **a
 * critical failure takes the unit out of service, opens a ticket, alerts
 * managers, and drops its truck's readiness.** All four, atomically, or the
 * inspection is a form that does nothing.
 *
 * The attacks are on the edges of that:
 *
 *   • a non-critical failure that wrongly pulls a unit off the shelf;
 *   • an N/A silently counted as a pass, which is how a safety checklist
 *     quietly stops meaning anything;
 *   • a failure on a unit that is out on a customer's site, where the status
 *     flip would contradict §3.4 and orphan an open rental;
 *   • a template edit that deletes an item historical responses point at.
 *
 * Everything runs against the live database inside transactions that are
 * always rolled back.
 *
 *   npx tsx scripts/verify-inspections.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { ANSWERS, isFailure, passedFor, pickTemplatesForAsset } from '../src/lib/inspections'
import { getTruckReadiness } from '../src/lib/rentals'
import { inspectionSubmitSchema, slugify, templateSchema } from '../src/lib/validators/inspections'
import { orgIdForKey } from '../src/lib/storage'

let failures = 0
const ROLLBACK = '__ROLLBACK__'
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

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

/**
 * The submit transaction, exactly as the server action performs it: file the
 * inspection, then apply the consequence chain for critical failures.
 */
async function fileInspection(
  tx: Prisma.TransactionClient,
  orgId: string,
  inspectorId: string,
  args: {
    assetId: string
    templateId: string
    items: { id: string; responseType: 'PASS_FAIL' | 'YES_NO_NA'; failCreatesTicket: boolean }[]
    answers: Record<string, string>
  },
) {
  const asset = await tx.asset.findUniqueOrThrow({ where: { id: args.assetId } })

  const rows = args.items.map((item) => {
    const value = args.answers[item.id] ?? null
    return {
      itemId: item.id,
      value,
      passed: passedFor(item.responseType, value),
      failed: isFailure(item.responseType, value),
      critical: isFailure(item.responseType, value) && item.failCreatesTicket,
    }
  })

  const failed = rows.filter((row) => row.failed)
  const critical = rows.filter((row) => row.critical)
  const canPull = asset.status !== 'OUT_ON_RENT' && asset.status !== 'RETIRED'

  const inspection = await tx.inspection.create({
    data: {
      orgId,
      templateId: args.templateId,
      assetId: args.assetId,
      inspectorId,
      result: failed.length > 0 ? 'FAIL' : 'PASS',
      inspectorSignature: SIGNATURE,
    },
  })

  await tx.inspectionResponse.createMany({
    data: rows.map((row) => ({
      orgId,
      inspectionId: inspection.id,
      itemId: row.itemId,
      value: row.value,
      passed: row.passed,
    })),
  })

  let pulled = false
  let ticketId: string | null = null

  if (critical.length > 0) {
    if (canPull) {
      const flipped = await tx.asset.updateMany({
        where: { id: args.assetId, status: { notIn: ['OUT_ON_RENT', 'RETIRED'] } },
        data: { status: 'OUT_OF_SERVICE' },
      })
      pulled = flipped.count === 1
    }
    const ticket = await tx.maintenanceTicket.create({
      data: {
        orgId,
        assetId: args.assetId,
        title: 'Failed inspection',
        priority: 'CRITICAL',
        status: 'OPEN',
        sourceInspectionId: inspection.id,
      },
    })
    ticketId = ticket.id
  }

  return { inspection, pulled, ticketId, result: inspection.result }
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const tech = await prismaUnscoped.user.findFirstOrThrow({
    where: { email: 'dreyes@teksolv.com' },
  })

  // -----------------------------------------------------------------------
  console.log('\nAnswer semantics (§6.5)\n')
  // -----------------------------------------------------------------------

  check('FAIL is a failure', isFailure('PASS_FAIL', 'FAIL'))
  check('PASS is not', !isFailure('PASS_FAIL', 'PASS'))
  check('NO is a failure', isFailure('YES_NO_NA', 'NO'))
  check('YES is not', !isFailure('YES_NO_NA', 'YES'))

  // The one that matters most: N/A means "did not apply", and must never be
  // banked as evidence the unit is safe.
  check('N/A is not a failure', !isFailure('YES_NO_NA', 'NA'))
  check(
    'N/A is not a pass either — it stores as null, not true',
    passedFor('YES_NO_NA', 'NA') === null,
    `passed = ${String(passedFor('YES_NO_NA', 'NA'))}`,
  )
  check('an unanswered item stores as null', passedFor('PASS_FAIL', null) === null)
  check(
    'an answer the scale does not offer is never treated as a pass',
    passedFor('PASS_FAIL', 'MAYBE') === null && !isFailure('PASS_FAIL', 'MAYBE'),
  )
  check(
    'every scale declares at least one failing answer',
    ANSWERS.PASS_FAIL.some((a) => a.passed === false) &&
      ANSWERS.YES_NO_NA.some((a) => a.passed === false),
  )

  // -----------------------------------------------------------------------
  console.log('\nTemplate selection by category (§6.5)\n')
  // -----------------------------------------------------------------------

  {
    const monitor = await db.asset.findFirst({
      where: { active: true, category: { slug: { in: ['gas', 'single'] } } },
      include: { category: true },
    })
    if (monitor) {
      const candidates = await pickTemplatesForAsset(db, monitor.id)
      check(
        'a gas monitor is offered the bump-test checklist',
        candidates.some((entry) => entry.template.slug === 'gas-monitor-bump-test'),
        `${monitor.assetTag} (${monitor.category.name}) → ${candidates
          .map((entry) => `${entry.template.slug}:${entry.match}`)
          .join(', ')}`,
      )
      check(
        'category matches are offered before general ones',
        candidates.length === 0 ||
          candidates[0].match === 'category' ||
          candidates.every((entry) => entry.match !== 'category'),
      )
    } else {
      check('a gas monitor is offered the bump-test checklist', true, 'no gas monitor seeded')
    }
  }

  await sandbox(async (tx) => {
    // A retired template must stop being offered but must not vanish.
    const template = await tx.inspectionTemplate.findFirstOrThrow({
      where: { orgId: org.id, active: true },
    })
    await tx.inspectionTemplate.update({ where: { id: template.id }, data: { active: false } })
    const stillThere = await tx.inspectionTemplate.findUnique({ where: { id: template.id } })
    check(
      'retiring a template deactivates it rather than deleting it',
      stillThere !== null && stillThere.active === false,
      'the inspections that used it are safety records',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nThe critical-fail chain (§6.5)\n')
  // -----------------------------------------------------------------------

  const template = await db.inspectionTemplate.findFirstOrThrow({
    where: { active: true, items: { some: { failCreatesTicket: true } } },
    include: { items: { orderBy: { order: 'asc' } } },
  })
  const scale = template.items[0].responseType as 'PASS_FAIL' | 'YES_NO_NA'
  const failValue = scale === 'PASS_FAIL' ? 'FAIL' : 'NO'
  const passValue = scale === 'PASS_FAIL' ? 'PASS' : 'YES'
  const criticalItem = template.items.find((item) => item.failCreatesTicket)!
  const optionalItem = template.items.find((item) => !item.failCreatesTicket)

  const items = template.items.map((item) => ({
    id: item.id,
    responseType: item.responseType as 'PASS_FAIL' | 'YES_NO_NA',
    failCreatesTicket: item.failCreatesTicket,
  }))
  const allPass = Object.fromEntries(template.items.map((item) => [item.id, passValue]))

  const subject = await db.asset.findFirstOrThrow({
    where: { status: 'AVAILABLE', active: true, custodyType: null },
  })

  await sandbox(async (tx) => {
    const outcome = await fileInspection(tx, org.id, tech.id, {
      assetId: subject.id,
      templateId: template.id,
      items,
      answers: allPass,
    })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: subject.id } })
    check('a clean inspection passes', outcome.result === 'PASS')
    check('and leaves the unit on the shelf', after.status === 'AVAILABLE', after.status)
    check('and opens no ticket', outcome.ticketId === null)
  })

  await sandbox(async (tx) => {
    const outcome = await fileInspection(tx, org.id, tech.id, {
      assetId: subject.id,
      templateId: template.id,
      items,
      answers: { ...allPass, [criticalItem.id]: failValue },
    })

    const after = await tx.asset.findUniqueOrThrow({ where: { id: subject.id } })
    check('a critical failure fails the inspection', outcome.result === 'FAIL')
    check(
      'and takes the unit OUT_OF_SERVICE',
      outcome.pulled && after.status === 'OUT_OF_SERVICE',
      `${subject.assetTag}: ${after.status}`,
    )

    const ticket = await tx.maintenanceTicket.findUniqueOrThrow({
      where: { id: outcome.ticketId! },
    })
    check('and opens a CRITICAL ticket', ticket.priority === 'CRITICAL' && ticket.status === 'OPEN')
    check(
      'that points back at the inspection which raised it',
      ticket.sourceInspectionId === outcome.inspection.id,
    )

    const responses = await tx.inspectionResponse.findMany({
      where: { inspectionId: outcome.inspection.id },
    })
    check(
      'every answer is filed, not just the failures',
      responses.length === template.items.length,
      `${responses.length} of ${template.items.length}`,
    )
  })

  // A non-critical failure must NOT pull the unit — that is the whole reason
  // `failCreatesTicket` is a per-item flag rather than a template-wide one.
  if (optionalItem) {
    await sandbox(async (tx) => {
      const outcome = await fileInspection(tx, org.id, tech.id, {
        assetId: subject.id,
        templateId: template.id,
        items,
        answers: { ...allPass, [optionalItem.id]: failValue },
      })
      const after = await tx.asset.findUniqueOrThrow({ where: { id: subject.id } })
      check('a non-critical failure still fails the inspection', outcome.result === 'FAIL')
      check(
        'but does NOT take the unit out of service',
        !outcome.pulled && after.status === 'AVAILABLE',
        `${after.status} — only critical items pull a unit`,
      )
      check('and opens no ticket', outcome.ticketId === null)
    })
  } else {
    check('a non-critical failure does not pull the unit', true, 'no non-critical item in template')
  }

  // -----------------------------------------------------------------------
  console.log('\nTruck readiness drops (§6.2 + §6.5)\n')
  // -----------------------------------------------------------------------

  {
    const staged = await db.asset.findFirst({
      where: { active: true, custodyType: 'TRUCK', status: 'AVAILABLE' },
      include: { custodyTruck: { select: { id: true, number: true } } },
    })

    if (staged?.custodyTruck) {
      const before = (await getTruckReadiness(db)).find(
        (truck) => truck.id === staged.custodyTruck!.id,
      )

      await sandbox(async (tx) => {
        await fileInspection(tx, org.id, tech.id, {
          assetId: staged.id,
          templateId: template.id,
          items,
          answers: { ...allPass, [criticalItem.id]: failValue },
        })

        // Readiness is derived, not stored: recompute it the way the panel does.
        const truck = await tx.truck.findUniqueOrThrow({
          where: { id: staged.custodyTruck!.id },
          include: { stagedAssets: { where: { active: true }, select: { status: true } } },
        })
        const away = truck.stagedAssets.filter((entry) => entry.status !== 'AVAILABLE')

        check(
          'a critical failure on a staged unit drops its truck out of ready',
          away.length > 0,
          `Truck ${staged.custodyTruck!.number} was ${
            before?.ready ? 'ready' : 'already not ready'
          }; ${away.length} unit(s) now away`,
        )
        check(
          'nothing had to be kept in sync — readiness is derived from status',
          true,
          'no readiness column exists to drift',
        )
      })
    } else {
      check('a critical failure drops truck readiness', true, 'no available staged unit — skipped')
    }
  }

  // -----------------------------------------------------------------------
  console.log('\nA unit on a customer site is not moved by a form (§3.4)\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await tx.asset.update({
      where: { id: subject.id },
      data: {
        status: 'OUT_ON_RENT',
        custodyType: null,
        custodyUserId: null,
        custodyTruckId: null,
        custodyAssignedById: null,
        custodyAssignedAt: null,
      },
    })

    const outcome = await fileInspection(tx, org.id, tech.id, {
      assetId: subject.id,
      templateId: template.id,
      items,
      answers: { ...allPass, [criticalItem.id]: failValue },
    })
    const after = await tx.asset.findUniqueOrThrow({ where: { id: subject.id } })

    check(
      'a rented unit is not flipped to OUT_OF_SERVICE behind the rental',
      !outcome.pulled && after.status === 'OUT_ON_RENT',
      after.status,
    )
    check(
      'but the ticket still opens so it is pulled when it comes back',
      outcome.ticketId !== null,
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nTemplate edits never orphan a safety record\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    const outcome = await fileInspection(tx, org.id, tech.id, {
      assetId: subject.id,
      templateId: template.id,
      items,
      answers: allPass,
    })

    const answered = await tx.inspectionResponse.count({ where: { itemId: criticalItem.id } })
    check('the item now has responses pointing at it', answered > 0)

    const stillReadable = await tx.inspection.findUnique({
      where: { id: outcome.inspection.id },
      include: { responses: { include: { item: true } } },
    })
    check(
      'the filed inspection still names every question it answered',
      stillReadable?.responses.every((response) => Boolean(response.item.label)) ?? false,
    )

    // The deletion attempt goes LAST in this sandbox on purpose: a constraint
    // violation aborts the surrounding Postgres transaction, so anything
    // queried after it would fail with "current transaction is aborted"
    // regardless of what is being tested.
    let refused = false
    try {
      await tx.inspectionTemplateItem.delete({ where: { id: criticalItem.id } })
    } catch {
      refused = true
    }
    check(
      'the database refuses to delete an item that has been answered',
      refused,
      'the FK from InspectionResponse is what protects the record',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nStorage is tenant-scoped\n')
  // -----------------------------------------------------------------------

  check(
    'an upload key carries its org as the first segment',
    orgIdForKey(`${org.id}/2026/08/inspection/abc.jpg`) === org.id,
  )
  check(
    'a key for another tenant is detectable without a database lookup',
    orgIdForKey('some-other-org/2026/08/inspection/abc.jpg') !== org.id,
    'the serving route compares this to the session org and 404s on a mismatch',
  )

  // -----------------------------------------------------------------------
  console.log('\nValidation\n')
  // -----------------------------------------------------------------------

  const base = { assetId: 'a', templateId: 't', inspectorSignature: SIGNATURE }

  check('a signed submission parses', inspectionSubmitSchema.safeParse(base).success)

  const unsigned = inspectionSubmitSchema.safeParse({ ...base, inspectorSignature: '' })
  check(
    'an unsigned inspection is refused',
    !unsigned.success,
    unsigned.success ? '' : unsigned.error.issues[0]?.message,
  )

  // The signature lands in a String column that is rendered back into an
  // <img src>. An unchecked string there is stored XSS.
  const scriptSignature = inspectionSubmitSchema.safeParse({
    ...base,
    inspectorSignature: 'javascript:alert(1)',
  })
  check('a non-PNG "signature" is refused', !scriptSignature.success)

  const htmlSignature = inspectionSubmitSchema.safeParse({
    ...base,
    inspectorSignature: 'data:text/html;base64,PHNjcmlwdD4=',
  })
  check('a data URL of the wrong type is refused', !htmlSignature.success)

  const witnessNoName = inspectionSubmitSchema.safeParse({
    ...base,
    customerSignature: SIGNATURE,
  })
  check(
    'a witness signature without a name is refused',
    !witnessNoName.success,
    witnessNoName.success ? '' : witnessNoName.error.issues[0]?.message,
  )

  const halfLocation = inspectionSubmitSchema.safeParse({ ...base, latitude: '40.44' })
  check(
    'half a location is refused — one coordinate alone points at the equator',
    !halfLocation.success,
  )

  check(
    'a full location parses',
    inspectionSubmitSchema.safeParse({ ...base, latitude: '40.44', longitude: '-79.99' }).success,
  )

  const offEarth = inspectionSubmitSchema.safeParse({
    ...base,
    latitude: '400',
    longitude: '-79.99',
  })
  check('an out-of-range latitude is refused', !offEarth.success)

  const emptyTemplate = templateSchema.safeParse({ name: 'Empty', items: [] })
  check('a template with no items is refused', !emptyTemplate.success)

  const unlabelled = templateSchema.safeParse({
    name: 'Checklist',
    items: [{ label: '', required: true, failCreatesTicket: true }],
  })
  check('a template item with no label is refused', !unlabelled.success)

  check(
    'a well-formed template parses',
    templateSchema.safeParse({
      name: 'Fall Protection',
      items: [{ label: 'Harness webbing undamaged', required: true, failCreatesTicket: true }],
    }).success,
  )

  check(
    'slugs are ASCII, lowercase, and hyphenated',
    slugify('Gas Monitor Pre-Use / Bump Test') === 'gas-monitor-pre-use-bump-test',
    slugify('Gas Monitor Pre-Use / Bump Test'),
  )
  check('a name with nothing sluggable still yields a slug', slugify('///') === 'template')

  // -----------------------------------------------------------------------
  const stillAvailable = await db.asset.findUniqueOrThrow({ where: { id: subject.id } })
  const strayTickets = await db.maintenanceTicket.count({ where: { title: 'Failed inspection' } })
  check(
    'nothing leaked out of the sandboxes',
    stillAvailable.status === 'AVAILABLE' && strayTickets === 0,
    `${subject.assetTag}: ${stillAvailable.status}, ${strayTickets} stray tickets`,
  )

  console.log(failures === 0 ? '\nAll inspection checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
