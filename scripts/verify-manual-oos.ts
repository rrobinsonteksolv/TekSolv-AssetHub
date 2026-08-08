/**
 * Taking a unit out of service by hand, and bringing it back.
 *
 * The automatic paths cover what the app was watching: a damaged check-in, a
 * failed in-app inspection. Plenty it was not — an AED that fails a *paper*
 * inspection on a dead battery is out of service in the world whether or not
 * anything here noticed. Before this, recording that meant editing the status
 * field, which left a unit in the Out of Service list with no reason and no way
 * back except another manual edit.
 *
 * What is actually being checked is that the manual action is the *same*
 * consequence path as the automatic ones, not a second one that resembles it:
 * the same ticket, the same audit row, the same Out of Service row, the same
 * return that refuses while other faults are open. So the assertions look past
 * the button and at what the other screens then see.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-manual-oos.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listOutOfService } from '../src/lib/maintenance-queue'
import { can } from '../src/lib/rbac'
import type { Role } from '@prisma/client'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

/** Marks everything this run writes, so cleanup never depends on a variable. */
const MARK = 'MANOOS'
const REASON = `${MARK}: failed the monthly paper inspection — battery dead, pads expired 2026-05.`
const FIX = `${MARK}: new battery pack and pads, self-test passed.`

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

  // A healthy unit with nothing else going on, so anything that shows up
  // afterwards was put there by this run.
  const unit = await db.asset.findFirstOrThrow({
    where: {
      active: true,
      status: 'AVAILABLE',
      custodyType: null,
      tickets: { none: { status: { in: ['OPEN', 'IN_PROGRESS'] } } },
    },
    orderBy: { assetTag: 'asc' },
    select: { id: true, assetTag: true, status: true, condition: true },
  })
  const before = { ...unit }

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const maintenanceTab = `${BASE}/inventory/${unit.id}?tab=maintenance`

  try {
    await signIn(page, 'sam@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nA healthy unit can be taken out of service by hand\n')
    // -----------------------------------------------------------------------

    await page.goto(maintenanceTab, { waitUntil: 'networkidle' })
    check(
      'the unit starts healthy',
      before.status === 'AVAILABLE',
      `${unit.assetTag} — ${before.status}, ${before.condition}`,
    )

    const takeOut = page.getByRole('button', { name: /Take out of service/i }).first()
    check('the action is on the unit, where somebody holding it would look', await takeOut.isVisible())

    await takeOut.click()
    await page.fill('textarea[name="description"]', REASON)
    await page.locator('select[name="priority"]').selectOption('HIGH')
    await page.getByRole('button', { name: /^Take out of service$/i }).last().click()

    await page.waitForFunction(
      () => !document.querySelector('textarea[name="description"]'),
      undefined,
      { timeout: 30_000 },
    )
    await page.waitForTimeout(600)

    const after = await db.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: { status: true },
    })
    check('it is out of service', after.status === 'OUT_OF_SERVICE', after.status)

    const ticket = await db.maintenanceTicket.findFirst({
      where: { assetId: unit.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'and it opened a ticket, so the reason has somewhere to live',
      ticket !== null,
      ticket ? `${ticket.priority} · ${ticket.title}` : 'no ticket',
    )
    check(
      'the reason is on the ticket, not just in somebody’s head',
      ticket?.description === REASON,
      ticket?.description ?? '—',
    )
    check(
      'the priority chosen is the priority recorded',
      ticket?.priority === 'HIGH',
      ticket?.priority ?? '—',
    )
    check(
      'the ticket title is the first line of the reason',
      ticket?.title === REASON.split('\n')[0].slice(0, 160),
      ticket?.title ?? '—',
    )

    // -----------------------------------------------------------------------
    console.log('\nIt is the same consequence path, not a second one\n')
    // -----------------------------------------------------------------------

    const audits = await db.auditLog.findMany({
      where: {
        entityType: 'Asset',
        entityId: unit.id,
        action: 'maintenance.ticket.create',
        createdAt: { gte: startedAt },
      },
      include: { user: { select: { name: true } } },
    })
    const audited = audits[0]
    check(
      'the transition is in the audit log',
      audited !== undefined,
      audited ? `${audited.action} by ${audited.user?.name}` : 'nothing logged',
    )
    check(
      'and the log records that it took the unit out — which is how the Out of Service list dates it',
      (audited?.metadata as Record<string, unknown> | null)?.tookOutOfService === true,
      JSON.stringify(audited?.metadata ?? null),
    )

    // The real assertion: the *other* screen, computed independently, sees it.
    const rows = await listOutOfService(db)
    const row = rows.find((entry) => entry.asset.id === unit.id)
    check('it appears in the Out of Service list', row !== undefined)
    check('carrying the reason', row?.reason === REASON, row?.reason ?? '—')
    check(
      'with a resolve path attached, like every other source',
      row?.ticket?.id === ticket?.id,
      row?.ticket ? `${row.source} · ticket ${row.ticket.status}` : 'no ticket on the row',
    )
    check('and a name against it', row?.by !== null, row?.by ?? '—')

    const oosTab = await (async () => {
      await page.goto(`${BASE}/maintenance?tab=oos`, { waitUntil: 'networkidle' })
      return page.locator('main').innerText()
    })()
    check('the tab renders it, not just the query', oosTab.includes(unit.assetTag))
    check('with the reason on screen', oosTab.includes('battery dead'), REASON)

    // -----------------------------------------------------------------------
    console.log('\nAnd it comes back the same way\n')
    // -----------------------------------------------------------------------

    await page.goto(maintenanceTab, { waitUntil: 'networkidle' })
    check(
      'the unit’s page now offers the way back instead',
      (await page.getByRole('button', { name: /Return to service/i }).count()) > 0 &&
        (await page.getByRole('button', { name: /Take out of service/i }).count()) === 0,
      'one action or the other, never both',
    )

    // A second live ticket: returning must be refused while it is open. This is
    // the rule the shared form exists to keep in one place.
    const blocker = await prismaUnscoped.maintenanceTicket.create({
      data: {
        orgId: org.id,
        assetId: unit.id,
        title: `${MARK}: second fault`,
        description: `${MARK}: case cracked as well.`,
        priority: 'LOW',
        status: 'OPEN',
      },
      select: { id: true },
    })

    await page.reload({ waitUntil: 'networkidle' })
    await page.fill('textarea[name="note"]', FIX)
    await page.getByRole('button', { name: /Return to service/i }).click()
    await page.waitForTimeout(1_200)

    const blocked = await db.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: { status: true },
    })
    check(
      'a second open ticket blocks the return',
      blocked.status === 'OUT_OF_SERVICE',
      'clearing one fault does not make a unit with two faults safe',
    )
    check(
      'and says so rather than failing quietly',
      (await page.locator('text=/still has 1 open ticket/i').count()) > 0,
      (await page.locator('main').innerText()).includes('open ticket') ? 'message shown' : 'no message',
    )

    await prismaUnscoped.maintenanceTicket.update({
      where: { id: blocker.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    })

    await page.goto(maintenanceTab, { waitUntil: 'networkidle' })
    await page.fill('textarea[name="note"]', FIX)
    await page.locator('select[name="conditionOnReturn"]').selectOption('GOOD')
    await page.getByRole('button', { name: /Return to service/i }).click()
    await page.waitForTimeout(1_500)

    const returned = await db.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: { status: true, condition: true },
    })
    check('with the faults cleared it goes back to Available', returned.status === 'AVAILABLE', returned.status)
    check(
      'and the condition was asked for, not assumed',
      returned.condition === 'GOOD',
      `condition now ${returned.condition}`,
    )

    const resolved = await db.maintenanceTicket.findUniqueOrThrow({
      where: { id: ticket!.id },
      select: { status: true, description: true },
    })
    check('the ticket it went out on is resolved', resolved.status === 'RESOLVED', resolved.status)
    check(
      'and the fix is appended to it, under the reason it went out',
      resolved.description?.includes(REASON) === true && resolved.description?.includes(FIX) === true,
      resolved.description?.replace(/\n+/g, ' · ') ?? '—',
    )

    const gone = await listOutOfService(db)
    check(
      'it has left the Out of Service list',
      !gone.some((entry) => entry.asset.id === unit.id),
      `${gone.length} unit(s) still out`,
    )

    // -----------------------------------------------------------------------
    console.log('\nWho can do it\n')
    // -----------------------------------------------------------------------

    const tech = await page.context().browser()!.newContext()
    const techPage = await tech.newPage()
    await signIn(techPage, 'dreyes@teksolv.com')
    await techPage.goto(maintenanceTab, { waitUntil: 'networkidle' })
    const techRole = await prismaUnscoped.membership.findFirstOrThrow({
      where: { orgId: org.id, user: { email: 'dreyes@teksolv.com' } },
      select: { role: true },
    })
    check(
      'a technician is not offered it',
      (await techPage.getByRole('button', { name: /Take out of service/i }).count()) === 0,
      `${techRole.role} — supervisor+ only, the same bar as every other consequence here`,
    )
    check(
      'nor the way back',
      (await techPage.getByRole('button', { name: /Return to service/i }).count()) === 0,
      'both directions sit behind the same permission',
    )
    await tech.close()

    // A hidden button is not a permission. Both directions post to actions that
    // call `requirePermission('maintenance.manage')` before touching anything,
    // so the gate is asserted against the matrix those guards read rather than
    // against what happens to be on screen.
    check(
      'and the permission itself is supervisor+, which is what the server checks',
      can('ADMIN' as Role, 'maintenance.manage') &&
        can('MANAGER' as Role, 'maintenance.manage') &&
        !can('TECHNICIAN' as Role, 'maintenance.manage') &&
        !can('VIEWER' as Role, 'maintenance.manage'),
      'createTicketAction and updateTicketAction both require it',
    )

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // Unconditional and keyed off the marker: a failure mid-run must not leave
    // a seeded unit sitting out of service.
    await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { orgId: org.id, workDone: { contains: MARK } },
    })
    await prismaUnscoped.maintenanceTicket.deleteMany({
      where: { orgId: org.id, title: { contains: MARK } },
    })
    await prismaUnscoped.notification.deleteMany({
      where: { orgId: org.id, createdAt: { gte: startedAt }, body: { contains: 'out of service' } },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { orgId: org.id, entityId: before.id, createdAt: { gte: startedAt } },
    })
    await prismaUnscoped.asset.update({
      where: { id: before.id },
      data: { status: before.status as never, condition: before.condition },
    })
    console.log(`\n(restored ${before.assetTag} to ${before.status}/${before.condition})`)
  }

  console.log(failures === 0 ? '\nAll manual out-of-service checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
