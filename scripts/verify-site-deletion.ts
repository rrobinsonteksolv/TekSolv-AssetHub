/**
 * Deleting a site, and refusing to.
 *
 * Three jobsites were typed in for testing and never used, so they were
 * clutter in every picker. They are gone. The half worth testing forever is the
 * other one: the guard that stops the next delete taking something real with
 * it.
 *
 * Deactivating is the usual answer, because a place gear has passed through is
 * part of how that gear got where it is. Deletion is for entries that were
 * never anything — and "never anything" has to be checked, not asserted by
 * whoever is doing the tidying.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-site-deletion.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { checkSiteDeletable } from '../src/lib/site-deletion'
import { listAreas } from '../src/lib/areas'
import { getFormOptions } from '../src/lib/assets'
import { listLocationsAndTrucks } from '../src/lib/settings'
import { listContainerDestinations } from '../src/lib/containers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const DELETED = [
  'Greene Co. Compressor',
  'Marcellus Pad 7',
  'Washington Co. Turnaround',
  'New Castle Warehouse',
]
const TAG = 'SITEDEL'

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

async function settle(page: Page) {
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
  return (await page.locator('main').innerText()).toLowerCase()
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const made: string[] = []
  const madeConsumables: string[] = []
  // Counted now, compared later. A literal here fails the moment anybody seeds
  // a demo order, which says nothing about whether deleting a site touched the
  // fleet.
  const fleetBefore = await db.asset.count()

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nThe three are gone, everywhere\n')
    // -----------------------------------------------------------------------

    check(
      'no location carries any of the three names',
      (await db.location.count({ where: { name: { in: DELETED } } })) === 0,
      DELETED.join(', '),
    )

    const { locations } = await listLocationsAndTrucks(db)
    check(
      'settings does not list them',
      DELETED.every((name) => !locations.some((row) => row.name === name)),
      locations.map((row) => row.name).join(', '),
    )

    const areas = await listAreas(db)
    const options = await getFormOptions(db)
    const destinations = await listContainerDestinations(db)
    check(
      'the Areas list does not carry them',
      DELETED.every((name) => !areas.some((area) => area.name === name)),
    )
    check(
      'nor the assignment picker',
      DELETED.every((name) => !options.areas.some((area) => area.name === name)),
      'the picker reads listAreas, so this follows from the line above — checked anyway, because that is the coupling the whole thing rests on',
    )
    check(
      'nor the move-a-kit destinations',
      DELETED.every((name) => !destinations.locations.some((row) => row.name === name)),
    )
    check(
      'nor the asset form’s "filed at" list',
      DELETED.every((name) => !options.locations.some((row) => row.name === name)),
    )

    // -----------------------------------------------------------------------
    console.log('\nNothing real went with them\n')
    // -----------------------------------------------------------------------

    check(
      'the fleet is untouched',
      (await db.asset.count()) === fleetBefore,
      `${await db.asset.count()} of ${fleetBefore} assets — measured at the start rather than hardcoded, so demo data does not fail an assertion about deletion`,
    )
    check(
      'and no row anywhere points at a location that is gone',
      (
        await Promise.all(
          (
            [
              ['ConsumableStock', 'locationId'],
              ['ConsumableLot', 'locationId'],
              ['ConsumableTxn', 'locationId'],
              ['Container', 'locationId'],
              ['CustodyEvent', 'locationId'],
              ['Membership', 'homeLocationId'],
              ['Asset', 'custodyLocationId'],
            ] as const
          ).map(([table, column]) =>
            prismaUnscoped
              .$queryRawUnsafe<{ count: bigint }[]>(
                `SELECT COUNT(*)::bigint AS count FROM "${table}" t
                 WHERE t."${column}" IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM "Location" l WHERE l."id" = t."${column}")`,
              )
              .then((rows) => Number(rows[0].count)),
          ),
        )
      ).every((count) => count === 0),
      'seven tables checked — a dangling id renders as a blank place rather than an error',
    )
    check(
      'the seven units filed there are still on the books',
      (await db.asset.count({
        where: {
          assetTag: {
            in: ['FAM001020', 'FAM002001', 'FAM001007', 'FAM001008', 'FAM004001', 'FAM002003', 'FAM001011'],
          },
        },
      })) === 7,
      'only their catalogue address was cleared — the units are out on rent and hold nothing anyway',
    )
    check(
      'and their rentals are still open',
      (await db.rental.count({
        where: {
          actualReturnDate: null,
          asset: { assetTag: { in: ['FAM001020', 'FAM002001', 'FAM001007'] } },
        },
      })) === 3,
      'deleting a site is not a way to close a rental',
    )
    check(
      'no asset is left pointing at a site that no longer exists',
      (await prismaUnscoped.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM "Asset" a
         WHERE a."locationId" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "Location" l WHERE l."id" = a."locationId")`,
      ).then((rows) => Number(rows[0].count))) === 0,
      'a dangling pointer would render as a blank place rather than an error',
    )

    // -----------------------------------------------------------------------
    console.log('\nThe guard that stays\n')
    // -----------------------------------------------------------------------

    const category = await db.category.findFirstOrThrow({ select: { id: true } })
    // Custody has to say who assigned it and when — `asset_custody_attributed`
    // sees to that, and a fixture is not exempt from the app's own rules.
    const actor = await prismaUnscoped.user.findFirstOrThrow({ select: { id: true } })

    // A site holding a unit.
    const holding = await prismaUnscoped.location.create({
      data: { orgId: org.id, name: `${TAG} Holding Yard`, type: 'YARD' },
    })
    made.push(holding.id)
    const unit = await prismaUnscoped.asset.create({
      data: {
        orgId: org.id,
        assetTag: `${TAG}-1`,
        categoryId: category.id,
        status: 'AVAILABLE',
        condition: 'GOOD',
        assetType: 'RESCUE',
        custodyType: 'LOCATION',
        custodyLocationId: holding.id,
        custodyAssignedById: actor.id,
        custodyAssignedAt: new Date(),
      },
    })
    const heldCheck = await checkSiteDeletable(db, holding.id)
    check(
      'a site holding gear cannot be deleted',
      !heldCheck.deletable && heldCheck.blockers.some((line) => /held here/.test(line)),
      heldCheck.blockers.join(' | '),
    )
    check(
      'and it says to reassign or deactivate instead',
      heldCheck.blockers.some((line) => /reassign/i.test(line) && /deactivate/i.test(line)),
      'a refusal that does not say what to do instead is just a wall',
    )

    // A site with history but nothing on it now.
    const historic = await prismaUnscoped.location.create({
      data: { orgId: org.id, name: `${TAG} Old Yard`, type: 'YARD' },
    })
    made.push(historic.id)
    await prismaUnscoped.custodyEvent.create({
      data: {
        orgId: org.id,
        assetId: unit.id,
        type: 'LOCATION',
        locationId: historic.id,
        actorId: actor.id,
      },
    })
    const historyCheck = await checkSiteDeletable(db, historic.id)
    check(
      'a site with custody history cannot be deleted, even holding nothing today',
      !historyCheck.deletable && historyCheck.blockers.some((line) => /custody record/.test(line)),
      historyCheck.blockers.join(' | '),
    )

    // A site with a kit at it.
    const kitted = await prismaUnscoped.location.create({
      data: { orgId: org.id, name: `${TAG} Kit Room`, type: 'YARD' },
    })
    made.push(kitted.id)
    await prismaUnscoped.container.create({
      data: { orgId: org.id, name: `${TAG} Bag`, locationId: kitted.id },
    })
    const kitCheck = await checkSiteDeletable(db, kitted.id)
    check(
      'a site with a kit sitting at it cannot be deleted',
      !kitCheck.deletable && kitCheck.blockers.some((line) => /kit/.test(line)),
      kitCheck.blockers.join(' | '),
    )

    // Supply stock is *overridable* — it can be demo data, and adjusting it out
    // through the ledger leaves a trail. That is a different kind of thing from
    // gear held here, and the guard says so rather than lumping them together.
    const stocked = await prismaUnscoped.location.create({
      data: { orgId: org.id, name: `${TAG} Stocked Room`, type: 'WAREHOUSE' },
    })
    made.push(stocked.id)
    const consumable = await prismaUnscoped.consumable.create({
      data: { orgId: org.id, name: `${TAG} widgets`, unit: 'each' },
    })
    madeConsumables.push(consumable.id)
    await prismaUnscoped.consumableStock.create({
      data: { orgId: org.id, consumableId: consumable.id, locationId: stocked.id, onHand: 12 },
    })
    const stockedCheck = await checkSiteDeletable(db, stocked.id)
    check(
      'supply stock does not hard-block — it can be overridden',
      stockedCheck.blockers.length === 0 && stockedCheck.forceable,
      stockedCheck.overridable.join(' | '),
    )
    check(
      'but it is not deletable without saying so',
      !stockedCheck.deletable && stockedCheck.stockToClear === 1,
      'a site with stock on its shelf is not a site nobody used',
    )
    check(
      'while held gear is never forceable, whatever anybody types',
      !heldCheck.forceable && heldCheck.blockers.length > 0,
      'gear and custody history are the record of physical things; no dialog makes erasing that right',
    )

    // And one that really is empty.
    const empty = await prismaUnscoped.location.create({
      data: { orgId: org.id, name: `${TAG} Never Used`, type: 'JOBSITE' },
    })
    made.push(empty.id)
    const emptyCheck = await checkSiteDeletable(db, empty.id)
    check(
      'a site that was never used can be',
      emptyCheck.deletable && emptyCheck.blockers.length === 0 && emptyCheck.unfiles === 0,
      'which is what the three jobsites were',
    )

    // -----------------------------------------------------------------------
    console.log('\nThrough the button, not just the helper\n')
    // -----------------------------------------------------------------------

    await signIn(page, 'ray@teksolv.com')
    await page.goto(`${BASE}/settings/locations`, { waitUntil: 'networkidle' })
    const before = await settle(page)
    check(
      'settings shows none of the three',
      DELETED.every((name) => !before.includes(name.toLowerCase())),
    )
    check('and offers a Delete on a site row', before.includes('delete'))

    // Refuse the one holding gear.
    // Both clicks scoped to the one row. Clicking the page's *last* Delete
    // would hit whichever site happens to sort last, which is a different
    // test than the one this claims to be.
    const holdingRow = page
      .locator('div.border-b')
      .filter({ hasText: `${TAG} Holding Yard` })
      .last()
    await holdingRow.getByRole('button', { name: 'Delete' }).click()
    await holdingRow.getByRole('button', { name: 'Delete' }).click()
    await page.waitForTimeout(3_000)
    const refusedText = (await page.locator('main').innerText()).toLowerCase()
    check(
      'the button refuses a site holding gear, with the reason',
      refusedText.includes('cannot be deleted') && refusedText.includes('reassign'),
      refusedText.split('\n').find((line) => line.includes('cannot be deleted')) ?? 'no message',
    )
    check(
      'and the site is still there',
      (await prismaUnscoped.location.count({ where: { id: holding.id } })) === 1,
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
    await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: ids } } })
    await prismaUnscoped.custodyEvent.deleteMany({ where: { locationId: { in: made } } })
    await prismaUnscoped.asset.updateMany({
      where: { custodyLocationId: { in: made } },
      data: { custodyType: null, custodyLocationId: null },
    })
    await prismaUnscoped.asset.deleteMany({ where: { id: { in: ids } } })
    await prismaUnscoped.consumableTxn.deleteMany({ where: { consumableId: { in: madeConsumables } } })
    await prismaUnscoped.consumableLot.deleteMany({ where: { consumableId: { in: madeConsumables } } })
    await prismaUnscoped.consumableStock.deleteMany({ where: { consumableId: { in: madeConsumables } } })
    await prismaUnscoped.consumable.deleteMany({ where: { id: { in: madeConsumables } } })
    await prismaUnscoped.container.deleteMany({ where: { locationId: { in: made } } })
    await prismaUnscoped.location.deleteMany({ where: { id: { in: made } } })
    console.log(`\n(removed ${made.length} test sites and ${ids.length} test unit(s))`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll site-deletion checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
