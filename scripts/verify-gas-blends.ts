/**
 * Calibration gas is usually a blend.
 *
 * The item form offered one "Gas type" box beside one "Concentration" box,
 * which is true of a single-gas cylinder and of nothing else a shop actually
 * calibrates with. A 4-gas carries H2S, CO, O2 and LEL/CH4 together, each with
 * its own number *and its own unit* — PPM for the toxics, % by volume for
 * oxygen, % LEL for the combustible. One text box could hold that only by
 * having somebody type all four into it, which is a list pretending to be a
 * value, and it printed onto Form CAL-01 as whatever they happened to type.
 *
 * Two things are worth testing and one is easy to forget: that four components
 * survive the round trip, and that **one** component is still one row with no
 * extra friction. A feature built for the complicated case that makes the
 * simple case worse has not been finished.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-gas-blends.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listSupplies } from '../src/lib/supplies-queries'
import { listCalGasLots } from '../src/lib/calibration'
import {
  blendConcentrations,
  blendGases,
  blendSummary,
  concentrationLabel,
} from '../src/lib/gas'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const BLEND_NAME = 'GASTEST Quad blend 34L'
const SINGLE_NAME = 'GASTEST H2S only 34L'

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

/** Fill one row of the components field. */
async function fillGasRow(page: Page, index: number, gas: string, amount: string, unit: string) {
  await page.getByLabel(`Gas ${index}`, { exact: true }).fill(gas)
  await page.getByLabel(`Amount ${index}`, { exact: true }).fill(amount)
  await page.getByLabel(`Unit ${index}`, { exact: true }).selectOption(unit)
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // ---------------------------------------------------------------------------
  console.log('\nHow a blend is written down\n')
  // ---------------------------------------------------------------------------

  const quad = [
    { gas: 'H2S', amount: '25', unit: 'PPM' as const },
    { gas: 'CO', amount: '100', unit: 'PPM' as const },
    { gas: 'O2', amount: '18', unit: 'PERCENT_VOL' as const },
    { gas: 'LEL/CH4', amount: '50', unit: 'PERCENT_LEL' as const },
  ]

  check('PPM takes a space', concentrationLabel(quad[0]) === '25 PPM')
  check('percent by volume does not', concentrationLabel(quad[2]) === '18% vol')
  check('nor percent LEL', concentrationLabel(quad[3]) === '50% LEL')
  check(
    'the gases print in order',
    blendGases(quad) === 'H2S / CO / O2 / LEL/CH4',
    blendGases(quad),
  )
  check(
    'and the concentrations print in the same order',
    blendConcentrations(quad) === '25 PPM / 100 PPM / 18% vol / 50% LEL',
    blendConcentrations(quad),
  )
  check(
    'so the two columns line up as pairs',
    blendGases(quad).split(' / ').length === blendConcentrations(quad).split(' / ').length,
    'four names against four values — the only reason a reader can pair them',
  )
  check(
    'a single gas is the same helper with one entry',
    blendGases([quad[0]]) === 'H2S' && blendConcentrations([quad[0]]) === '25 PPM',
    'no separate path for the simple case',
  )

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')

    // -------------------------------------------------------------------------
    console.log('\nCreating a 4-gas blend through the form\n')
    // -------------------------------------------------------------------------

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByRole('button', { name: /Add an item/i }).click()
    await page.locator('input[name="name"]').fill(BLEND_NAME)
    await page.locator('input[name="unit"]').fill('cylinder')
    await page.locator('input[name="lotTracked"]').check()

    check(
      'the gas list appears once the item is lot-tracked',
      await page.getByLabel('Gas 1', { exact: true }).isVisible(),
      'and stays hidden on a box of gloves',
    )
    check(
      'starting as a single row, not an empty list',
      (await page.getByLabel(/^Gas \d+$/).count()) === 1,
      'a single-gas cylinder is two boxes and a dropdown, exactly as before',
    )

    await fillGasRow(page, 1, 'H2S', '25', 'PPM')
    for (const [index, component] of quad.slice(1).entries()) {
      await page.getByRole('button', { name: /^Add gas$/ }).click()
      await fillGasRow(page, index + 2, component.gas, component.amount, component.unit)
    }
    check('“Add gas” grows the list', (await page.getByLabel(/^Gas \d+$/).count()) === 4)

    const preview = await page.locator('[role="dialog"]').innerText()
    check(
      'and the form shows what will print before saving',
      preview.includes(blendConcentrations(quad)),
      blendConcentrations(quad),
    )

    await page.getByRole('button', { name: /^Add item$/ }).click()
    await page.waitForTimeout(3_500)

    const saved = await db.consumable.findFirstOrThrow({
      where: { name: BLEND_NAME },
      include: { gasComponents: { orderBy: { position: 'asc' } } },
    })
    check('all four components saved', saved.gasComponents.length === 4, `${saved.gasComponents.length}`)
    check(
      'in the order they were typed',
      saved.gasComponents.map((row) => row.gas).join(',') === 'H2S,CO,O2,LEL/CH4',
      saved.gasComponents.map((row) => row.gas).join(' / '),
    )
    check(
      'each keeping its own unit',
      saved.gasComponents.map((row) => row.unit).join(',') === 'PPM,PPM,PERCENT_VOL,PERCENT_LEL',
      saved.gasComponents.map((row) => `${row.gas} ${row.unit}`).join(' · '),
    )

    // -------------------------------------------------------------------------
    console.log('\nAnd a single-gas item, with no extra friction\n')
    // -------------------------------------------------------------------------

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByRole('button', { name: /Add an item/i }).click()
    await page.locator('input[name="name"]').fill(SINGLE_NAME)
    await page.locator('input[name="unit"]').fill('cylinder')
    await page.locator('input[name="lotTracked"]').check()
    await fillGasRow(page, 1, 'H2S', '25', 'PPM')
    await page.getByRole('button', { name: /^Add item$/ }).click()
    await page.waitForTimeout(3_500)

    const single = await db.consumable.findFirstOrThrow({
      where: { name: SINGLE_NAME },
      include: { gasComponents: true },
    })
    check(
      'one row in, one component out',
      single.gasComponents.length === 1 &&
        single.gasComponents[0].gas === 'H2S' &&
        single.gasComponents[0].unit === 'PPM',
      'no “add a blend” step to find, and nothing extra to fill in',
    )

    // -------------------------------------------------------------------------
    console.log('\nOn the item, and on the way to a certificate\n')
    // -------------------------------------------------------------------------

    const rows = await listSupplies(db, { includeRetired: true })
    const blendRow = rows.find((row) => row.name === BLEND_NAME)!
    check(
      'the supplies list carries every component',
      blendRow.gasComponents.length === 4,
      blendSummary(blendRow.gasComponents),
    )

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByLabel('Search supplies').fill('H2S')
    await page.waitForTimeout(500)
    const found = await page.locator('tbody tr td:first-child .font-medium').allInnerTexts()
    check(
      'searching a component finds the blend that contains it',
      found.some((text) => text.includes(BLEND_NAME)),
      `${found.length} hit(s) for "H2S" — not only the cylinder named after it`,
    )

    await page.getByRole('cell', { name: new RegExp(BLEND_NAME) }).first().click()
    const drawer = page.locator('[role="dialog"]')
    await drawer.waitFor({ state: 'visible', timeout: 10_000 })
    const drawerText = await drawer.innerText()
    check(
      'the item panel lists all four, each with its unit',
      quad.every((component) => drawerText.includes(concentrationLabel(component))),
      quad.map((component) => concentrationLabel(component)).join(' · '),
    )
    await page.keyboard.press('Escape')

    // A lot, so the calibration form has something to pick.
    const office = await db.location.findFirstOrThrow({
      where: { active: true, type: { in: ['OFFICE', 'WAREHOUSE'] } },
      select: { id: true },
    })
    await prismaUnscoped.consumableStock.create({
      data: { orgId: org.id, consumableId: saved.id, locationId: office.id, onHand: 4 },
    })
    await prismaUnscoped.consumableLot.create({
      data: {
        orgId: org.id,
        consumableId: saved.id,
        locationId: office.id,
        lotNumber: 'GASTEST-1',
        quantity: 4,
        expiresAt: new Date(Date.now() + 400 * 86_400_000),
        receivedAt: new Date(),
      },
    })

    const lots = await listCalGasLots(db)
    const pickable = lots.find((lot) => lot.lotNumber === 'GASTEST-1')!
    check(
      'the calibration lot picker carries the blend, not one gas',
      pickable.gasComponents.length === 4,
      blendSummary(pickable.gasComponents),
    )
    check(
      'so CAL-01 prefills every gas',
      blendGases(pickable.gasComponents) === 'H2S / CO / O2 / LEL/CH4',
      blendGases(pickable.gasComponents),
    )
    check(
      'and every concentration with its unit',
      blendConcentrations(pickable.gasComponents) === '25 PPM / 100 PPM / 18% vol / 50% LEL',
      blendConcentrations(pickable.gasComponents),
    )

    // -------------------------------------------------------------------------
    console.log('\nEditing a blend replaces the list\n')
    // -------------------------------------------------------------------------

    await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByLabel('Search supplies').fill(BLEND_NAME)
    await page.waitForTimeout(500)
    await page.getByRole('cell', { name: new RegExp(BLEND_NAME) }).first().click()
    await drawer.waitFor({ state: 'visible', timeout: 10_000 })
    await drawer.getByRole('button', { name: /^Edit item$/ }).click()
    await page.waitForTimeout(600)

    check(
      'the form opens with the four rows already in it',
      (await page.getByLabel(/^Gas \d+$/).count()) === 4,
      'editing a blend starts from the blend, not from a blank pair',
    )

    await page.getByRole('button', { name: 'Remove gas 4' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: /^Save item$/ }).click()
    await page.waitForTimeout(3_500)

    const edited = await db.consumable.findFirstOrThrow({
      where: { id: saved.id },
      include: { gasComponents: { orderBy: { position: 'asc' } } },
    })
    check(
      'removing a row removes that component and renumbers the rest',
      edited.gasComponents.length === 3 &&
        edited.gasComponents.map((row) => row.position).join(',') === '0,1,2',
      edited.gasComponents.map((row) => `${row.position}:${row.gas}`).join(' · '),
    )
    check(
      'and leaves the others exactly as they were',
      blendConcentrations(edited.gasComponents) === '25 PPM / 100 PPM / 18% vol',
      blendConcentrations(edited.gasComponents),
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    const ids = (
      await prismaUnscoped.consumable.findMany({
        where: { orgId: org.id, name: { startsWith: 'GASTEST' } },
        select: { id: true },
      })
    ).map((row) => row.id)
    await prismaUnscoped.gasComponent.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumableTxn.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumableLot.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumableStock.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumable.deleteMany({ where: { id: { in: ids } } })
    console.log(`\n(removed ${ids.length} test cylinder(s))`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll gas-blend checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
