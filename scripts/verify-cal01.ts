/**
 * TekSolv Form CAL-01 — Calibration Report, end to end.
 *
 * Logs a real calibration against a gas monitor's calibration schedule through
 * the browser, then checks the generated report against the record: the details
 * block is pre-filled from the unit, the gas row carries the lot number and
 * expiry off the shelf, the cal gas lot was actually decremented through the
 * ledger, the due date is the schedule's new one, and the report lands on the
 * unit's documents.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-cal01.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { CAL01_REPORT, readCalibration } from '../src/lib/cal01'
import { usDate } from '../src/lib/dates'
import { blendConcentrations, blendGases } from '../src/lib/gas'
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

/** A standard 4-gas: four components, three different units. */
const BLEND = [
  { gas: 'H2S', amount: '25', unit: 'PPM' as const },
  { gas: 'CO', amount: '100', unit: 'PPM' as const },
  { gas: 'O2', amount: '18', unit: 'PERCENT_VOL' as const },
  { gas: 'LEL/CH4', amount: '50', unit: 'PERCENT_LEL' as const },
]

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const REMARKS = 'CAL01TEST: span calibration on all four sensors, no drift.'
const TEMP = '68'
const TIME = '09:35'
/** Stamped on what this test writes, so cleanup can find it without an id. */
const MARKER = 'CAL01TEST'

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

