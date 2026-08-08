/**
 * Truck labels, staging by scan, and moving a kit between trucks.
 *
 * Walks the scenario end to end: stage units on a truck, scan its label to get
 * to them, tick everything with "Move all", untick one, confirm, and check that
 * the rest re-home in a single transaction — with readiness following on both
 * trucks because it is derived from the same custody column.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-trucks.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getTruckReadiness } from '../src/lib/rentals'
import { identifierFromScan } from '../src/lib/scan'
import { renderLabel, renderLabelHtml } from '../src/lib/labels/templates'
import { unmovableReason } from '../src/lib/trucks'

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
  const db = dbForOrg(org.id)

  // --- the label and the scan parser --------------------------------------
  console.log('\nThe truck label\n')

  const sample = {
    orgName: 'TekSolv',
    number: '160',
    office: 'New Castle Warehouse',
    ownerName: 'Dana Reyes',
    scanUrl: `${BASE}/api/scan/truck/ckabc123`,
    qrSvg: null,
  }
  for (const language of ['EPL', 'ZPL'] as const) {
    const rendered = renderLabel('truck', sample, { language })
    check(
      `the truck label renders in ${language}`,
      rendered.includes('TRUCK 160') && rendered.includes(sample.scanUrl),
      'the number big enough to match against the door, and a code that opens the kit',
    )
  }
  check(
    'and on the OS-driver path',
    renderLabelHtml('truck', sample).includes('TRUCK 160'),
  )
  check(
    'a scanned truck label yields the truck id',
    identifierFromScan(`${BASE}/api/scan/truck/ckabc123`) === 'ckabc123',
  )
  check(
    'a scanned unit label yields the asset tag',
    identifierFromScan(`${BASE}/api/scan/FAM001006`) === 'FAM001006',
    'the same box takes either — an operator should not have to know which gun they are holding',
  )
  check(
    'and a bare tag from a 1D scanner passes straight through',
    identifierFromScan('  FAM001006 ') === 'FAM001006',
  )

  // --- fixture -------------------------------------------------------------
  const [source, destination] = await prismaUnscoped.truck.findMany({
    where: { orgId: org.id, active: true },
    orderBy: { number: 'asc' },
    take: 2,
  })
  if (!source || !destination) throw new Error('need two trucks')

  // Three available units to stage, plus one that is out of service — the case
  // that must be shown as unmovable rather than quietly dragged along.
  // Whatever they are held by now is captured and put back afterwards, so the
  // only requirement is that they are Available and not already on one of the
  // two trucks under test.
  const available = await prismaUnscoped.asset.findMany({
    where: {
      orgId: org.id,
      active: true,
      status: 'AVAILABLE',
      custodyTruckId: { notIn: [source.id, destination.id] },
    },
    orderBy: { assetTag: 'asc' },
    take: 3,
  })
  const outOfService = await prismaUnscoped.asset.findFirst({
    where: { orgId: org.id, active: true, status: 'OUT_OF_SERVICE' },
  })
  if (available.length < 3) throw new Error('need three unassigned available units')

  const alreadyStaged = await prismaUnscoped.asset.findMany({
    where: { custodyTruckId: { in: [source.id, destination.id] }, active: true },
  })
  const touched = [
    ...available,
    ...(outOfService ? [outOfService] : []),
    // The trucks' existing kit. "Move all" takes it along, so the cleanup has
    // to know about it — otherwise seeded gear is left on the wrong truck and
    // quietly breaks whatever runs next.
    ...alreadyStaged,
  ].filter(
    (asset, index, all) => all.findIndex((other) => other.id === asset.id) === index,
  )
  const restore = touched.map((asset) => ({
    id: asset.id,
    custodyType: asset.custodyType,
    custodyUserId: asset.custodyUserId,
    custodyTruckId: asset.custodyTruckId,
    custodyAssignedById: asset.custodyAssignedById,
    custodyAssignedAt: asset.custodyAssignedAt,
  }))

  console.log(
    `\nTruck ${source.number} → Truck ${destination.number}\n` +
      `Staging ${available.map((asset) => asset.assetTag).join(', ')}` +
      (outOfService ? ` plus ${outOfService.assetTag} (out of service)` : '') +
      '\n',
  )

  const staff = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'sam@teksolv.com' } })
  // The out-of-service unit is staged directly: the app refuses to *assign* it
  // by hand for good reason, but a unit already on a truck can be taken out of
  // service afterwards, and that is the state under test.
  if (outOfService) {
    await prismaUnscoped.asset.update({
      where: { id: outOfService.id },
      data: {
        custodyType: 'TRUCK',
        custodyTruckId: source.id,
        custodyAssignedById: staff.id,
        custodyAssignedAt: new Date(),
      },
    })
  }

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'sam@teksolv.com')

    // --- scanning the truck label -----------------------------------------
    console.log('Scanning the truck label\n')

    await page.goto(`${BASE}/api/scan/truck/${source.id}`, { waitUntil: 'networkidle' })
    check(
      'scanning a truck label opens that truck',
      page.url().includes(`/trucks/${source.id}`),
      page.url().replace(BASE, ''),
    )
    check(
      'the label also resolves by the number painted on the door',
      await (async () => {
        const byNumber = await page.goto(`${BASE}/api/scan/truck/${source.number}`, {
          waitUntil: 'networkidle',
        })
        return (byNumber?.url() ?? '').includes(`/trucks/${source.id}`)
      })(),
      `truck ${source.number}`,
    )

    // --- staging by scan ---------------------------------------------------
    console.log('\nStaging gear by scan\n')

    for (const asset of available) {
      await page.fill('input[name="scan"]', asset.assetTag)
      await page.getByRole('button', { name: /Stage on truck/ }).click()
      await page.waitForTimeout(1200)
    }

    const afterStaging = await prismaUnscoped.asset.findMany({
      where: { id: { in: available.map((asset) => asset.id) } },
      select: { assetTag: true, custodyTruckId: true, custodyType: true },
    })
    check(
      'three scans stage three units on the truck',
      afterStaging.every(
        (asset) => asset.custodyTruckId === source.id && asset.custodyType === 'TRUCK',
      ),
      afterStaging.map((asset) => asset.assetTag).join(', '),
    )
    check(
      'and each one is on the page',
      await (async () => {
        await page.goto(`${BASE}/trucks/${source.id}`, { waitUntil: 'networkidle' })
        const body = await page.locator('body').innerText()
        return available.every((asset) => body.includes(asset.assetTag))
      })(),
    )
    check(
      'scanning a unit that is already aboard says so rather than erroring',
      await (async () => {
        await page.fill('input[name="scan"]', available[0].assetTag)
        await page.getByRole('button', { name: /Stage on truck/ }).click()
        await page.waitForTimeout(1200)
        return (await page.locator('body').innerText()).includes('already on this truck')
      })(),
      'a scanner that double-fires must not write a second history row',
    )
    check(
      'a tag that does not exist is refused by name',
      await (async () => {
        await page.fill('input[name="scan"]', 'NOSUCHTAG')
        await page.getByRole('button', { name: /Stage on truck/ }).click()
        await page.waitForTimeout(1200)
        return (await page.locator('body').innerText()).includes('No unit with tag')
      })(),
    )

    // --- the move ----------------------------------------------------------
    console.log('\nMoving the kit\n')

    await page.goto(`${BASE}/trucks/${source.id}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Move gear to another truck/ }).click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })

    const boxes = dialog.locator('input[type="checkbox"]:not([disabled])')
    check(
      'the list starts with nothing ticked',
      (await dialog.locator('input[type="checkbox"]:checked').count()) === 0,
      'emptying a truck is a big quiet change; the default is that it does nothing',
    )
    if (outOfService) {
      check(
        'an out-of-service unit is listed as unmovable, with a reason',
        (await dialog.innerText()).includes(unmovableReason('OUT_OF_SERVICE')!),
        'shown rather than hidden — "where did that go" is worse than a greyed-out row',
      )
      check(
        'and cannot be ticked',
        (await dialog.locator('input[type="checkbox"][disabled]').count()) >= 1,
      )
    }

    await dialog.getByRole('button', { name: /Move all/ }).click()
    await page.waitForTimeout(400)
    const tickedAll = await dialog.locator('input[type="checkbox"]:checked').count()
    check(
      'Move all ticks every eligible unit and nothing else',
      tickedAll === (await boxes.count()) && tickedAll >= 3,
      `${tickedAll} ticked`,
    )

    // Untick one — the scenario is "move most of it", not "move everything".
    await boxes.first().uncheck()
    await page.waitForTimeout(300)
    const expectedMoves = tickedAll - 1
    // The list is ordered by tag, so the first box is not necessarily one this
    // test staged — read the row it belongs to instead of assuming.
    const staying = await dialog
      .locator('label:has(input[type="checkbox"]:not(:checked))')
      .first()
      .innerText()
      .then((row) => row.trim().split(/\s+/)[0])
    check(
      'unticking one leaves the rest ticked',
      (await dialog.locator('input[type="checkbox"]:checked').count()) === tickedAll - 1,
    )

    await dialog.locator('select').selectOption(destination.id)
    await dialog.getByRole('button', { name: /Review/ }).click()
    await page.waitForTimeout(500)

    const confirmation = await dialog.innerText()
    check(
      'the confirmation lists what will move before anything happens',
      confirmation.includes(`Moving to Truck ${destination.number}`),
    )
    check(
      'and says nothing has moved yet',
      confirmation.includes('Nothing has moved yet'),
    )
    check(
      'the unticked unit is not in the moving list',
      !confirmation.split('Staying put')[0].includes(staying),
      `${staying} stays on Truck ${source.number}`,
    )

    await dialog.getByRole('button', { name: /Move \d+ to Truck/ }).click()
    await page.waitForTimeout(2500)

    // --- what actually happened --------------------------------------------
    const moved = available.slice(1)
    const after = await prismaUnscoped.asset.findMany({
      where: { id: { in: touched.map((asset) => asset.id) } },
      select: { id: true, assetTag: true, status: true, custodyTruckId: true },
    })
    const on = (id: string) => after.find((asset) => asset.id === id)?.custodyTruckId

    check(
      'the ticked units are now on the destination truck',
      moved.every((asset) => on(asset.id) === destination.id),
      moved.map((asset) => asset.assetTag).join(', '),
    )
    check(
      'the unticked unit stayed where it was',
      (await prismaUnscoped.asset.findFirstOrThrow({ where: { assetTag: staying } }))
        .custodyTruckId === source.id,
      staying,
    )
    if (outOfService) {
      check(
        'and the out-of-service unit was left behind',
        on(outOfService.id) === source.id,
        `${outOfService.assetTag} is not physically on the truck, so its assignment did not travel`,
      )
    }

    // --- the record ---------------------------------------------------------
    console.log('\nWhat was written down\n')

    const events = await prismaUnscoped.custodyEvent.findMany({
      where: { assetId: { in: moved.map((asset) => asset.id) }, truckId: destination.id },
    })
    check(
      'every moved unit got its own custody record',
      events.length === moved.length,
      `${events.length} of ${moved.length}`,
    )

    const log = await prismaUnscoped.auditLog.findFirst({
      where: { action: 'custody.truck.move', entityId: source.id },
      orderBy: { createdAt: 'desc' },
    })
    const meta = (log?.metadata ?? {}) as Record<string, unknown>
    check(
      'the move itself is logged: who, when, from which truck to which',
      Boolean(log) &&
        meta.fromTruck === source.number &&
        meta.toTruck === destination.number &&
        Array.isArray(meta.moved) &&
        (meta.moved as string[]).length === expectedMoves &&
        moved.every((asset) => (meta.moved as string[]).includes(asset.assetTag)),
      `${meta.fromTruck} → ${meta.toTruck}, ${(meta.moved as string[])?.length} moved (ticked ${expectedMoves}), by ${log?.userId === staff.id ? 'Sam Okafor' : 'unknown'}`,
    )
    check(
      'including what could not travel, and why',
      Array.isArray(meta.skipped) &&
        (outOfService
          ? (meta.skipped as { assetTag: string }[]).some(
              (entry) => entry.assetTag === outOfService.assetTag,
            )
          : true),
      JSON.stringify(meta.skipped),
    )
    check(
      'and what was deliberately left behind, kept separate from what could not go',
      Array.isArray(meta.leftBehindByChoice) &&
        (meta.leftBehindByChoice as string[]).includes(staying),
      `left by choice: ${JSON.stringify(meta.leftBehindByChoice)}`,
    )

    // --- readiness ----------------------------------------------------------
    console.log('\nReadiness on both trucks\n')

    const readiness = await getTruckReadiness(db)
    const sourceNow = readiness.find((truck) => truck.id === source.id)!
    const destinationNow = readiness.find((truck) => truck.id === destination.id)!

    check(
      'the destination truck now counts the moved gear',
      moved.every((asset) =>
        destinationNow.stagedAssets.some((staged) => staged.id === asset.id),
      ),
      `${destinationNow.stagedAssets.length} staged on Truck ${destination.number}`,
    )
    check(
      'the source truck no longer does',
      moved.every((asset) => !sourceNow.stagedAssets.some((staged) => staged.id === asset.id)),
      `${sourceNow.stagedAssets.length} left on Truck ${source.number}`,
    )
    check(
      'and readiness follows the assignments with nothing to keep in step',
      sourceNow.ready === sourceNow.stagedAssets.every((asset) => asset.status === 'AVAILABLE') &&
        destinationNow.ready ===
          destinationNow.stagedAssets.every((asset) => asset.status === 'AVAILABLE'),
      outOfService
        ? `Truck ${source.number} reads "check" — it still holds ${outOfService.assetTag}`
        : 'derived from custody, not stored',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    for (const asset of restore) {
      await prismaUnscoped.asset.update({ where: { id: asset.id }, data: asset })
    }
    await prismaUnscoped.custodyEvent.deleteMany({
      where: { assetId: { in: touched.map((asset) => asset.id) } },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { action: { in: ['custody.assign', 'custody.release', 'custody.truck.move'] } },
    })
    await prismaUnscoped.notification.deleteMany({
      where: { entityId: { in: touched.map((asset) => asset.id) } },
    })
    console.log('\n  (test data cleaned up)')
  }

  console.log(failures === 0 ? '\nAll truck checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
