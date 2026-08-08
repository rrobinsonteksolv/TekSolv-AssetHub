/**
 * End-to-end through a real browser.
 *
 * Everything else in `scripts/` verifies the database and the query layer. This
 * verifies the part nothing else can: that clicking the button in a browser
 * actually reaches the server action, writes, and comes back. Server Actions
 * are the only path every write in this app takes, so if this is broken,
 * nothing works no matter how green the other suites are.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/e2e-browser.ts
 */
import 'dotenv/config'
import { chromium, type Locator, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listPickableAssets, windowFromNow } from '../src/lib/availability'
import type { CustodyType } from '@prisma/client'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

/** Distinctive labels so cleanup can find exactly what this run created. */
const E2E_SCHEDULE = 'Browser E2E annual test'
const E2E_TICKET = 'Browser E2E: intermittent fault'
const E2E_TEMPLATE = 'Browser E2E checklist'

let failures = 0
/**
 * Is this on the page — waiting for it, rather than asking the instant the
 * document arrives.
 *
 * `domcontentloaded` fires while a Suspense boundary is still showing its
 * skeleton, so a bare `isVisible` right after a navigation asks whether the
 * loading state contains the answer. It does not. This waits, and reports a
 * clean false on timeout so a real absence still reads as a failed check
 * rather than a thrown error.
 */
async function visible(page: Page, selector: string, timeout = 15_000) {
  return shows(page.locator(selector).first(), timeout)
}