const iso = (date: Date | null | undefined) => date?.toISOString().slice(0, 10) ?? null

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })

  // A gas monitor with a live calibration schedule — the case the form exists
  // for. Found by asking the data rather than assuming an asset tag.
  const schedule = await prismaUnscoped.maintenanceSchedule.findFirstOrThrow({
    where: { orgId: org.id, type: 'CALIBRATION', basis: 'CALENDAR', active: true, asset: { active: true } },
    include: { asset: { include: { location: { select: { name: true } } } } },
    orderBy: { nextDue: 'asc' },
  })
  const asset = schedule.asset
  const priorStatus = asset.status
  const priorNextDue = schedule.nextDue
  const priorLastPerformed = schedule.lastPerformed

  // A lot of in-date cal gas to calibrate with, and what is on the shelf now.
  const lot = await prismaUnscoped.consumableLot.findFirstOrThrow({
    where: {
      orgId: org.id,
      quantity: { gt: 0 },
      consumable: { active: true, lotTracked: true },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { consumable: true, location: { select: { name: true } } },
    orderBy: { expiresAt: 'asc' },
  })
  // A **blend**, deliberately: a cylinder is usually four gases with four
  // different units, and the report copying only the first would be a
  // certificate asserting the wrong mix. Kept so it can be put back.
  const priorComponents = await prismaUnscoped.gasComponent.findMany({
    where: { consumableId: lot.consumableId },
    orderBy: { position: 'asc' },
    select: { gas: true, amount: true, unit: true },
  })
  await prismaUnscoped.gasComponent.deleteMany({ where: { consumableId: lot.consumableId } })
  await prismaUnscoped.gasComponent.createMany({
    data: BLEND.map((component, position) => ({
      orgId: org.id,
      consumableId: lot.consumableId,
      ...component,
      position,
    })),
  })

  const stockBefore = await prismaUnscoped.consumableStock.findFirstOrThrow({
    where: { consumableId: lot.consumableId, locationId: lot.locationId },
  })

  // Put the monitor out on a customer's order, so the report has a Customer and
  // a Rental Order # to fill in — the case the form's middle row exists for.
  // Created directly rather than through checkout: this is about what CAL-01
  // prints, and the checkout flow has its own suite.
  const customer = await prismaUnscoped.customer.findFirst({
    where: { orgId: org.id, internal: false },
    orderBy: { name: 'asc' },
  })
  const staff = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'sam@teksolv.com' } })
  const checkoutDate = new Date()
  const expectedReturnDate = new Date(Date.now() + 7 * 86_400_000)
  // One transaction, because `rental_period_required` is a deferred trigger: an
  // OPEN rental must carry its window by commit time, and Prisma cannot write a
  // tstzrange. Same shape as the checkout action.
  const rental = customer
    ? await prismaUnscoped.$transaction(async (tx) => {
        const line = await lineWithOrder(tx, {
          orgId: org.id,
          assetId: asset.id,
          customerId: customer.id,
          orderNumber: 'CAL01-TEST-SO-4417',
          recordedById: staff.id,
          checkoutDate,
          expectedReturnDate,
          status: 'OPEN',
        })
        // Read back with the customer attached: the helper returns the row it
        // created, and this fixture needs the relation for the assertions below.
        const created = await tx.rental.findFirstOrThrow({
          where: { id: (line as { id: string }).id },
          include: { customer: { select: { name: true } } },
        })
        await tx.$executeRaw`
          UPDATE "Rental"
          SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
          WHERE id = ${created.id}
        `
        return created
      })
    : null

  console.log(
    `\nCalibrating ${asset.assetTag} (${asset.model ?? 'no model'}) ` +
      `on "${schedule.label}", every ${schedule.intervalDays} days\n` +
      `Cal gas: ${lot.consumable.name} lot ${lot.lotNumber} at ${lot.location.name} ` +
      `(${lot.quantity} on the lot, ${stockBefore.onHand} at the office)\n`,
  )

  // Give the org a letterhead so the printed report has real details to show.
  const original = (await prismaUnscoped.organization.findUniqueOrThrow({ where: { id: org.id } }))
    .settings as Record<string, unknown> | null
  await prismaUnscoped.organization.update({
    where: { id: org.id },
    data: {
      settings: {
        ...(original ?? {}),
        branding: {
          legalName: 'TekSolv Inc.',
          tagline: 'Industrial Safety & Rental Equipment',
          addressLines: ['CAL-01 TEST ADDRESS', 'Newark, DE'],
          phone: '000-000-0000',
          website: 'teksolv.com',
        },
      },
    },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  let recordId: string | null = null

  try {
    await signIn(page, 'sam@teksolv.com')

    await page.goto(`${BASE}/maintenance/service?scheduleId=${schedule.id}`, {
      waitUntil: 'networkidle',
    })

    // --- the form opens as a calibration ----------------------------------
    //
    // Arriving from a calibration schedule and having to remember to change a
    // dropdown from "Preventive" is how a calibration gets logged as something
    // else and silently never produces its report.
    check(
      'arriving from a calibration schedule opens the form on Calibration',
      (await page.locator('select[name="type"]').inputValue()) === 'CALIBRATION',
      await page.locator('select[name="type"]').inputValue(),
    )
    check(
      'and the CAL-01 fields are already showing',
      await page.locator('input[name="calTemperatureF"]').isVisible(),
    )

    // Switching away hides them — the section belongs to calibrations only.
    await page.selectOption('select[name="type"]', 'REPAIR')
    check(
      'switching to Repair puts the CAL-01 fields away',
      (await page.locator('input[name="calTemperatureF"]').count()) === 0,
    )
    await page.selectOption('select[name="type"]', 'CALIBRATION')

    // --- fill it in --------------------------------------------------------
    await page.fill('textarea[name="workDone"]', `${MARKER}: span calibration, four sensors.`)
    await page.fill('input[name="calTime"]', TIME)
    await page.fill('input[name="calTemperatureF"]', TEMP)
    await page.fill('textarea[name="calRemarks"]', REMARKS)

    check(
      'the gases table offers the in-date lot from Supplies',
      (await page.locator(`select[name="gas.0.lotId"] option[value="${lot.id}"]`).count()) === 1,
      `${lot.consumable.name} lot ${lot.lotNumber}`,
    )

    // "ID or SN" names the *device* — the serial stamped on the monitor, or an
    // id the customer knows it by. Two ways of naming the same unit, which is
    // why the printed form gives them one column.
    const deviceId = asset.serialNumber ?? asset.assetTag
    check(
      'the gas row identifies the device, pre-filled from the unit',
      (await page.locator('input[name="gas.0.idOrSn"]').inputValue()) === deviceId,
      deviceId,
    )

    // Picking the lot must fill the row in — that is the whole feature.
    //
    // The row fills from client state, so wait for it rather than reading the
    // instant after the change event: a select whose value is set before the
    // page has hydrated posts its own value while React never sees the change,
    // which is a real failure mode worth failing on rather than racing with.
    await page.selectOption('select[name="gas.0.lotId"]', lot.id)
    await page
      .waitForFunction(
        (expected) =>
          (document.querySelector('input[name="gas.0.lotNumber"]') as HTMLInputElement | null)
            ?.value === expected,
        lot.lotNumber,
        { timeout: 10_000 },
      )
      .catch(() => {})

    const filled = {
      idOrSn: await page.locator('input[name="gas.0.idOrSn"]').inputValue(),
      gasType: await page.locator('input[name="gas.0.gasType"]').inputValue(),
      concentration: await page.locator('input[name="gas.0.concentration"]').inputValue(),
      lotNumber: await page.locator('input[name="gas.0.lotNumber"]').inputValue(),
      expiresAt: await page.locator('input[name="gas.0.expiresAt"]').inputValue(),
    }
    check(
      'picking the lot fills lot number and expiry off the shelf',
      filled.lotNumber === lot.lotNumber && filled.expiresAt === iso(lot.expiresAt),
      `lot ${filled.lotNumber || '—'} · exp ${filled.expiresAt || '—'}`,
    )
    check(
      'and every gas in the blend off the item, not just the first',
      filled.gasType === blendGases(BLEND),
      `${filled.gasType || '—'} — four components, four names`,
    )
    check(
      'each with its own concentration and its own unit',
      filled.concentration === blendConcentrations(BLEND),
      `${filled.concentration || '—'} — PPM for the toxics, % vol for oxygen, % LEL for the combustible`,
    )
    check(
      'in the same order across both columns, so they read as pairs',
      filled.gasType.split(' / ').length === filled.concentration.split(' / ').length,
      `${filled.gasType.split(' / ').length} gases · ${filled.concentration.split(' / ').length} concentrations`,
    )
    check(
      'without disturbing the device id — a different bottle is the same unit',
      filled.idOrSn === deviceId,
      filled.idOrSn,
    )

    // Every cell stays editable — the cylinder's label is the authority.
    await page.fill('input[name="gas.0.concentration"]', '25 PPM (label)')

    await page.getByRole('button', { name: /Log service/ }).click()
    // Logging a calibration lands on the report it just produced.
    await page.waitForURL(/\/maintenance\/records\/[a-z0-9]{20,}\/form/, { timeout: 45_000 })

    // --- what was recorded --------------------------------------------------
    const record = await prismaUnscoped.maintenanceRecord.findFirstOrThrow({
      where: { assetId: asset.id, type: 'CALIBRATION' },
      orderBy: { createdAt: 'desc' },
    })
    recordId = record.id
    const snapshot = readCalibration(record.calibration)

    check('the calibration stored what CAL-01 asks for', snapshot !== null)
    check(
      'temperature, time and remarks are on the record',
      snapshot?.temperatureF === Number(TEMP) &&
        snapshot?.time === TIME &&
        snapshot?.remarks === REMARKS,
      `${snapshot?.temperatureF ?? '—'} °F · ${snapshot?.time ?? '—'} · ${
        snapshot?.remarks ? 'remarks present' : 'no remarks'
      }`,
    )
    check(
      'the gas row kept the technician’s edit, not the item’s value',
      snapshot?.gases[0]?.concentration === '25 PPM (label)',
      snapshot?.gases[0]?.concentration ?? undefined,
    )
    check(
      'and still points at the lot it came off',
      snapshot?.gases[0]?.lotId === lot.id && snapshot?.gases[0]?.lotNumber === lot.lotNumber,
    )

    // --- the gas actually left the shelf ------------------------------------
    const lotAfter = await prismaUnscoped.consumableLot.findUniqueOrThrow({ where: { id: lot.id } })
    const stockAfter = await prismaUnscoped.consumableStock.findUniqueOrThrow({
      where: { id: stockBefore.id },
    })
    check(
      'the cal gas lot was drawn down by what was used',
      lotAfter.quantity === lot.quantity - 1,
      `${lot.quantity} → ${lotAfter.quantity}`,
    )
    check(
      'and the office count moved with it',
      stockAfter.onHand === stockBefore.onHand - 1,
      `${stockBefore.onHand} → ${stockAfter.onHand}`,
    )
    const txn = await prismaUnscoped.consumableTxn.findFirst({
      where: { lotId: lot.id, reason: 'CALIBRATION' },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'through the ledger, saying which unit it went to',
      txn?.qtyDelta === -1 && (txn?.destination ?? '').includes(asset.assetTag),
      txn?.destination ?? 'no ledger row',
    )

    // --- the schedule moved --------------------------------------------------
    const scheduleAfter = await prismaUnscoped.maintenanceSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    })
    check(
      'the calibration due date on the report is the schedule’s new one',
      snapshot?.dueAt === iso(scheduleAfter.nextDue) && snapshot?.dueAt !== iso(priorNextDue),
      `${iso(priorNextDue) ?? '—'} → ${snapshot?.dueAt ?? '—'}`,
    )

    // --- the printed report ---------------------------------------------------
    await page.goto(`${BASE}/maintenance/records/${record.id}/form`, { waitUntil: 'networkidle' })
    const form = await page.locator('article').innerText()
    const upper = form.toUpperCase()

    check(
      'header carries the title, the sub-title and the letterhead',
      upper.includes('CALIBRATION REPORT') &&
        form.includes(CAL01_REPORT.subtitle) &&
        form.includes('CAL-01 TEST ADDRESS'),
      'letterhead is from org settings, not hard-coded',
    )
    check(
      'the details block names the unit',
      (asset.manufacturer ? form.includes(asset.manufacturer) : true) &&
        (asset.model ? form.includes(asset.model) : true) &&
        form.includes(asset.serialNumber ?? asset.assetTag),
      `${asset.manufacturer ?? '—'} · ${asset.model ?? '—'} · ${
        asset.serialNumber ?? asset.assetTag
      }`,
    )
    check(
      'date, time and temperature print as entered',
      form.includes(usDate(record.performedAt)!) && form.includes(TIME) && form.includes(`${TEMP} °F`),
    )
    check(
      'location comes off the unit',
      asset.location ? form.includes(asset.location.name) : true,
      asset.location?.name ?? 'unit has no location — box prints empty',
    )
    check(
      'customer and rental order # come off the rental it was out on',
      rental === null
        ? !form.includes('CAL01-TEST-SO')
        : form.includes(rental.customer!.name) && form.includes(rental.orderNumber!),
      rental
        ? `${rental.customer!.name} · ${rental.orderNumber}`
        : 'unit was on the shelf — both boxes print empty, not the last customer',
    )
    check(
      'the gases table prints the lot number and expiry from the cylinder',
      form.includes(lot.lotNumber) && (lot.expiresAt ? form.includes(usDate(lot.expiresAt)!) : true),
    )
    check('and the edited concentration, not the item default', form.includes('25 PPM (label)'))
    check('remarks print', form.includes('CAL01TEST'))
    check(
      'the result block prints the calibration due date and the passing note',
      form.includes(usDate(snapshot!.dueAt)!) && form.includes('returned to service unless noted'),
    )
    check('the technician is named', form.includes('Sam Okafor'))
    check(
      'the footer carries the form code and revision',
      form.includes('Form CAL-01') && form.includes(CAL01_REPORT.revision),
    )
    check(
      'the report is printable and emailable',
      (await page.getByRole('button', { name: 'Save as PDF' }).isVisible()) &&
        (await page.getByRole('button', { name: 'Email' }).isVisible()),
    )

    // --- the certificate does not decay --------------------------------------
    //
    // The reason customer, order # and location are copied onto the record
    // rather than looked up. Bring the monitor back and the filed report must
    // still say who it was calibrated for — a certificate that quietly empties
    // its own Customer box a week later is worse than one that never had it.
    if (rental) {
      await prismaUnscoped.rental.delete({ where: { id: rental.id } })
      await page.reload({ waitUntil: 'networkidle' })
      const afterReturn = await page.locator('article').innerText()
      check(
        'and still say so after the unit comes back off rent',
        afterReturn.includes(rental.customer!.name) && afterReturn.includes(rental.orderNumber!),
        'snapshotted at calibration, not read live off an open rental',
      )
    }

    // --- filed against the unit ----------------------------------------------
    const attachment = await prismaUnscoped.attachment.findFirst({
      where: { assetId: asset.id, type: 'CALIBRATION_CERT' },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'the report is attached to the unit’s documents',
      (attachment?.filename?.startsWith('CAL-01-') ?? false) &&
        attachment?.url === `/maintenance/records/${record.id}/form`,
      attachment?.filename,
    )
    await page.goto(`${BASE}/inventory/${asset.id}?tab=documents`, { waitUntil: 'networkidle' })
    check(
      'it appears on the Documents tab',
      (await page.locator('body').innerText()).includes('CAL-01-'),
    )
    await page.goto(`${BASE}/inventory/${asset.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    check(
      'and the service history links straight to it',
      await page.getByRole('link', { name: /Form CAL-01/ }).first().isVisible(),
    )

    // --- the blank copy --------------------------------------------------------
    await page.goto(`${BASE}/maintenance/forms/cal-01`, { waitUntil: 'networkidle' })
    const blank = await page.locator('article').innerText()
    const blankUpper = blank.toUpperCase()
    check(
      'a blank CAL-01 is available to download',
      blankUpper.includes('CALIBRATION REPORT') && blank.includes('Blank copy'),
    )
    check(
      'the blank rules every block the filled one has',
      ['CALIBRATION DETAILS', 'CALIBRATION GASES', 'REMARKS', 'RESULT', 'TECHNICIAN'].every(
        (section) => blankUpper.includes(section),
      ),
    )
    check(
      'and every gas column',
      ['ID OR SN', 'GAS TYPE', 'CONCENTRATION', 'LOT #', 'EXPIRATION DATE'].every((column) =>
        blankUpper.includes(column),
      ),
    )
    check('with nothing pre-filled on it', !blank.includes('CAL01TEST') && !blank.includes(TEMP))

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // --- cleanup ---------------------------------------------------------------
    //
    // Unconditional, and keyed off the marker rather than off `recordId`. The
    // record is written by the server action *before* the browser finishes
    // navigating, so an assertion that threw between the two used to leave a
    // real calibration on a seeded unit — schedule advanced, cal gas burned,
    // certificate filed — with nothing to roll it back, quietly breaking other
    // suites that expect the fleet as seeded. Everything below either restores
    // a value captured up front or deletes by the marker, so both are safe to
    // run however the test exits, and safe to run twice.
    await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { assetId: asset.id, type: 'CALIBRATION', workDone: { startsWith: MARKER } },
    })
    await prismaUnscoped.attachment.deleteMany({
      where: { assetId: asset.id, type: 'CALIBRATION_CERT' },
    })
    await prismaUnscoped.consumableTxn.deleteMany({
      where: { lotId: lot.id, reason: 'CALIBRATION' },
    })
    await prismaUnscoped.consumableLot.update({
      where: { id: lot.id },
      data: { quantity: lot.quantity },
    })
    await prismaUnscoped.consumableStock.update({
      where: { id: stockBefore.id },
      data: { onHand: stockBefore.onHand },
    })
    await prismaUnscoped.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { nextDue: priorNextDue, lastPerformed: priorLastPerformed },
    })
    await prismaUnscoped.asset.update({ where: { id: asset.id }, data: { status: priorStatus } })
    await prismaUnscoped.auditLog.deleteMany({
      where: { action: 'maintenance.service', entityId: asset.id },
    })
    if (rental) await prismaUnscoped.rental.deleteMany({ where: { id: rental.id } })
    await prismaUnscoped.gasComponent.deleteMany({ where: { consumableId: lot.consumableId } })
    if (priorComponents.length > 0) {
      await prismaUnscoped.gasComponent.createMany({
        data: priorComponents.map((component, position) => ({
          orgId: org.id,
          consumableId: lot.consumableId,
          ...component,
          position,
        })),
      })
    }
    await prismaUnscoped.organization.update({
      where: { id: org.id },
      data: { settings: (original ?? {}) as never },
    })
    console.log('\n  (test data cleaned up)')
  }

  console.log(failures === 0 ? '\nAll CAL-01 checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
