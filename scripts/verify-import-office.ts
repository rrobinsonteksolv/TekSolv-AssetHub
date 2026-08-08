/**
 * The Ops Manager office inventory: non-truck stock, in mixed states.
 *
 * Three things this file exercises that a truck import does not:
 *
 *   • **A holder that is not a truck.** Office and spare stock is *held* at a
 *     location; it is not staged for deployment. Custody would put it on a
 *     readiness panel as gear somebody is carrying, which is a different — and
 *     wrong — claim.
 *   • **Units that arrive already retired**, with a disposition read out of the
 *     comment. The database refuses a retired row without one, so the importer
 *     has to produce a complete retirement or fail the batch.
 *   • **Units that arrive quarantined** — held pending a decision, deployable
 *     by nothing, and deliberately *not* in the Out of Service list, where a
 *     standing "Return to service" button would clear a safety hold in a click.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-import-office.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { availableInWindow, windowFromNow } from '../src/lib/availability'
import { listOutOfService } from '../src/lib/maintenance-queue'
import { listRetired } from '../src/lib/retired'
import { retirementReasonFrom } from '../src/lib/import'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const TAG = 'OFFIMP'
// Deliberately not the real office's name. The importer resolves a holder by
// name, so a fixture called "Ops Manager Office" lands its rows in the actual
// office and then deletes it on the way out — which is how a green test run
// takes the real place with it.
const HOLDER = 'Ops Manager Office (verification)'
const SPARES = 39
const RETIRED = 1
const QUARANTINED = 2

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

/** The office sheet: a holder column, a status column, and a comment. */
function buildCsv(): string {
  const header = [
    'Asset Tag',
    'Model',
    'Manufacturer',
    'Serial',
    'Category',
    'Holder',
    'Status',
    'Comment',
  ].join(',')

  const spares = [
    ['Spare Regulator Diaphragm', 'Respiratory'],
    ['Spare Lens Kit', 'Gas Detection'],
    ['Spare Duct 25ft', 'Confined Space > Ventilation'],
    ['Spare Harness Webbing', 'Fall Protection'],
  ]

  const rows: string[] = []
  for (let index = 0; index < SPARES; index++) {
    const [model, category] = spares[index % spares.length]
    rows.push(
      [
        `${TAG}-S-${String(index + 1).padStart(2, '0')}`,
        model,
        'Air Systems',
        `${TAG}SN${1000 + index}`,
        category,
        HOLDER,
        'ACTIVE',
        'Office spare stock',
      ].join(','),
    )
  }

  rows.push(
    [
      `${TAG}-RET-1`,
      'Retired Regulator',
      'MSA',
      `${TAG}SN9001`,
      'Respiratory',
      HOLDER,
      'RETIRED',
      'Discarded after failing annual flow test — cut up and binned',
    ].join(','),
  )

  for (let index = 0; index < QUARANTINED; index++) {
    rows.push(
      [
        `${TAG}-Q-${index + 1}`,
        'Suspect Lanyard',
        'MSA',
        `${TAG}SN950${index}`,
        'Fall Protection',
        HOLDER,
        'QUARANTINED',
        'Held pending manufacturer recall check',
      ].join(','),
    )
  }

  return [header, ...rows].join('\n')
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nA disposition, read from what the operator wrote\n')
    // -----------------------------------------------------------------------

    check(
      'the comment is parsed into a disposition where it says something',
      retirementReasonFrom('Discarded after failing annual flow test — cut up and binned') ===
        'SCRAPPED' &&
        retirementReasonFrom('Sold to Corrado with the 2019 batch') === 'SOLD' &&
        retirementReasonFrom('Lost on the Marcellus job') === 'LOST' &&
        retirementReasonFrom('Damaged beyond repair in transit') === 'DAMAGED_BEYOND_REPAIR',
    )
    check(
      'and anything it cannot recognise is OTHER, not a guess',
      retirementReasonFrom('see file') === 'OTHER' && retirementReasonFrom(null) === 'OTHER',
      'the comment is kept verbatim as the note, so the list shows the operator’s words',
    )

    // -----------------------------------------------------------------------
    console.log('\nImporting the office sheet\n')
    // -----------------------------------------------------------------------

    await signIn(page, 'ray@teksolv.com')
    await page.goto(`${BASE}/inventory/import`, { waitUntil: 'networkidle' })

    await page.setInputFiles('input[type="file"]', {
      name: 'ops-manager-office.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(buildCsv(), 'utf8'),
    })
    // Two steps: read the file, then commit what it says. The preview is not a
    // formality — it is where the batch says what it is about to do.
    await page.getByRole('button', { name: /Preview import/i }).click()
    await page.waitForTimeout(2_500)

    const preview = await page.locator('main').innerText()
    check(
      'the preview says where the stock is held',
      preview.includes(HOLDER),
      preview.split('\n').find((line) => line.includes(HOLDER)) ?? '',
    )
    check(
      'and names what is not arriving available',
      /retired/i.test(preview) && /quarantined/i.test(preview),
      preview.split('\n').find((line) => line.includes('Not arriving available')) ?? '',
    )

    await page.getByRole('button', { name: /^Import \d+ assets?$/ }).click()
    await page.waitForTimeout(4_000)

    const imported = await db.asset.findMany({
      where: { assetTag: { startsWith: TAG } },
      select: {
        id: true,
        assetTag: true,
        status: true,
        active: true,
        custodyType: true,
        custodyLocationId: true,
        retiredAt: true,
        retiredReason: true,
        retiredNote: true,
        custodyLocation: { select: { name: true, type: true } },
      },
    })
    check(
      'every row landed',
      imported.length === SPARES + RETIRED + QUARANTINED,
      `${imported.length} of ${SPARES + RETIRED + QUARANTINED}`,
    )

    // -----------------------------------------------------------------------
    console.log('\nHeld at the office, not staged for deployment\n')
    // -----------------------------------------------------------------------

    // Everything except the retired one, which holds nothing by definition.
    const placeable = imported.filter((asset) => asset.status !== 'RETIRED')
    check(
      `all of it is held at the ${HOLDER}`,
      placeable.every((asset) => asset.custodyLocation?.name === HOLDER),
      `${placeable.filter((a) => a.custodyLocation?.name === HOLDER).length} of ${placeable.length}`,
    )
    check(
      'the holder was created for it',
      imported.find((asset) => asset.custodyLocation)?.custodyLocation?.type === 'OFFICE',
      'a holder is a name somebody gave a place — unlike a truck, there is no vehicle to invent',
    )
    check(
      'and it is held as custody, in the same set as a truck or a person',
      placeable.every((asset) => asset.custodyType === 'LOCATION'),
      'one holder at a time, with a CustodyEvent — a holder is a holder',
    )
    check(
      'so none of it appears on a truck',
      (await db.asset.count({
        where: { assetTag: { startsWith: TAG }, custodyTruckId: { not: null } },
      })) === 0,
    )

    const spares = imported.filter((asset) => asset.assetTag.includes('-S-'))
    check('the spares are available stock', spares.length === SPARES, `${spares.length}`)
    // A consequence of holders being real custody, and worth stating: office
    // stock now reads *Assigned* rather than free-to-take, exactly as gear
    // staged on a truck does. Renting one out means releasing it from the
    // office first — the same step a truck's gear needs.
    check(
      'and they read as assigned to the office, not as free-to-take',
      (await db.asset.count({
        where: { assetTag: { startsWith: `${TAG}-S-` }, custodyType: 'LOCATION' },
      })) === SPARES,
      'a holder holds — the free-to-take pool is general stock, which this is not',
    )

    // -----------------------------------------------------------------------
    console.log('\nOne arrived retired\n')
    // -----------------------------------------------------------------------

    const retired = imported.find((asset) => asset.assetTag === `${TAG}-RET-1`)
    check(
      'it is retired, complete with a disposition',
      retired?.status === 'RETIRED' &&
        !retired.active &&
        retired.retiredAt !== null &&
        retired.retiredReason === 'SCRAPPED',
      `${retired?.status} · ${retired?.retiredReason}`,
    )
    check(
      'with the operator’s own words kept as the note',
      retired?.retiredNote?.includes('cut up and binned') === true,
      retired?.retiredNote ?? '—',
    )
    check(
      'it is in the Retired section',
      (await listRetired(db)).some((entry) => entry.id === retired!.id),
    )
    check(
      'and deployable by nothing',
      (await db.asset.count({
        where: { id: retired!.id, ...availableInWindow(windowFromNow(new Date())) },
      })) === 0,
    )

    // -----------------------------------------------------------------------
    console.log('\nTwo arrived quarantined\n')
    // -----------------------------------------------------------------------

    const held = imported.filter((asset) => asset.status === 'QUARANTINED')
    check('both are held', held.length === QUARANTINED, `${held.length}`)
    check(
      'still owned — quarantine is not retirement',
      held.every((asset) => asset.active && asset.retiredAt === null),
      'the unit is on the premises and on the books; it is just not usable',
    )
    check(
      'deployable by nothing',
      (await db.asset.count({
        where: { assetTag: { startsWith: `${TAG}-Q-` }, ...availableInWindow(windowFromNow(new Date())) },
      })) === 0,
    )
    check(
      'and not offered for checkout',
      (await db.asset.count({
        where: { assetTag: { startsWith: `${TAG}-Q-` }, active: true, status: 'AVAILABLE' },
      })) === 0,
    )

    // The decision this was built on: quarantine is its own state precisely so
    // it does not sit beside a one-click "Return to service".
    const oos = await listOutOfService(db)
    check(
      'held gear is NOT in the Out of Service list',
      !oos.some((row) => row.asset.assetTag.startsWith(`${TAG}-Q-`)),
      'that list carries a standing “Return to service” button — a hold cleared in one click by somebody who did not know it was a hold',
    )

    await page.goto(`${BASE}/inventory?q=${TAG}-Q-`, { waitUntil: 'networkidle' })
    check(
      'but it is visible in inventory, badged as quarantined',
      (await page.locator('main').innerText()).toLowerCase().includes('quarantined'),
      'held, not hidden',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    const ids = (
      await prismaUnscoped.asset.findMany({
        where: { orgId: org.id, assetTag: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((row) => row.id)
    if (ids.length) {
      await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: ids } } })
      await prismaUnscoped.notification.deleteMany({ where: { entityId: { in: ids } } })
      await prismaUnscoped.auditLog.deleteMany({ where: { entityId: { in: ids } } })
      await prismaUnscoped.asset.deleteMany({ where: { id: { in: ids } } })
    }
    // Only ever the fixture's own holder, and only once it is empty: a delete
    // here cascades a null into `custodyLocationId` and leaves live assets
    // claiming a holder that no longer exists.
    await prismaUnscoped.location.deleteMany({
      where: { orgId: org.id, name: HOLDER, custodyOf: { none: {} }, assets: { none: {} } },
    })
    console.log(`\n(removed ${ids.length} imported units and the ${HOLDER} location)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll office-import checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
