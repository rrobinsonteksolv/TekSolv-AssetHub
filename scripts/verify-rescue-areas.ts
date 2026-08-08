/**
 * Rescue areas are not offices.
 *
 * The Rescue Prop and the Ops Manager Office were both typed OFFICE — the label
 * that existed, not the one that fits. It put them in the settings list beside
 * Newark and Oakdale, which are buildings with a street address and nobody's
 * rope in them, and it offered a place holding fifty-one items an "address"
 * field it will never use.
 *
 * This is a **reclassification**, and the thing most worth testing about a
 * reclassification is that it moved nothing: the same ids, the same custody
 * rows, the same kits, the same retired and quarantined units. A migration that
 * quietly re-created a location would leave the gear behind on the old one and
 * read as a successful rename right up until somebody went looking for it.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-rescue-areas.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getArea, isRescueArea, listAreas } from '../src/lib/areas'
import { listLocationsAndTrucks } from '../src/lib/settings'
import { listContainerDestinations } from '../src/lib/containers'
import { getUtilization, yearWindow } from '../src/lib/utilization'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const OFFICE = 'Ops Manager Office'
const PROP = 'Rescue Prop'
/** Buildings. These keep the OFFICE type, and one of them prints on CAL-01s. */
const REAL_OFFICES = ['Collinsville Office', 'Newark Office', 'Oakdale Office']

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

  // -------------------------------------------------------------------------
  console.log('\nThe type moved; nothing else did\n')
  // -------------------------------------------------------------------------

  const office = await db.location.findFirstOrThrow({ where: { name: OFFICE } })
  const prop = await db.location.findFirstOrThrow({ where: { name: PROP } })

  check('the office is a rescue area', office.type === 'RESCUE_AREA', office.type)
  check('so is the Rescue Prop — the two are the same kind of place', prop.type === 'RESCUE_AREA', prop.type)
  check(
    'and exactly one location carries each name',
    (await db.location.count({ where: { name: OFFICE } })) === 1 &&
      (await db.location.count({ where: { name: PROP } })) === 1,
    'a migration that re-created the row would leave the gear on the old one',
  )

  const officeArea = await getArea(db, 'LOCATION', office.id)
  check(
    'the office still holds its 41, with the retired one filed apart',
    officeArea!.held === 41 && officeArea!.retired.length === 1,
    `${officeArea!.held} held · ${officeArea!.retired.length} retired · 42 in total, as imported`,
  )
  check(
    'including the two on hold',
    officeArea!.loose.filter((item) => item.status === 'QUARANTINED').length === 2,
    'a hold is not a reason to lose track of something',
  )

  const propArea = await getArea(db, 'LOCATION', prop.id)
  check(
    'and the prop still holds 51 across its four kits',
    propArea!.held === 51 && propArea!.kits.length === 4,
    propArea!.kits.map((kit) => `${kit.name} ${kit.items.length}`).join(' · '),
  )

  check(
    'every unit at either one is still attached to it',
    (await db.asset.count({
      where: { custodyType: 'LOCATION', custodyLocationId: { in: [office.id, prop.id] } },
    })) === 92,
    '41 + 51 — custody rows were never touched',
  )

  // -------------------------------------------------------------------------
  console.log('\nIt behaves like the other rescue areas\n')
  // -------------------------------------------------------------------------

  const areas = await listAreas(db)
  const rescue = areas.filter((area) => area.rescue)
  check(
    'it is a rescue area alongside the prop and the trucks',
    rescue.some((area) => area.id === office.id) &&
      rescue.some((area) => area.id === prop.id) &&
      rescue.some((area) => area.kind === 'TRUCK'),
    `${rescue.length} rescue areas · ${rescue.filter((a) => a.kind === 'TRUCK').length} of them trucks`,
  )
  check(
    'a warehouse or jobsite is not one',
    areas.filter((area) => !area.rescue).every((area) => area.kind === 'LOCATION'),
    areas.filter((area) => !area.rescue).map((area) => area.name).join(', '),
  )
  check('and it reads as one, in words', isRescueArea(office.type))

  check(
    'a kit can be moved into it, the same as any other area',
    (await listContainerDestinations(db)).locations.some((row) => row.id === office.id),
    'the destination list is every active area, and reclassifying did not drop it',
  )

  // -------------------------------------------------------------------------
  console.log('\nRESCUE class, and out of the rental numbers\n')
  // -------------------------------------------------------------------------

  const byClass = await db.asset.groupBy({
    by: ['assetType'],
    where: { OR: [{ custodyLocationId: office.id }, { locationId: office.id }] },
    _count: true,
  })
  check(
    'everything it holds classifies RESCUE',
    byClass.length === 1 && byClass[0].assetType === 'RESCUE' && byClass[0]._count === 42,
    JSON.stringify(byClass),
  )

  const report = await getUtilization(db, yearWindow(2026).range)
  const inReport = report.categories
    .flatMap((category) => category.units)
    .filter((unit) => unit.assetTag.startsWith('OPS-'))
  check(
    'so none of it reaches the utilization report',
    inReport.length === 0,
    'utilization is the rental fleet; the area did not have to be special-cased to stay out of it',
  )
  // Proved rather than asserted: if the *area* decided class, a truck holding
  // rental meters would have none of them in the report.
  const truckRental = await db.asset.count({
    where: { custodyType: 'TRUCK', assetType: 'RENTAL' },
  })
  const truckUnitsInReport = report.categories
    .flatMap((category) => category.units)
    .filter((unit) => unit.custodyType === 'TRUCK').length
  check(
    'while gear on a truck — also a rescue area — still counts when its category is RENTAL',
    truckRental > 0 && truckUnitsInReport > 0,
    `${truckUnitsInReport} of ${truckRental} rental units staged on trucks are in the report — class follows the category, never the area`,
  )

  // -------------------------------------------------------------------------
  console.log('\nGone from settings, where it never belonged\n')
  // -------------------------------------------------------------------------

  const { locations } = await listLocationsAndTrucks(db)
  check(
    'the sites list no longer carries it',
    !locations.some((row) => row.id === office.id) && !locations.some((row) => row.id === prop.id),
    locations.map((row) => row.name).join(', '),
  )
  check(
    'while the real offices stay — they are buildings',
    REAL_OFFICES.every((name) => locations.some((row) => row.name === name)),
    'Newark prints on CAL-01 certificates as where a calibration was performed, so OFFICE keeps its meaning',
  )

  // -------------------------------------------------------------------------
  console.log('\nOn the screens\n')
  // -------------------------------------------------------------------------

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')

    await page.goto(`${BASE}/areas`, { waitUntil: 'networkidle' })
    const areasText = await settle(page)
    check('Areas has a rescue section', areasText.includes('rescue areas'))
    check('with the office in it', areasText.includes(OFFICE.toLowerCase()))
    check('and the prop', areasText.includes(PROP.toLowerCase()))
    check(
      'listed above the warehouses and jobsites',
      areasText.indexOf('rescue areas') < areasText.indexOf('warehouses, yards and sites'),
      'the places gear actually lives lead',
    )
    check(
      'and the trucks are on the same page as both',
      /truck \d+/.test(areasText),
      'one list, because "where is our gear" is one question',
    )

    await page.goto(`${BASE}/areas/${office.id}`, { waitUntil: 'networkidle' })
    const officeText = await settle(page)
    check('it has its own browsable page', officeText.includes(OFFICE.toLowerCase()))
    check('calling itself a rescue area, not an office', officeText.includes('rescue area'))
    check('with its 41 items on it', officeText.includes('41 items here'), officeText.split('\n').slice(0, 6).join(' / '))
    check('and the retired one shown apart', officeText.includes('retired here'))

    await page.goto(`${BASE}/settings/locations`, { waitUntil: 'networkidle' })
    await settle(page)

    // Scoped to the Sites panel, not the whole page: the page *explains* that
    // rescue areas live under Areas, and naming them in that sentence is the
    // point of it. What must not happen is one appearing as a row in the list.
    const sitesPanel = page
      .locator('div.rounded-card')
      .filter({ has: page.getByRole('heading', { name: /^Sites \(/ }) })
      .first()
    const sitesText = (await sitesPanel.innerText()).toLowerCase()
    check(
      'the sites list has no row for either rescue area',
      !sitesText.includes(OFFICE.toLowerCase()) && !sitesText.includes(PROP.toLowerCase()),
      'a rescue area has no street address and never wanted one',
    )
    check(
      'but still lists the real offices',
      REAL_OFFICES.every((name) => sitesText.includes(name.toLowerCase())),
      sitesText
        .split('\n')
        .filter((line) => /office|warehouse|yard|jobsite/.test(line))
        .slice(0, 4)
        .join(' / '),
    )

    await page.getByRole('button', { name: /New location/i }).click()
    const typeOptions = await page.locator('select[name="type"] option').allInnerTexts()
    check(
      'and the new-site form does not offer RESCUE_AREA as a type',
      !typeOptions.some((option) => /rescue/i.test(option)),
      `${typeOptions.join(', ')} — a rescue area comes from an import naming a holder, not from an address form`,
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll rescue-area checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
