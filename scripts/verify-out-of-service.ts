/**
 * The Out of Service view, and the two paths into it.
 *
 * The scenario asked for, driven through the browser:
 *
 *   • check a rental in marked DAMAGED → the unit appears in the Out of
 *     Service tab straight away, carrying its reason, and now opens a repair
 *     ticket the way a failed inspection always has;
 *   • return it to service from that tab → it goes back to AVAILABLE and
 *     leaves the list;
 *   • fail a harness inspection → it appears too, classified as a failed
 *     inspection, with no wiring between the inspection and this screen;
 *   • flip a unit out of service by hand → it appears with no ticket, and the
 *     resolve path files a repair record instead.
 *
 * The point being checked throughout is that the tab is a *filter*, not a
 * list: nothing populates it, and nothing can be missing from it.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-out-of-service.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listOutOfService } from '../src/lib/maintenance-queue'
import { pickTemplatesForAsset } from '../src/lib/inspections'
import { FP01_HARNESS } from '../src/lib/inspection-forms'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const DAMAGE_NOTE = 'OOSTEST: bent frame and a cracked sight glass.'
const REPAIR_NOTE = 'OOSTEST: straightened the frame, new sight glass, pressure tested.'

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

async function main() {
  const startedAt = new Date()
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const created = { rentals: [] as string[], inspections: [] as string[], tickets: [] as string[] }
  const restore: { assetId: string; status: string; notes: string | null }[] = []

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  /** The Out of Service tab, as rendered. */
  async function tabText(): Promise<string> {
    await page.goto(`${BASE}/maintenance?tab=oos`, { waitUntil: 'networkidle' })
    return page.locator('main').innerText()
  }

  try {
    await signIn(page, 'sam@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nA damaged return lands in the tab on its own\n')
    // -----------------------------------------------------------------------

    const unit = await db.asset.findFirstOrThrow({
      where: { active: true, status: 'AVAILABLE', custodyType: null },
      orderBy: { assetTag: 'asc' },
    })
    restore.push({ assetId: unit.id, status: unit.status, notes: unit.notes })

    // Rent it out through the app rather than writing a Rental row: the
    // exclusion constraint and the deferred period trigger are part of what a
    // real checkout satisfies, and a hand-made row would dodge both.
    await page.goto(`${BASE}/rentals/checkout?assetId=${unit.id}`, { waitUntil: 'networkidle' })
    // An existing customer rather than a new one: this run is about what a
    // damaged return does, and inventing a customer only leaves more to unwind.
    await page.locator('select[name="customerId"]').selectOption({ index: 1 })
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await page.fill('input[name="expectedReturnDate"]', due)
    await page.locator('select[name="checkedOutBy"]').selectOption({ index: 1 })
    await page.locator('button[type="submit"]').filter({ hasText: /Check out/i }).first().click()
    // Checkout now lands on the *order* it created — a single-unit checkout is
    // an order with one line, and it goes to the same page a four-unit one does.
    await page.waitForURL(/\/rentals\/orders\/[a-z0-9]{20,}$/, { timeout: 45_000 })

    const rental = await db.rental.findFirstOrThrow({
      where: { assetId: unit.id, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
    })
    created.rentals.push(rental.id)

    // …and bring it back damaged.
    await page.goto(`${BASE}/rentals/${rental.id}`, { waitUntil: 'networkidle' })
    await page.locator('select[name="checkinCondition"]').selectOption('DAMAGED')
    await page.fill('textarea[name="checkinNotes"]', DAMAGE_NOTE)
    await page.getByRole('button', { name: /Check in/i }).click()
    await page.waitForURL(/\/inventory\//, { timeout: 45_000 })

    const afterCheckin = await db.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'a damaged return takes the unit out of service',
      afterCheckin.status === 'OUT_OF_SERVICE',
      afterCheckin.status,
    )

    // The gap this fixes: it used to only flip the status, leaving the unit
    // out of service with no work item and no way back.
    const damageTicket = await db.maintenanceTicket.findFirst({
      where: { assetId: unit.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (damageTicket) created.tickets.push(damageTicket.id)
    check(
      'and now opens a repair ticket, the way a failed inspection does',
      Boolean(damageTicket) && damageTicket!.priority === 'HIGH',
      damageTicket ? `${damageTicket.priority} · ${damageTicket.title}` : 'no ticket opened',
    )
    check(
      'carrying the note the person checking it in wrote',
      damageTicket?.description?.includes(DAMAGE_NOTE) ?? false,
    )
    check(
      'and it alerted managers rather than happening silently',
      (await prismaUnscoped.notification.count({
        where: {
          orgId: org.id,
          entityId: unit.id,
          createdAt: { gte: startedAt },
          title: { contains: 'returned damaged' },
        },
      })) > 0,
    )

    const rows = await listOutOfService(db)
    const row = rows.find((entry) => entry.asset.id === unit.id)
    check(
      'the unit is in the Out of Service list immediately',
      Boolean(row),
      `${rows.length} unit(s) out of service`,
    )
    check(
      'classified by how it got there',
      row?.source === 'damaged-checkin',
      `source=${row?.source}`,
    )
    check('showing why it is out', row?.reason?.includes(DAMAGE_NOTE) ?? false)
    check(
      'when it went out, and who did it',
      (row?.since?.getTime() ?? 0) >= startedAt.getTime() && row?.by === 'Sam Okafor',
      `${row?.since?.toISOString()} by ${row?.by}`,
    )
    check('and the ticket to clear', row?.ticket?.id === damageTicket?.id)

    const listing = await tabText()
    // Uppercased for the badge, which is CSS-transformed — `innerText` returns
    // what is painted, not what the component wrote.
    const shown = listing.toUpperCase()
    check(
      'the tab renders it — tag, reason and source, without expanding the row',
      shown.includes(unit.assetTag.toUpperCase()) &&
        shown.includes(DAMAGE_NOTE.toUpperCase()) &&
        shown.includes('DAMAGED CHECK-IN'),
      'the collapsed row leads with what is wrong, not with which order it came back on',
    )
    check(
      'and the tab is a live filter, not a list somebody maintains',
      listing.includes(`Out of service (${rows.length})`),
      `count on the chip matches the ${rows.length} units the filter returns`,
    )

    // -----------------------------------------------------------------------
    console.log('\nOther open faults block the way back\n')
    // -----------------------------------------------------------------------

    const blocker = await prismaUnscoped.maintenanceTicket.create({
      data: {
        orgId: org.id,
        assetId: unit.id,
        title: 'OOSTEST: second fault',
        priority: 'MEDIUM',
        status: 'OPEN',
      },
    })
    created.tickets.push(blocker.id)

    const blocked = (await listOutOfService(db)).find((entry) => entry.asset.id === unit.id)
    check(
      'the row says how many other faults are still open',
      blocked?.otherLiveTickets === 1,
      `${blocked?.otherLiveTickets} other live ticket(s)`,
    )

    await page.goto(`${BASE}/maintenance?tab=oos`, { waitUntil: 'networkidle' })
    await page.locator(`button:has-text("${unit.assetTag}")`).first().click()
    await page.fill('textarea[name="note"]', REPAIR_NOTE)
    await page.getByRole('button', { name: /Return to service/i }).click()
    await page.waitForTimeout(2500)

    const stillOut = await db.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check(
      'returning it is refused while another ticket is live — the existing rule, not a new one',
      stillOut.status === 'OUT_OF_SERVICE',
      stillOut.status,
    )
    check(
      'and it says so on the row',
      (await page.locator('main').innerText()).toLowerCase().includes('still has'),
    )

    // -----------------------------------------------------------------------
    console.log('\nReturn to service clears it out of the tab\n')
    // -----------------------------------------------------------------------

    await prismaUnscoped.maintenanceTicket.update({
      where: { id: blocker.id },
      data: { status: 'CLOSED', resolvedAt: new Date() },
    })

    await page.goto(`${BASE}/maintenance?tab=oos`, { waitUntil: 'networkidle' })
    await page.locator(`button:has-text("${unit.assetTag}")`).first().click()
    await page.fill('textarea[name="note"]', REPAIR_NOTE)
    await page.getByRole('button', { name: /Return to service/i }).click()
    await page.waitForTimeout(2500)

    const returned = await db.asset.findUniqueOrThrow({ where: { id: unit.id } })
    check('return to service puts it back to Available', returned.status === 'AVAILABLE', returned.status)

    const clearedTicket = await prismaUnscoped.maintenanceTicket.findUniqueOrThrow({
      where: { id: damageTicket!.id },
    })
    check(
      'through the ticket machinery — the ticket is resolved and carries the fix',
      clearedTicket.status === 'RESOLVED' && (clearedTicket.description?.includes(REPAIR_NOTE) ?? false),
      `${clearedTicket.status}`,
    )

    const afterReturn = await listOutOfService(db)
    check(
      'and it is gone from the list',
      !afterReturn.some((entry) => entry.asset.id === unit.id),
      `${afterReturn.length} unit(s) still out`,
    )
    const afterListing = await tabText()
    check('gone from the rendered tab too', !afterListing.includes(unit.assetTag))

    // -----------------------------------------------------------------------
    console.log('\nA failed inspection arrives by itself\n')
    // -----------------------------------------------------------------------

    const template = await prismaUnscoped.inspectionTemplate.findFirstOrThrow({
      where: { orgId: org.id, slug: FP01_HARNESS.slug },
      include: { items: { orderBy: { order: 'asc' } } },
    })
    const candidates = await prismaUnscoped.asset.findMany({
      where: { orgId: org.id, active: true, status: 'AVAILABLE' },
      orderBy: { assetTag: 'asc' },
    })
    let harness: (typeof candidates)[number] | null = null
    for (const candidate of candidates) {
      const offered = await pickTemplatesForAsset(db, candidate.id)
      if (offered.some((entry) => entry.template.id === template.id)) {
        harness = candidate
        break
      }
    }
    if (!harness) throw new Error('no available unit that FP-01 applies to')
    restore.push({ assetId: harness.id, status: harness.status, notes: harness.notes })

    await page.goto(`${BASE}/inspections/run?assetId=${harness.id}&templateId=${template.id}`, {
      waitUntil: 'networkidle',
    })
    for (const item of template.items) {
      const value = item.id === template.items[0].id ? 'FAIL' : 'PASS'
      await page.locator(`label:has(input[name="item.${item.id}.value"][value="${value}"])`).click()
    }
    const pad = page.locator('canvas').first()
    await pad.scrollIntoViewIfNeeded()
    const box = await pad.boundingBox()
    if (!box) throw new Error('signature pad has no box')
    await page.mouse.move(box.x + 20, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 30, box.y + 20, { steps: 12 })
    await page.mouse.up()
    await page.getByRole('button', { name: /File.*inspection/ }).click()
    // A filed inspection lands on its printed form where the template has
    // one, and on the record where it does not.
    await page.waitForURL(/\/inspections\/[a-z0-9]{20,}(\/form)?(\?|$)/, { timeout: 45_000 })

    const inspection = await prismaUnscoped.inspection.findFirstOrThrow({
      where: { assetId: harness.id, templateId: template.id },
      orderBy: { createdAt: 'desc' },
    })
    created.inspections.push(inspection.id)

    const failedRow = (await listOutOfService(db)).find((entry) => entry.asset.id === harness.id)
    check(
      'a failed inspection puts the unit in the same list, with no wiring between them',
      Boolean(failedRow),
      'both paths already flip the status — the tab is a filter on it',
    )
    check(
      'and it is classified as a failed inspection, not a damaged return',
      failedRow?.source === 'failed-inspection',
      `source=${failedRow?.source}`,
    )
    check(
      'carrying the failed item as the reason and the critical ticket to clear',
      (failedRow?.reason?.includes(template.items[0].label) ?? false) &&
        failedRow?.ticket?.priority === 'CRITICAL',
      failedRow?.ticket?.title,
    )

    // -----------------------------------------------------------------------
    console.log('\nA unit taken out by hand has no ticket, and still resolves\n')
    // -----------------------------------------------------------------------

    const manual = await db.asset.findFirstOrThrow({
      where: { active: true, status: 'AVAILABLE', custodyType: null, id: { not: unit.id } },
      orderBy: { assetTag: 'desc' },
    })
    restore.push({ assetId: manual.id, status: manual.status, notes: manual.notes })

    await page.goto(`${BASE}/inventory/${manual.id}/edit`, { waitUntil: 'networkidle' })
    await page.locator('select[name="status"]').selectOption('OUT_OF_SERVICE')
    await page.getByRole('button', { name: /Save/i }).first().click()
    await page.waitForTimeout(2500)

    const manualRow = (await listOutOfService(db)).find((entry) => entry.asset.id === manual.id)
    check(
      'a hand-set status shows up as well — no path escapes the filter',
      Boolean(manualRow),
      `${manual.assetTag}`,
    )
    check(
      'read off the audit trail as a manual change, with no ticket to clear',
      manualRow?.source === 'manual' && manualRow?.ticket === null,
      `source=${manualRow?.source}, ticket=${manualRow?.ticket ? 'yes' : 'none'}`,
    )

    await page.goto(`${BASE}/maintenance?tab=oos`, { waitUntil: 'networkidle' })
    await page.locator(`button:has-text("${manual.assetTag}")`).first().click()
    await page.fill('textarea[name="workDone"]', REPAIR_NOTE)
    await page.getByRole('button', { name: /Return to service/i }).click()
    await page.waitForTimeout(2500)

    const manualBack = await db.asset.findUniqueOrThrow({ where: { id: manual.id } })
    check(
      'with no ticket it goes through log-service instead, and still comes back',
      manualBack.status === 'AVAILABLE',
      manualBack.status,
    )
    check(
      'filing the repair to the unit’s history rather than nowhere',
      (await prismaUnscoped.maintenanceRecord.count({
        where: { assetId: manual.id, workDone: { contains: 'OOSTEST' } },
      })) === 1,
      'the same record any other service writes',
    )

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // Unwind, newest first. Only rows this run created are removed.
    await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { orgId: org.id, workDone: { contains: 'OOSTEST' } },
    })
    for (const id of created.inspections) {
      await prismaUnscoped.maintenanceTicket.deleteMany({ where: { sourceInspectionId: id } })
      await prismaUnscoped.attachment.deleteMany({ where: { url: `/inspections/${id}/form` } })
      await prismaUnscoped.inspectionResponse.deleteMany({ where: { inspectionId: id } })
      await prismaUnscoped.inspection.deleteMany({ where: { id } })
    }
    if (created.tickets.length) {
      await prismaUnscoped.maintenanceTicket.deleteMany({ where: { id: { in: created.tickets } } })
    }
    for (const id of created.rentals) {
      await prismaUnscoped.rental.deleteMany({ where: { id } })
    }
    await prismaUnscoped.notification.deleteMany({
      where: { orgId: org.id, createdAt: { gte: startedAt }, title: { contains: 'returned damaged' } },
    })
    for (const entry of restore) {
      await prismaUnscoped.asset.update({
        where: { id: entry.assetId },
        // A damaged check-in overwrites `notes`; put back whatever was there,
        // which for a unit that already carried one is not null.
        data: { status: entry.status as never, notes: entry.notes },
      })
    }
    console.log(`\n(restored ${restore.length} unit(s) and removed this run's records)`)
  }

  console.log(failures === 0 ? '\nAll out-of-service checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
