/**
 * Kits and bags: grouping within a holder.
 *
 * The idea being tested is that **membership is the expectation and custody is
 * the presence**. A container has no manifest table — an item assigned to
 * George's Red Rigging Bag is supposed to be in it, and whether it actually is
 * follows from where the unit is right now. So the interesting checks are not
 * "does the list render"; they are:
 *
 *   • a kit with everything present reads complete;
 *   • taking one item away makes the kit short *without anybody editing a
 *     checklist*, and the kit says which item and why;
 *   • moving the kit moves the gear through the same `assignCustody` the truck
 *     move-kit flow uses, in one transaction, leaving behind only what cannot
 *     travel — and saying so.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-containers.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getContainer, listContainers } from '../src/lib/containers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const TAG = 'KITIMP'
// Named apart from the real prop's bag of almost the same name. A fixture that
// borrows a live name gets deleted by its own teardown along with the real one.
const KIT = "George's Red Rigging Bag (verification)"

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

function buildCsv(truckNumber: string): string {
  const header = ['Asset Tag', 'Model', 'Category', 'Truck', 'Container', 'Asset Type'].join(',')
  const rows = Array.from({ length: 6 }, (_, index) =>
    [
      `${TAG}-${String(index + 1).padStart(2, '0')}`,
      index % 2 === 0 ? 'Rigging Plate' : 'Locking Carabiner',
      'Rope Rescue > Rigging',
      truckNumber,
      KIT,
      'RESCUE',
    ].join(','),
  )
  return [header, ...rows].join('\n')
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const home = await db.truck.findFirstOrThrow({
    where: { active: true, number: '167' },
    select: { id: true, number: true },
  })
  const elsewhere = await db.truck.findFirstOrThrow({
    where: { active: true, id: { not: home.id } },
    orderBy: { number: 'asc' },
    select: { id: true, number: true },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nA kit arrives with its gear\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/inventory/import`, { waitUntil: 'networkidle' })
    await page.setInputFiles('input[type="file"]', {
      name: 'rigging-bag.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(buildCsv(home.number), 'utf8'),
    })
    await page.getByRole('button', { name: /Preview import/i }).click()
    await page.waitForTimeout(2_500)
    await page.getByRole('button', { name: /^Import \d+ assets?$/ }).click()
    await page.waitForTimeout(4_000)

    const container = await db.container.findFirst({
      where: { name: KIT },
      include: { assets: { select: { id: true, assetTag: true } } },
    })
    check('the kit was created by the import', container !== null, KIT)
    check('with all six items in it', container?.assets.length === 6, `${container?.assets.length}`)
    check(
      'and it lives where its contents were staged',
      container?.truckId === home.id,
      `Truck ${home.number} — a bag has to be somewhere, and its contents are the only address a sheet gives`,
    )

    const staged = await db.asset.count({
      where: { assetTag: { startsWith: TAG }, custodyTruckId: home.id },
    })
    check(
      'membership did not replace custody',
      staged === 6,
      'the gear is staged on the truck *and* belongs to the bag — two columns, two questions',
    )

    // -----------------------------------------------------------------------
    console.log('\nComplete means everything is with it\n')
    // -----------------------------------------------------------------------

    let summary = await getContainer(db, container!.id)
    check('the kit reads complete', summary?.complete === true, `${summary?.present} present`)
    check('with nothing missing', summary?.missing === 0)

    // Take one item away — *without touching any checklist*. This is the whole
    // point of deriving completeness from custody.
    const taken = container!.assets[0]
    await prismaUnscoped.asset.update({
      where: { id: taken.id },
      data: { custodyTruckId: elsewhere.id, custodyType: 'TRUCK', custodyAssignedAt: new Date() },
    })

    summary = await getContainer(db, container!.id)
    check(
      'moving one item makes the kit short, with no checklist edited',
      summary?.complete === false && summary.missing === 1,
      `${summary?.present} of ${summary?.members.length} present`,
    )
    const missing = summary?.members.find((member) => member.id === taken.id)
    check(
      'and the kit says which item and where it went',
      missing?.missingReason?.includes(elsewhere.number) === true,
      missing?.missingReason ?? 'no reason given',
    )

    await page.goto(`${BASE}/containers`, { waitUntil: 'networkidle' })
    // Lowercased: the "away" chip is `text-transform: uppercase`, and
    // `innerText` returns text as *rendered*, not as authored.
    const index = (await page.locator('main').innerText()).toLowerCase()
    check('the index flags it as short', index.includes('1 away'), KIT)

    await page.goto(`${BASE}/containers/${container!.id}`, { waitUntil: 'networkidle' })
    const detail = await page.locator('main').innerText()
    check('the kit page says so too', detail.includes('Short 1'))
    check(
      'and lists the missing item rather than hiding it',
      detail.includes(taken.assetTag),
      '“where did that rope go” is the question this page is opened with',
    )

    // Put it back, so the move test starts from a whole kit.
    await prismaUnscoped.asset.update({
      where: { id: taken.id },
      data: { custodyTruckId: home.id },
    })

    // -----------------------------------------------------------------------
    console.log('\nThe whole kit moves at once\n')
    // -----------------------------------------------------------------------

    // One item cannot travel: quarantined gear is held wherever it is.
    const held = container!.assets[1]
    await prismaUnscoped.asset.update({
      where: { id: held.id },
      data: { status: 'QUARANTINED' },
    })

    await page.goto(`${BASE}/containers/${container!.id}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Move this kit/i }).click()
    const dialog = page.locator('[role="dialog"]', { hasText: 'Move' })
    await dialog.waitFor({ state: 'visible', timeout: 20_000 })

    check(
      'the confirmation says what cannot travel, before committing',
      (await dialog.innerText()).includes(held.assetTag),
      'the difference between choosing to leave it and finding out you did',
    )

    await dialog.locator('select[name="destination"]').selectOption(`truck:${elsewhere.id}`)
    await dialog.getByRole('button', { name: /Move \d+ items?/ }).click()
    await page.waitForTimeout(3_000)

    const moved = await db.container.findFirstOrThrow({
      where: { id: container!.id },
      select: { truckId: true },
    })
    check(
      'the kit itself is on the new truck',
      moved.truckId === elsewhere.id,
      `Truck ${elsewhere.number}`,
    )
    check(
      'and so is everything that could travel',
      (await db.asset.count({
        where: { assetTag: { startsWith: TAG }, custodyTruckId: elsewhere.id },
      })) === 5,
      '5 of 6 — the quarantined one stayed where it was',
    )
    check(
      'the held item did not move',
      (
        await prismaUnscoped.asset.findUniqueOrThrow({
          where: { id: held.id },
          select: { custodyTruckId: true },
        })
      ).custodyTruckId === home.id,
      'a hold is not something a bulk action gets to override',
    )

    check(
      'every moved unit got a custody record, exactly as if scanned across',
      (await db.custodyEvent.count({
        where: { asset: { assetTag: { startsWith: TAG } }, truckId: elsewhere.id },
      })) === 5,
      'the same assignCustody the truck move-kit flow uses — not a second implementation',
    )
    check(
      'and the move is on the audit trail with what stayed behind',
      (
        (
          await db.auditLog.findFirst({
            where: { entityType: 'Container', entityId: container!.id, action: 'container.move' },
            orderBy: { createdAt: 'desc' },
          })
        )?.metadata as { leftBehind?: unknown[] } | null
      )?.leftBehind?.length === 1,
    )

    // The kit is now short by exactly the item that could not come.
    const after = await getContainer(db, container!.id)
    check(
      'so the kit reads short by the one left behind',
      after?.missing === 1 && after.present === 5,
      `${after?.present} of ${after?.members.length} present`,
    )

    // -----------------------------------------------------------------------
    console.log('\nOrg-scoped, and under any holder\n')
    // -----------------------------------------------------------------------

    check(
      'kits are listed org-wide, not per truck',
      (await listContainers(db)).some((entry) => entry.id === container!.id),
      'a bag can sit under a truck, a room, or move between them',
    )

    const office = await prismaUnscoped.location.create({
      data: { orgId: org.id, name: `${TAG} Store Room`, type: 'OFFICE' },
    })
    await prismaUnscoped.container.update({
      where: { id: container!.id },
      data: { truckId: null, locationId: office.id },
    })
    const inRoom = await getContainer(db, container!.id)
    check(
      'a kit can live in a room as well as on a truck',
      inRoom?.areaLabel === `${TAG} Store Room`,
      inRoom?.areaLabel ?? '',
    )
    check(
      'and its gear, still staged on a truck, reads as away from it',
      (inRoom?.missing ?? 0) >= 5,
      'the bag is in the store room; the gear is on a truck — which is exactly what "short" should mean',
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
    // Every container this run made, wherever it ended up: the kit is moved
    // between holders during the test, so it cannot be found by holder — but it
    // can be found by the name only this fixture uses.
    const kits = await prismaUnscoped.container.findMany({
      where: { orgId: org.id, name: KIT },
      select: { id: true },
    })
    for (const kit of kits) {
      await prismaUnscoped.auditLog.deleteMany({ where: { entityId: kit.id } })
      await prismaUnscoped.container.delete({ where: { id: kit.id } })
    }
    await prismaUnscoped.location.deleteMany({
      where: { orgId: org.id, name: { startsWith: TAG } },
    })
    console.log(`\n(removed ${ids.length} units, the kit, and its store room)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll container checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