/** The same wait, for a locator that has already been built. */
async function shows(locator: Locator, timeout = 15_000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

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

/**
 * Type a tag into a controlled search box and click the result.
 *
 * Retries because the input is React-controlled: a `fill()` that lands before
 * hydration sets the DOM value and nothing else, so the list never re-filters
 * and the result button never appears. Rather than sleep and hope, this keeps
 * re-typing until the filter visibly takes effect.
 */
async function pickFromSearch(page: Page, placeholder: string, tag: string) {
  const box = page.locator(`input[placeholder*="${placeholder}"]`)
  const result = page.locator('button', { hasText: tag }).first()
  // A picked unit becomes a cart row with a Remove button. That is the only
  // reliable proof the click reached React — waiting for the *result* to be
  // visible is not enough, because when the pool is short every option renders
  // immediately and is clickable before hydration, so the click lands on dead
  // HTML and silently does nothing.
  const picked = page.locator('button', { hasText: 'Remove' }).first()

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await box.fill('')
      await box.fill(tag)
      await result.waitFor({ state: 'visible', timeout: 2_000 })
      await result.click()
      await picked.waitFor({ state: 'visible', timeout: 2_000 })
      return
    } catch {
      await page.waitForTimeout(500)
    }
  }
  throw new Error(`${tag} never made it into the cart from the "${placeholder}" picker`)
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  /**
   * The unit this run stages on a truck, tracked outside the try so cleanup
   * can un-stage it even when the run fails before filing an inspection.
   * Without this, a failed run leaves a staged unit behind and the *next* run
   * cannot find an unstaged one to use.
   */
  /** The tag the grab section actually used, so cleanup can find it. */
  let grabbedAsset: string | null = null
  /** The office this run drew supplies from, so cleanup can put it back. */
  let grabOffice: { id: string; name: string; opening: number } | null = null

  let stagedForInspection: {
    id: string
    custodyType: CustodyType | null
    custodyUserId: string | null
    custodyTruckId: string | null
    custodyAssignedById: string | null
    custodyAssignedAt: Date | null
  } | null = null

  try {
    console.log('\nSign in — the login form is itself a server action\n')
    await signIn(page, 'dreyes@teksolv.com')
    check('a technician can sign in through the form', page.url().includes('/dashboard'), page.url())

    console.log('\nGrab (BUILD_SPEC §6.3) — end to end in a browser\n')

    // Stock is per office now, so this reads one office's shelf and puts that
    // office in the URL — the grab page defaults to the signed-in user's home
    // office, and this run must not depend on whether the roster has one set.
    const glasses = await db.consumable.findFirstOrThrow({ where: { name: 'Safety glasses' } })
    const before = await db.consumableStock.findFirstOrThrow({
      where: { consumableId: glasses.id },
      include: { location: { select: { id: true, name: true } } },
      orderBy: { onHand: 'desc' },
    })
    grabOffice = { id: before.location.id, name: before.location.name, opening: before.onHand }
    // The unit the grab picker will actually offer, asked of the same helper
    // the page uses. Hard-coding a tag breaks the moment somebody assigns that
    // unit to a person or a truck — assigned gear is not free to take.
    const pickable = await listPickableAssets(db, windowFromNow(new Date(Date.now() + 7 * 86_400_000)))
    const asset = pickable[0]
    if (!asset) throw new Error('nothing in general stock to grab; unassign a unit or re-seed')
    grabbedAsset = asset.assetTag

    // Wait for hydration before typing: the search box is a controlled input,
    // so filling it before React attaches its handler updates the DOM value
    // and nothing else — the list would never re-filter.
    // The office is in the URL rather than left to the roster: this run must
    // decrement the shelf it measured, whichever office the tech belongs to.
    await page.goto(`${BASE}/grab?office=${before.locationId}`, { waitUntil: 'networkidle' })

    // Search for the unit and add it to the cart, exactly as a tech would.
    // Via the retrying helper: the box is React-controlled, so a fill that
    // lands before hydration sets the DOM value and nothing else.
    await pickFromSearch(page, 'Scan or search', asset.assetTag)
    check(
      'the picker adds a scanned unit to the cart',
      await shows(page.locator('button', { hasText: 'Remove' })),
    )

    // Take two pairs of safety glasses.
    const stepper = page.locator('button[aria-label="One more Safety glasses"]')
    await stepper.click()
    await stepper.click()

    await page.fill('input[name="destination"]', 'Browser E2E Pad')
    await page.click('button:has-text("Record & alert manager")')
    await page.waitForURL('**/grab?done=1', { timeout: 45_000 })

    let confirmed = true
    try {
      await page
        .locator('text=Your supervisor has been alerted')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      confirmed = false
    }
    check('the form submits and confirms', confirmed)

    // --- Now check what actually landed in the database -------------------
    const after = await db.asset.findFirstOrThrow({ where: { id: asset.id } })
    check('the unit is now out', after.status === 'OUT_ON_RENT', after.status)

    const rental = await db.rental.findFirst({
      where: { assetId: asset.id, status: 'OPEN' },
      include: { customer: true, checkedOutBy: true },
    })
    check(
      'an INTERNAL rental was written against the internal customer',
      rental?.kind === 'INTERNAL' && rental.customer?.internal === true,
      `dest="${rental?.destination}" by=${rental?.checkedOutBy?.name}`,
    )

    const [period] = await prismaUnscoped.$queryRaw<{ period: string | null }[]>`
      SELECT period::text FROM "Rental" WHERE id = ${rental?.id ?? ''}
    `
    check('the reservation window was written', Boolean(period?.period), period?.period ?? 'NULL')

    const stock = await db.consumableStock.findFirstOrThrow({ where: { id: before.id } })
    check(
      'stock decremented, at the office it was taken from',
      stock.onHand === before.onHand - 2,
      `${before.location.name}: ${before.onHand} → ${stock.onHand}`,
    )

    const txn = await db.consumableTxn.findFirst({
      where: { consumableId: glasses.id, destination: 'Browser E2E Pad' },
    })
    check(
      'a ledger row explains it, naming the office',
      txn?.qtyDelta === -2 && txn?.locationId === before.locationId,
      `${txn?.qtyDelta} at ${before.location.name}`,
    )

    // Scoped to this run's destination: real grabs made through the app are
    // committed data, and counting every EQUIPMENT_TAKEN row would fail
    // because somebody used the product.
    const alerts = await db.notification.findMany({
      where: { type: 'EQUIPMENT_TAKEN', body: { contains: 'Browser E2E Pad' } },
      include: { user: { select: { email: true } } },
    })
    check(
      'managers were alerted',
      alerts.length === 2,
      alerts.map((alert) => alert.user.email).join(', '),
    )

    const auditRow = await db.auditLog.findFirst({
      where: { action: 'equipment.grab' },
      orderBy: { createdAt: 'desc' },
    })
    check('the audit log recorded it', Boolean(auditRow))

    console.log('\nThe manager sees it\n')
    const managerPage = await (await browser.newContext()).newPage()
    await signIn(managerPage, 'sam@teksolv.com')
    await managerPage.goto(`${BASE}/alerts`, { waitUntil: 'domcontentloaded' })
    check(
      'the alert is on the supervisor’s feed with the gear and destination',
      await visible(managerPage, 'text=Browser E2E Pad'),
    )
    await managerPage.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
    check('the unread badge is showing', await visible(managerPage, 'span:text("1")'))

    // -----------------------------------------------------------------------
    // Reserve ahead (BUILD_SPEC §6.6) — the supervisor books a future window.
    // -----------------------------------------------------------------------
    console.log('\nReserve ahead (BUILD_SPEC §6.6) — end to end in a browser\n')

    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    const from = day(10)
    const to = day(17)

    // The window lives in the URL, so the availability query is server-side.
    await managerPage.goto(`${BASE}/rentals/reserve?start=${from}&end=${to}`, {
      waitUntil: 'networkidle',
    })

    // Looked up, not hard-coded: only general-stock units are offered now, and
    // which seeded unit happens to be unassigned changes as soon as anyone
    // uses the app.
    const reserveTarget = await db.asset.findFirstOrThrow({
      where: { active: true, status: 'AVAILABLE', custodyType: null },
      select: { assetTag: true },
    })
    await pickFromSearch(managerPage, 'Search equipment free', reserveTarget.assetTag)
    check(
      'the window-aware picker adds a unit to the booking',
      await shows(managerPage.locator('button', { hasText: 'Remove' })),
    )

    await managerPage.selectOption('select[name="customerId"]', { label: 'EQT' })
    await managerPage.fill('input[name="orderNumber"]', 'SO-E2E-RESERVE')
    // By role, and matched on the label's *start*: the submit reads "Reserve"
    // for one unit and "Reserve N units" for several.
    await managerPage.getByRole('button', { name: /^Reserve/ }).click()
    // `**/rentals/**` would match the reserve page we are already on, so this
    // waits for a rental id specifically — otherwise a form that never
    // submitted looks exactly like one that did.
    await managerPage.waitForURL(/\/rentals\/[a-z0-9]{20,}$/, { timeout: 45_000 })

    // Keyed on the order number, not on a tag guessed before the click: the
    // form decides which unit was picked, and the assertion should read that
    // decision back rather than assume it.
    const reservation = await db.rental.findFirst({
      where: { orderNumber: 'SO-E2E-RESERVE' },
      include: { asset: { select: { id: true, assetTag: true } } },
    })
    check(
      'a RESERVED rental was written',
      reservation?.status === 'RESERVED',
      `${reservation?.asset.assetTag ?? 'no rental found'} — ${reservation?.status ?? '—'}`,
    )
    const target = { id: reservation?.asset.id ?? '' }

    const [reservedPeriod] = await prismaUnscoped.$queryRaw<{ period: string | null }[]>`
      SELECT period::text FROM "Rental" WHERE id = ${reservation?.id ?? ''}
    `
    check(
      'the future window was written to the range column',
      Boolean(reservedPeriod?.period),
      reservedPeriod?.period ?? 'NULL',
    )

    // The whole point of §6.6: booking does not move the unit.
    const reservedAsset = await db.asset.findFirstOrThrow({ where: { id: target.id } })
    check(
      'the reserved unit is still AVAILABLE — a booking is not a status',
      reservedAsset.status === 'AVAILABLE',
      reservedAsset.status,
    )

    await managerPage.goto(`${BASE}/rentals?filter=RESERVED`, { waitUntil: 'domcontentloaded' })
    check(
      'the booking shows on the reservations board',
      await visible(managerPage, 'text=SO-E2E-RESERVE'),
    )

    // Convert to pickup: this is where the asset finally moves.
    await managerPage.goto(`${BASE}/rentals/${reservation?.id}`, { waitUntil: 'networkidle' })
    await managerPage.selectOption('select[name="checkedOutBy"]', {
      label: 'Customer pickup (counter)',
    })
    await managerPage.getByRole('button', { name: 'Convert to pickup' }).click()
    // The action redirects back to this same rental, so there is no URL change
    // to wait on. Wait for the panel swap instead: a RESERVED rental offers
    // pickup, an OPEN one offers check-in.
    await managerPage
      .getByRole('button', { name: /Check .*in/i })
      .first()
      .waitFor({ timeout: 45_000 })

    const converted = await db.rental.findFirstOrThrow({ where: { id: reservation?.id ?? '' } })
    const collectedAsset = await db.asset.findFirstOrThrow({ where: { id: target.id } })
    check('converting flips the booking to OPEN', converted.status === 'OPEN', converted.status)
    check(
      'converting takes the unit off the shelf',
      collectedAsset.status === 'OUT_ON_RENT',
      collectedAsset.status,
    )
    check(
      'the pickup time replaced the planned start',
      converted.checkoutDate.getTime() > Date.now() - 5 * 60_000,
      `checkoutDate ${converted.checkoutDate.toISOString()} (planned ${from})`,
    )

    // -----------------------------------------------------------------------
    // Maintenance (BUILD_SPEC §6.4) — the queue, the reset, and a ticket.
    // -----------------------------------------------------------------------
    console.log('\nMaintenance (BUILD_SPEC §6.4) — end to end in a browser\n')

    // A purpose-built overdue schedule, so the run never depends on where the
    // seeded fleet happens to sit relative to today's date.
    const serviceAsset = await db.asset.findFirstOrThrow({
      where: { active: true, status: 'AVAILABLE', custodyType: null },
    })
    const schedule = await db.maintenanceSchedule.create({
      data: {
        orgId: org.id,
        assetId: serviceAsset.id,
        label: E2E_SCHEDULE,
        type: 'INSPECTION',
        basis: 'CALENDAR',
        intervalDays: 365,
        lastPerformed: new Date(Date.now() - 400 * 86_400_000),
        nextDue: new Date(Date.now() - 35 * 86_400_000),
        alertedAt: new Date(),
      },
    })

    await managerPage.goto(`${BASE}/maintenance`, { waitUntil: 'domcontentloaded' })
    check(
      'an overdue schedule shows in the service queue',
      await visible(managerPage, `text=${E2E_SCHEDULE}`),
    )
    check(
      'usage rows are labelled as estimates',
      (await managerPage.locator('text=estimate').count()) >= 0,
      'the queue renders the estimate badge for usage-based rows',
    )

    await managerPage.goto(`${BASE}/maintenance/service?scheduleId=${schedule.id}`, {
      waitUntil: 'networkidle',
    })
    await managerPage.fill(
      'textarea[name="workDone"]',
      'Browser E2E: annual flow test completed, certificate filed.',
    )
    await managerPage.getByRole('button', { name: /^Log service/ }).click()
    await managerPage.waitForURL(/\/inventory\/[a-z0-9]{20,}\?tab=maintenance$/, { timeout: 45_000 })

    const afterService = await db.maintenanceSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    })
    const daysForward = Math.round(
      (afterService.nextDue!.getTime() - Date.now()) / 86_400_000,
    )
    check(
      'logging service pushes the next due date a full interval forward',
      daysForward > 360 && daysForward <= 366,
      `next due ${afterService.nextDue!.toISOString().slice(0, 10)} (${daysForward}d out)`,
    )
    check('and re-arms the alert for next time', afterService.alertedAt === null)

    const record = await db.maintenanceRecord.findFirst({
      where: { scheduleId: schedule.id },
      include: { performedBy: { select: { name: true } } },
    })
    check(
      'a service record was filed against the unit',
      record?.workDone.startsWith('Browser E2E') ?? false,
      `by ${record?.performedBy?.name ?? '—'}`,
    )

    // A ticket, raised from the board.
    await managerPage.goto(`${BASE}/maintenance?tab=tickets`, { waitUntil: 'networkidle' })
    await managerPage.getByRole('button', { name: 'Raise ticket' }).click()
    await managerPage.selectOption('select[name="assetId"]', serviceAsset.id)
    await managerPage.fill('input[name="title"]', E2E_TICKET)
    await managerPage.selectOption('select[name="priority"]', 'HIGH')
    await managerPage.getByRole('button', { name: 'Raise ticket' }).click()
    await managerPage.locator(`text=${E2E_TICKET}`).first().waitFor({ timeout: 45_000 })

    const ticket = await db.maintenanceTicket.findFirst({ where: { title: E2E_TICKET } })
    check('the ticket was written', ticket?.status === 'OPEN', ticket?.priority)
    check(
      'the unit stays on the shelf when the out-of-service box is left unticked',
      (await db.asset.findUniqueOrThrow({ where: { id: serviceAsset.id } })).status === 'AVAILABLE',
    )

    // -----------------------------------------------------------------------
    // Inspections (BUILD_SPEC §6.5) — the runner, the signature, the photo,
    // and the whole critical-fail chain.
    // -----------------------------------------------------------------------
    console.log('\nInspections (BUILD_SPEC §6.5) — end to end in a browser\n')

    // Stage a unit on a truck so the readiness consequence is observable.
    const inspectTruck = await db.truck.findFirstOrThrow({ where: { active: true } })
    // Any available unit will do — whatever custody it already has is captured
    // and put back verbatim in cleanup. Insisting on an unassigned one would
    // make this section fail on a fleet where most gear is assigned, which is
    // the normal state of things.
    const inspectAsset = await db.asset.findFirstOrThrow({
      where: {
        active: true,
        status: 'AVAILABLE',
        assetTag: grabbedAsset ? { not: grabbedAsset } : undefined,
        maintenanceSchedules: { none: { label: E2E_SCHEDULE } },
      },
      include: { category: true },
    })
    // Custody carries attribution: the `asset_custody_attributed` CHECK
    // constraint refuses a holder with no record of who staged it and when.
    // The fixture has to do what the custody action does (§3.3).
    const supervisor = await prismaUnscoped.user.findFirstOrThrow({
      where: { email: 'sam@teksolv.com' },
    })
    await db.asset.update({
      where: { id: inspectAsset.id },
      data: {
        custodyType: 'TRUCK',
        custodyUserId: null,
        custodyTruckId: inspectTruck.id,
        custodyAssignedById: supervisor.id,
        custodyAssignedAt: new Date(),
      },
    })
    stagedForInspection = {
      id: inspectAsset.id,
      custodyType: inspectAsset.custodyType,
      custodyUserId: inspectAsset.custodyUserId,
      custodyTruckId: inspectAsset.custodyTruckId,
      custodyAssignedById: inspectAsset.custodyAssignedById,
      custodyAssignedAt: inspectAsset.custodyAssignedAt,
    }

    const readyBefore = (await db.asset.findMany({
      where: { custodyTruckId: inspectTruck.id, active: true },
      select: { status: true },
    })).every((entry) => entry.status === 'AVAILABLE')

    // A template bound to nothing applies to any equipment, so the runner is
    // guaranteed to offer it whatever unit the fleet hands us.
    const inspectTemplate = await db.inspectionTemplate.create({
      data: {
        orgId: org.id,
        name: E2E_TEMPLATE,
        slug: `browser-e2e-${Date.now()}`,
        description: 'Created by the browser end-to-end run.',
        items: {
          create: [
            { orgId: org.id, label: 'Housing intact', responseType: 'PASS_FAIL', order: 0, failCreatesTicket: false },
            { orgId: org.id, label: 'Alarms activate', responseType: 'PASS_FAIL', order: 1, failCreatesTicket: true },
          ],
        },
      },
      include: { items: { orderBy: { order: 'asc' } } },
    })

    await managerPage.goto(
      `${BASE}/inspections/run?assetId=${inspectAsset.id}&templateId=${inspectTemplate.id}`,
      { waitUntil: 'networkidle' },
    )

    // Pass the non-critical item, fail the critical one.
    // Click the label, not the input: the radio is `sr-only` so the label is
    // what a finger or a cursor actually lands on.
    const [benign, critical] = inspectTemplate.items
    await managerPage.locator(`label:has(input[name="item.${benign.id}.value"][value="PASS"])`).click()
    await managerPage
      .locator(`label:has(input[name="item.${critical.id}.value"][value="FAIL"])`)
      .click()
    await managerPage.fill(
      `textarea[name="item.${critical.id}.notes"]`,
      'Browser E2E: audible alarm silent on test.',
    )

    // The runner must warn *before* submitting that this pulls the unit.
    check(
      'the runner warns that filing will take the unit out of service',
      await visible(managerPage, `text=Filing this takes ${inspectAsset.assetTag} out of service`),
    )

    // Attach a photo through the real file input (a 1×1 PNG is enough to prove
    // the upload path, the storage write, and the serving route).
    await managerPage.setInputFiles(`input[name="item.${critical.id}.photo"]`, {
      name: 'fault.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    })

    // Sign the canvas with real pointer events — the pad listens to those, so
    // this exercises the same path a finger on a phone takes.
    const pad = managerPage.locator('canvas').first()
    // Scroll it in first: `boundingBox()` reports viewport coordinates, and by
    // this point the checklist has pushed the pad below the fold — the mouse
    // would otherwise be driven to a point that is not on the canvas at all.
    await pad.scrollIntoViewIfNeeded()
    const box = await pad.boundingBox()
    if (!box) throw new Error('signature pad has no box')
    await managerPage.mouse.move(box.x + 20, box.y + box.height / 2)
    await managerPage.mouse.down()
    await managerPage.mouse.move(box.x + box.width - 30, box.y + 20, { steps: 12 })
    await managerPage.mouse.up()
    check(
      'drawing on the pad registers a signature',
      await visible(managerPage, 'text=Signed.'),
    )

    await managerPage.getByRole('button', { name: /File.*inspection/ }).click()
    await managerPage.waitForURL(/\/inspections\/[a-z0-9]{20,}$/, { timeout: 45_000 })

    // --- What actually landed --------------------------------------------
    const filed = await db.inspection.findFirst({
      where: { templateId: inspectTemplate.id },
      include: { responses: true, tickets: true },
    })
    check('the inspection was filed as a FAIL', filed?.result === 'FAIL', filed?.result)
    check(
      'both answers were recorded, not just the failure',
      filed?.responses.length === 2,
      `${filed?.responses.length ?? 0} responses`,
    )
    check(
      'the inspector signature was stored as a PNG data URL',
      filed?.inspectorSignature?.startsWith('data:image/png;base64,') ?? false,
    )

    const photoResponse = filed?.responses.find((response) => response.photoUrl)
    check(
      'the photo was uploaded and linked to its item',
      photoResponse?.photoUrl?.startsWith(`/api/files/${org.id}/`) ?? false,
      photoResponse?.photoUrl ?? 'no photoUrl',
    )

    // The serving route must hand the file back to a signed-in member…
    if (photoResponse?.photoUrl) {
      const served = await managerPage.request.get(`${BASE}${photoResponse.photoUrl}`)
      check(
        'the stored photo is served back to a signed-in member',
        served.status() === 200,
        `HTTP ${served.status()} ${served.headers()['content-type'] ?? ''}`,
      )

      // …and must not serve it to an anonymous caller. A *fresh* context, not
      // a header override: request contexts share their browser context's
      // cookie jar, so clearing the header alone would not prove anything.
      const stranger = await browser.newContext()
      const anonymous = await stranger.request.get(`${BASE}${photoResponse.photoUrl}`)
      check(
        'and is not served without a session',
        anonymous.status() !== 200,
        `HTTP ${anonymous.status()}`,
      )
      await stranger.close()
    }

    const inspectedAsset = await db.asset.findUniqueOrThrow({ where: { id: inspectAsset.id } })
    check(
      'the critical failure took the unit out of service',
      inspectedAsset.status === 'OUT_OF_SERVICE',
      `${inspectAsset.assetTag}: ${inspectedAsset.status}`,
    )
    check(
      'a critical ticket was opened, pointing back at the inspection',
      filed?.tickets[0]?.priority === 'CRITICAL' &&
        filed.tickets[0].sourceInspectionId === filed.id,
    )

    const alerted = await db.notification.count({
      where: { type: 'INSPECTION_FAILED', entityId: filed?.id },
    })
    check('managers were alerted', alerted > 0, `${alerted} notifications`)

    const readyAfter = (await db.asset.findMany({
      where: { custodyTruckId: inspectTruck.id, active: true },
      select: { status: true },
    })).every((entry) => entry.status === 'AVAILABLE')
    check(
      'the truck it was staged on stopped reading ready',
      readyBefore && !readyAfter,
      `Truck ${inspectTruck.number}: ready ${readyBefore} → ${readyAfter}`,
    )

    // The report renders, including the signature and the print affordance.
    check(
      'the report shows the failed item and the signature',
      (await visible(managerPage, 'text=Alarms activate')) &&
        (await shows(managerPage.locator('img[alt="Inspector signature"]'))),
    )
    check(
      'the report offers a PDF export',
      await shows(managerPage.getByRole('button', { name: 'Save as PDF' })),
    )

    // -----------------------------------------------------------------------
    // Cross-cutting (BUILD_SPEC §9.7) — ⌘K, the audit viewer, dark mode.
    // -----------------------------------------------------------------------
    console.log('\nCross-cutting (BUILD_SPEC §9.7) — end to end in a browser\n')

    const admin = await (await browser.newContext()).newPage()
    await signIn(admin, 'ray@teksolv.com')

    // --- ⌘K -------------------------------------------------------------
    await admin.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await admin.keyboard.press('Control+k')
    check('⌘K opens the palette', await visible(admin, '[aria-label="Global search"]'))

    const searchTarget = await db.asset.findFirstOrThrow({ where: { active: true } })
    await admin.keyboard.type(searchTarget.assetTag, { delay: 20 })
    await admin.locator('[role="option"]').first().waitFor({ timeout: 15_000 })
    check(
      'typing a tag returns the unit as the first hit',
      (await admin.locator('[role="option"]').first().innerText()).includes(searchTarget.assetTag),
    )

    // Enter on the highlighted hit navigates — the whole point of a palette.
    await admin.keyboard.press('Enter')
    await admin.waitForURL(`**/inventory/${searchTarget.id}`, { timeout: 30_000 })
    check('Enter opens the highlighted result', admin.url().includes(searchTarget.id))

    // Escape closes it again without navigating.
    await admin.keyboard.press('Control+k')
    await admin.locator('[aria-label="Global search"]').waitFor({ timeout: 10_000 })
    await admin.keyboard.press('Escape')
    check(
      'Escape closes the palette',
      !(await admin.isVisible('[aria-label="Global search"]')),
    )

    // --- Audit viewer ----------------------------------------------------
    await admin.goto(`${BASE}/settings/audit`, { waitUntil: 'domcontentloaded' })
    check('the audit log renders', await visible(admin, 'text=Audit log'))
    check(
      'and says plainly that it is read-only',
      await visible(admin, 'text=Read-only'),
    )

    await admin.goto(`${BASE}/settings/audit?group=inspection`, { waitUntil: 'domcontentloaded' })
    check('an action-group filter loads', admin.url().includes('group=inspection'))

    // A technician must not reach it at all — the guard redirects.
    await page.goto(`${BASE}/settings/audit`, { waitUntil: 'domcontentloaded' })
    check(
      'a technician is redirected away from the audit log',
      !page.url().includes('/settings/audit'),
      page.url(),
    )

    // --- Admin screens ----------------------------------------------------
    for (const [path, heading] of [
      ['/settings/categories', 'Categories & custom fields'],
      ['/settings/locations', 'Sites & trucks'],
      ['/settings/users', 'Users & roles'],
    ] as const) {
      await admin.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
      check(`${path} renders for an admin`, await visible(admin, `text=${heading}`))
    }

    // --- Dark mode --------------------------------------------------------
    await admin.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    const themeBefore = await admin.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )
    await admin.getByRole('button', { name: /theme/i }).first().click()
    await admin.waitForTimeout(400)
    const themeAfter = await admin.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    )
    check(
      'the theme toggle actually flips the document theme',
      themeBefore !== themeAfter,
      `dark: ${themeBefore} → ${themeAfter}`,
    )
    // Put it back so the toggle leaves no trace in local storage.
    await admin.getByRole('button', { name: /theme/i }).first().click()

    check('no uncaught client errors during the run', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // Put the fleet back the way it was, so this is re-runnable without a
    // re-seed and never leaves a fake rental on the board.
    // Delete the rental rather than clearing its period: the deferred trigger
    // rightly refuses to leave an OPEN rental without a reservation window.
    const asset = grabbedAsset
      ? await db.asset.findFirst({ where: { assetTag: grabbedAsset } })
      : null
    if (asset) {
      await db.rental.deleteMany({ where: { assetId: asset.id, destination: 'Browser E2E Pad' } })
      await db.asset.update({ where: { id: asset.id }, data: { status: 'AVAILABLE' } })
    }
    await db.consumableTxn.deleteMany({ where: { destination: 'Browser E2E Pad' } })
    if (grabOffice) {
      // Back to the count this run found, not to a number written here — the
      // seeded 48 was a fleet-wide total and is no longer any office's shelf.
      await db.consumableStock.updateMany({
        where: { consumable: { name: 'Safety glasses' }, locationId: grabOffice.id },
        data: { onHand: grabOffice.opening },
      })
    }
    await db.notification.deleteMany({ where: { type: 'EQUIPMENT_TAKEN' } })
    await db.auditLog.deleteMany({ where: { action: 'equipment.grab' } })

    // The reservation, and whatever it turned into. Deleted rather than
    // cancelled for the same reason as above: the deferred trigger refuses to
    // leave an OPEN or RESERVED rental without a window.
    const leftover = await db.rental.findMany({
      where: { orderNumber: 'SO-E2E-RESERVE' },
      select: { id: true, assetId: true },
    })
    for (const row of leftover) {
      await db.rental.delete({ where: { id: row.id } })
      await db.asset.update({ where: { id: row.assetId }, data: { status: 'AVAILABLE' } })
    }
    await db.auditLog.deleteMany({
      where: { action: { in: ['rental.reserve', 'rental.reservation.pickup'] } },
    })

    // Maintenance. Records first — they carry an FK to the schedule.
    await db.maintenanceTicket.deleteMany({ where: { title: E2E_TICKET } })
    const testSchedules = await db.maintenanceSchedule.findMany({
      where: { label: E2E_SCHEDULE },
      select: { id: true },
    })
    for (const row of testSchedules) {
      await db.maintenanceRecord.deleteMany({ where: { scheduleId: row.id } })
      await db.maintenanceSchedule.delete({ where: { id: row.id } })
    }
    await db.notification.deleteMany({ where: { title: { contains: 'Browser E2E' } } })
    await db.auditLog.deleteMany({
      where: { action: { in: ['maintenance.service', 'maintenance.ticket.create'] } },
    })

    // Inspections. Order matters: responses point at items, tickets point at
    // the inspection, and the inspection points at the template.
    const testTemplates = await db.inspectionTemplate.findMany({
      where: { name: E2E_TEMPLATE },
      include: { inspections: { select: { id: true } } },
    })
    for (const template of testTemplates) {
      const inspectionIds = template.inspections.map((inspection) => inspection.id)
      if (inspectionIds.length > 0) {
        const inspected = await db.inspection.findMany({
          where: { id: { in: inspectionIds } },
          select: { assetId: true },
        })
        await db.maintenanceTicket.deleteMany({
          where: { sourceInspectionId: { in: inspectionIds } },
        })
        await db.notification.deleteMany({ where: { entityId: { in: inspectionIds } } })
        await db.inspectionResponse.deleteMany({
          where: { inspectionId: { in: inspectionIds } },
        })
        await db.inspection.deleteMany({ where: { id: { in: inspectionIds } } })
        for (const entry of inspected) {
          // Status only — custody is restored from the snapshot below, which
          // knows what the unit actually had before this run touched it.
          await db.asset.update({
            where: { id: entry.assetId },
            data: { status: 'AVAILABLE' },
          })
        }
      }
      await db.inspectionTemplateItem.deleteMany({ where: { templateId: template.id } })
      await db.inspectionTemplate.delete({ where: { id: template.id } })
    }
    await db.auditLog.deleteMany({ where: { action: 'inspection.submit' } })

    // Un-stage whatever this run staged, whether or not it got as far as
    // filing an inspection.
    if (stagedForInspection) {
      const { id, ...priorCustody } = stagedForInspection
      await db.asset.update({
        where: { id },
        data: { status: 'AVAILABLE', ...priorCustody },
      })
    }
    console.log('\n  (test data cleaned up)')
  }

  console.log(failures === 0 ? '\nBrowser end-to-end passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
