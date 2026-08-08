/**
 * Returning a unit to service must not leave it reading "Damaged".
 *
 * The bug: returning a unit to service moved its status and left its condition
 * alone, so a monitor that came back damaged, went out of service, was repaired
 * and was put back on the shelf ended up AVAILABLE / DAMAGED — and the
 * condition is what a tech reads before signing for it.
 *
 * There are three ways back out of the shop and they funnel into two actions.
 * Both are exercised here, through the browser, end to end:
 *
 *   1. the ticket board / the out-of-service tab  → `updateTicketAction`
 *   2. log service, and the OOS tab for a unit with no ticket → `logServiceAction`
 *
 * Plus the guarantee underneath both: DAMAGED cannot be posted as the condition
 * a unit comes back in, whatever the form offers.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-return-to-service.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { logServiceSchema, ticketUpdateSchema } from '../src/lib/validators/maintenance'
import { defaultReturnCondition } from '../src/lib/maintenance'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

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
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })

  // --- the pure rule ------------------------------------------------------
  //
  // No browser needed: the schema is the backstop behind all three forms.
  console.log('\nThe rule\n')

  const damagedPost = logServiceSchema.safeParse({
    assetId: 'x',
    workDone: 'Repaired the regulator.',
    performedAt: '2026-08-06',
    returnToService: 'on',
    conditionOnReturn: 'DAMAGED',
  })
  check(
    'a unit cannot be handed back to the yard as Damaged',
    !damagedPost.success,
    damagedPost.success
      ? 'accepted — this is the contradiction the fix exists to close'
      : damagedPost.error.issues[0]?.message,
  )

  const silentPost = logServiceSchema.safeParse({
    assetId: 'x',
    workDone: 'Repaired the regulator.',
    performedAt: '2026-08-06',
    returnToService: 'on',
  })
  check(
    'and a form that forgets to ask still cannot leave the old value behind',
    silentPost.success && silentPost.data.conditionOnReturn === 'GOOD',
    silentPost.success ? silentPost.data.conditionOnReturn : 'rejected',
  )

  const ticketPost = ticketUpdateSchema.safeParse({
    ticketId: 'x',
    status: 'RESOLVED',
    returnToService: 'on',
    conditionOnReturn: 'DAMAGED',
  })
  check('the same rule holds on the ticket path', !ticketPost.success)

  check(
    'a serviceable condition survives the trip rather than being promoted',
    defaultReturnCondition('FAIR') === 'FAIR' && defaultReturnCondition('POOR') === 'POOR',
    'a unit that went in Fair does not come out Good just because it was touched',
  )
  check(
    'and only DAMAGED is forced to change',
    defaultReturnCondition('DAMAGED') === 'GOOD',
  )

  // --- end to end ---------------------------------------------------------
  const db = dbForOrg(org.id)
  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Two units: one goes back via its ticket, one via log service.
  const units = await prismaUnscoped.asset.findMany({
    where: { orgId: org.id, active: true, status: 'AVAILABLE' },
    orderBy: { assetTag: 'asc' },
    take: 2,
  })
  if (units.length < 2) throw new Error('need two available units')
  const [viaTicket, viaService] = units
  const restore = units.map((unit) => ({
    id: unit.id,
    status: unit.status,
    condition: unit.condition,
    notes: unit.notes,
  }))
  let ticketId: string | null = null

  try {
    await signIn(page, 'sam@teksolv.com')

    // --- 1. out of service as Damaged, back via the ticket ----------------
    console.log('\nBack through the ticket board\n')

    const ticket = await prismaUnscoped.maintenanceTicket.create({
      data: {
        orgId: org.id,
        assetId: viaTicket.id,
        title: 'RTSTEST: cracked housing',
        priority: 'CRITICAL',
        status: 'OPEN',
      },
    })
    ticketId = ticket.id
    await prismaUnscoped.asset.update({
      where: { id: viaTicket.id },
      data: { status: 'OUT_OF_SERVICE', condition: 'DAMAGED' },
    })
    console.log(`  ${viaTicket.assetTag}: OUT_OF_SERVICE / DAMAGED\n`)

    await page.goto(`${BASE}/maintenance?tab=tickets`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: new RegExp('RTSTEST: cracked housing') }).click()
    const card = page.locator('form').filter({ has: page.locator(`input[value="${ticket.id}"]`) })
    await card.locator('select[name="status"]').selectOption('RESOLVED')

    check(
      'resolving asks what condition it is coming back in',
      await card.locator('select[name="conditionOnReturn"]').isVisible(),
    )
    check(
      'and does not offer Damaged as an answer',
      (await card.locator('select[name="conditionOnReturn"] option[value="DAMAGED"]').count()) === 0,
      'a unit cannot be Available and Damaged at once',
    )
    check(
      'starting on a working value rather than the one that took it out',
      (await card.locator('select[name="conditionOnReturn"]').inputValue()) === 'GOOD',
    )

    await card.locator('select[name="conditionOnReturn"]').selectOption('FAIR')
    await card.getByRole('button', { name: /Update/ }).click()
    await page.waitForTimeout(3000)

    const afterTicket = await prismaUnscoped.asset.findUniqueOrThrow({ where: { id: viaTicket.id } })
    check(
      'the unit comes back Available',
      afterTicket.status === 'AVAILABLE',
      afterTicket.status,
    )
    check(
      'and no longer reads Damaged',
      afterTicket.condition !== 'DAMAGED',
      `condition is ${afterTicket.condition}`,
    )
    check(
      'carrying the condition the technician actually chose',
      afterTicket.condition === 'FAIR',
      'not a blanket GOOD stamped on everything leaving the shop',
    )

    // --- 2. out of service as Damaged, back via log service ---------------
    console.log('\nBack through log service\n')

    await prismaUnscoped.asset.update({
      where: { id: viaService.id },
      data: { status: 'OUT_OF_SERVICE', condition: 'DAMAGED' },
    })
    console.log(`  ${viaService.assetTag}: OUT_OF_SERVICE / DAMAGED\n`)

    await page.goto(`${BASE}/maintenance/service?assetId=${viaService.id}`, {
      waitUntil: 'networkidle',
    })
    check(
      'log service asks too, when the return box is ticked',
      await page.locator('select[name="conditionOnReturn"]').isVisible(),
      'the box defaults on for a unit already in the shop',
    )

    // Unticking the return puts the question away — a unit staying in the shop
    // keeps whatever condition it is on record with.
    await page.uncheck('input[name="returnToService"]')
    check(
      'and puts it away when the unit is staying in the shop',
      (await page.locator('select[name="conditionOnReturn"]').count()) === 0,
    )
    await page.check('input[name="returnToService"]')

    await page.fill('textarea[name="workDone"]', 'RTSTEST: replaced the housing.')
    await page.selectOption('select[name="conditionOnReturn"]', 'GOOD')
    await page.getByRole('button', { name: /Log service/ }).click()
    await page.waitForURL(/\/inventory\/[a-z0-9]{20,}/, { timeout: 45_000 })

    const afterService = await prismaUnscoped.asset.findUniqueOrThrow({
      where: { id: viaService.id },
    })
    check(
      'the unit comes back Available',
      afterService.status === 'AVAILABLE',
      afterService.status,
    )
    check(
      'and no longer reads Damaged',
      afterService.condition !== 'DAMAGED',
      `condition is ${afterService.condition}`,
    )

    // --- 3. nothing on the shelf contradicts itself -----------------------
    console.log('\nThe fleet\n')
    const contradictory = await db.asset.findMany({
      where: { active: true, condition: 'DAMAGED', status: { in: ['AVAILABLE', 'OUT_ON_RENT'] } },
      select: { assetTag: true, status: true },
    })
    check(
      'no unit is rentable while on record as Damaged',
      contradictory.length === 0,
      contradictory.map((unit) => `${unit.assetTag} (${unit.status})`).join(', ') ||
        'checked every active unit in the fleet',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    if (ticketId) await prismaUnscoped.maintenanceTicket.deleteMany({ where: { id: ticketId } })
    await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { workDone: { startsWith: 'RTSTEST' } },
    })
    for (const unit of restore) {
      await prismaUnscoped.asset.update({
        where: { id: unit.id },
        data: { status: unit.status, condition: unit.condition, notes: unit.notes },
      })
    }
    await prismaUnscoped.auditLog.deleteMany({
      where: {
        action: { in: ['maintenance.ticket.update', 'maintenance.service'] },
        entityId: { in: restore.map((unit) => unit.id) },
      },
    })
    console.log('\n  (test data cleaned up)')
  }

  console.log(
    failures === 0 ? '\nAll return-to-service checks passed.' : `\n${failures} FAILED.`,
  )
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
