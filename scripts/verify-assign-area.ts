/**
 * Reassigning a unit: every area, and the kits inside them.
 *
 * The picker offered trucks and nothing else. So the Rescue Prop had its own
 * page, fifty-one items on it, and no way to send a fifty-second there — a gap
 * that reads as the feature being broken rather than missing, because the place
 * is plainly right there in the app.
 *
 * The claim under test is that **the picker and the area pages are the same
 * list**. Not "the picker also has some rooms in it" — that would drift the
 * first time an area was added. `getFormOptions` calls `listAreas`, the same
 * function `/areas` calls, and the check below compares the two rather than
 * checking either against a hardcoded expectation.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-assign-area.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getArea, listAreas } from '../src/lib/areas'
import { getFormOptions } from '../src/lib/assets'
import { listContainers } from '../src/lib/containers'
import { assignCustody } from '../src/server/custody-core'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const PROP = 'Rescue Prop'
const OFFICE = 'Ops Manager Office'

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
}

/** Open a unit's drawer and get the assignment form on screen. */
async function openPicker(page: Page, assetId: string) {
  await page.goto(`${BASE}/inventory/${assetId}`, { waitUntil: 'networkidle' })
  await settle(page)
  await page.getByRole('button', { name: /^(Reassign|Assign)$/ }).first().click()
  await page.getByLabel('Assignment type').waitFor({ state: 'visible', timeout: 15_000 })
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const prop = await db.location.findFirstOrThrow({ where: { name: PROP } })
  const office = await db.location.findFirstOrThrow({ where: { name: OFFICE } })
  const truck = await db.truck.findFirstOrThrow({
    where: { active: true },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, office: true },
  })
  const kit = (await listContainers(db)).find((row) => row.areaId === prop.id)!

  // A unit of our own to move about, so nothing real is disturbed.
  const category = await db.category.findFirstOrThrow({ select: { id: true } })
  const subject = await prismaUnscoped.asset.create({
    data: {
      orgId: org.id,
      assetTag: 'ASSIGNTEST-1',
      model: 'Assignment probe',
      categoryId: category.id,
      status: 'AVAILABLE',
      condition: 'GOOD',
      assetType: 'RESCUE',
    },
    select: { id: true, assetTag: true },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nOne source, so the two lists cannot drift\n')
    // -----------------------------------------------------------------------

    const areas = await listAreas(db)
    const options = await getFormOptions(db)
    check(
      'the picker is handed exactly the areas the area pages are built from',
      JSON.stringify(options.areas.map((area) => `${area.kind}:${area.id}`).sort()) ===
        JSON.stringify(areas.map((area) => `${area.kind}:${area.id}`).sort()),
      `${options.areas.length} areas · both from listAreas, not two queries that agree today`,
    )
    check(
      'which includes rooms as well as trucks',
      options.areas.some((area) => area.id === prop.id) &&
        options.areas.some((area) => area.id === office.id) &&
        options.areas.some((area) => area.kind === 'TRUCK'),
      'if an area is real enough to have a page, it is real enough to assign to',
    )
    check(
      'and the kits inside them',
      options.kits.some((row) => row.id === kit.id && row.locationId === prop.id),
      `${options.kits.length} kits offered`,
    )

    await signIn(page, 'ray@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nWhat the dropdown actually offers\n')
    // -----------------------------------------------------------------------

    await openPicker(page, subject.id)
    await page.getByLabel('Assignment type').selectOption('AREA')
    const areaSelect = page.getByLabel('Area')
    await areaSelect.waitFor({ state: 'visible', timeout: 10_000 })

    const groups = await page.locator('select[aria-label="Area"] optgroup').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('label') ?? ''),
    )
    const labels = await page.locator('select[aria-label="Area"] option').allInnerTexts()
    const values = await page.locator('select[aria-label="Area"] option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value),
    )

    check(
      'the office groupings for trucks are still there',
      groups.some((label) => /Office$/.test(label)),
      groups.join(' · '),
    )
    check('with a Rescue areas group beside them', groups.includes('Rescue areas'), groups.join(' · '))
    check(
      'the Rescue Prop is in it',
      values.includes(`LOCATION:${prop.id}`),
      labels.find((label) => label.includes(PROP)) ?? 'absent',
    )
    check(
      'and the Ops Manager Office',
      values.includes(`LOCATION:${office.id}`),
      labels.find((label) => label.includes(OFFICE)) ?? 'absent',
    )
    check(
      'the trucks are still all there',
      values.includes(`TRUCK:${truck.id}`),
      `Truck ${truck.number}`,
    )
    check(
      'every area on the list is offered, with none missing',
      areas.every((area) => values.includes(`${area.kind}:${area.id}`)),
      `${values.filter((value) => value.split(':').length === 2).length} areas on the menu · ${areas.length} exist`,
    )
    check(
      'kits appear nested under their own area',
      values.includes(`LOCATION:${prop.id}:${kit.id}`) &&
        labels.some((label) => label.includes(kit.name)),
      `${kit.name} sits under ${PROP}`,
    )

    // -----------------------------------------------------------------------
    console.log('\nPicking one moves the unit\n')
    // -----------------------------------------------------------------------

    await areaSelect.selectOption(`LOCATION:${office.id}`)
    await page.getByRole('button', { name: /Save assignment/i }).click()
    await page.waitForTimeout(3_000)

    let moved = await prismaUnscoped.asset.findUniqueOrThrow({
      where: { id: subject.id },
      select: { custodyType: true, custodyLocationId: true, containerId: true },
    })
    check(
      'it is held at the Ops Manager Office',
      moved.custodyType === 'LOCATION' && moved.custodyLocationId === office.id,
      `${moved.custodyType} · ${moved.custodyLocationId === office.id ? OFFICE : moved.custodyLocationId}`,
    )
    check(
      'and it shows up on that area’s page',
      (await getArea(db, 'LOCATION', office.id))!.loose.some((item) => item.id === subject.id),
      'the picker and the page read the same columns',
    )
    check(
      'with a CustodyEvent, the same as staging on a truck writes',
      (await prismaUnscoped.custodyEvent.count({
        where: { assetId: subject.id, locationId: office.id },
      })) === 1,
      '“who moved it and when” answers the same way whichever area it went to',
    )

    // -----------------------------------------------------------------------
    console.log('\nAnd straight into a kit\n')
    // -----------------------------------------------------------------------

    await openPicker(page, subject.id)
    await page.getByLabel('Assignment type').selectOption('AREA')
    await page.getByLabel('Area').selectOption(`LOCATION:${prop.id}:${kit.id}`)
    await page.getByRole('button', { name: /Save assignment/i }).click()
    await page.waitForTimeout(3_000)

    moved = await prismaUnscoped.asset.findUniqueOrThrow({
      where: { id: subject.id },
      select: { custodyType: true, custodyLocationId: true, containerId: true },
    })
    check(
      'the unit is at the Rescue Prop',
      moved.custodyLocationId === prop.id,
      moved.custodyLocationId === prop.id ? PROP : String(moved.custodyLocationId),
    )
    check('and in the kit', moved.containerId === kit.id, kit.name)

    const propArea = await getArea(db, 'LOCATION', prop.id)
    const inKit = propArea!.kits.find((row) => row.id === kit.id)
    check(
      'the area page shows it inside that kit, not loose',
      inKit!.items.some((item) => item.id === subject.id) &&
        !propArea!.loose.some((item) => item.id === subject.id),
      `${kit.name} now holds ${inKit!.items.length}`,
    )
    check(
      'and the kit still reads complete',
      (await listContainers(db)).find((row) => row.id === kit.id)?.complete === true,
      'membership and custody agree, which is what completeness measures',
    )

    // -----------------------------------------------------------------------
    console.log('\nA kit cannot be picked away from its own area\n')
    // -----------------------------------------------------------------------

    // Not reachable through the dropdown — the area and the kit travel in one
    // option, so they cannot disagree there. Exercised against the core
    // directly, which is what a stale tab or a hand-posted form would reach.
    const actor = await prismaUnscoped.user.findFirstOrThrow({ select: { id: true, name: true } })
    let refused = ''
    try {
      await db.$transaction((tx) =>
        assignCustody(
          tx,
          {
            assetId: subject.id,
            custodyType: 'TRUCK',
            targetId: truck.id,
            containerId: kit.id,
            note: null,
          },
          { orgId: org.id, userId: actor.id, name: actor.name },
        ),
      )
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check(
      'a kit at the prop cannot be filled from a truck',
      refused.includes('not in that area'),
      refused || 'accepted — a unit would read as permanently missing from that bag',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: subject.id } })
    await prismaUnscoped.notification.deleteMany({ where: { entityId: subject.id } })
    await prismaUnscoped.auditLog.deleteMany({ where: { entityId: subject.id } })
    await prismaUnscoped.asset.delete({ where: { id: subject.id } })
    console.log(`\n(removed ${subject.assetTag})`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll assignment checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
