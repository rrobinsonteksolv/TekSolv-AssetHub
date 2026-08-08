/**
 * The category tree, and the report that groups by it.
 *
 * The symptom was nonsense groupings in utilization. The cause was **two
 * taxonomies coexisting**: some categories properly nested (`Confined Space` →
 * `Ventilation`) and others flat rows whose *name* contained the separator
 * (`Fall Protection > Harnesses`, with no parent at all). A report that groups
 * by category then shows the same family as two unrelated buckets, and "Fall
 * Protection" appears not to contain its own children — because it did not.
 *
 * What is asserted here is the shape, not one screen: that Fall Protection
 * really contains Harnesses and Lifelines as children, that Confined Space
 * holds the entry gear, that a harness category holds only harnesses, and that
 * nothing in the Fall Protection family is still a flat row pretending to be
 * nested.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-taxonomy.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { classifyAssetType } from '../src/lib/validators/assets'
import { getUtilization, yearWindow } from '../src/lib/utilization'

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

  const cats = await db.category.findMany({
    include: { parent: { select: { name: true } }, _count: { select: { assets: true } } },
  })
  const byName = (name: string) => cats.find((row) => row.name === name)
  const childrenOf = (name: string) => {
    const parent = byName(name)
    return parent ? cats.filter((row) => row.parentId === parent.id) : []
  }

  // ---------------------------------------------------------------------------
  console.log('\nFall Protection contains its own children\n')
  // ---------------------------------------------------------------------------

  const fpChildren = childrenOf('Fall Protection').map((row) => row.name).sort()
  check(
    'Harnesses is a child of Fall Protection, not a name with a “>” in it',
    fpChildren.includes('Harnesses'),
    fpChildren.join(', '),
  )
  check('and Lifelines is too', fpChildren.includes('Lifelines'))
  check(
    'along with the rest of the family',
    ['Anchors', 'Lanyards', 'SRL/PFL'].every((name) => fpChildren.includes(name)),
    fpChildren.join(', '),
  )
  check(
    'and none of them is left as a flat row',
    cats.filter((row) => row.name.startsWith('Fall Protection > ')).length === 0,
    'a flat “Parent > Child” name groups separately from the parent it names',
  )

  // ---------------------------------------------------------------------------
  console.log('\nHarnesses holds only harnesses\n')
  // ---------------------------------------------------------------------------

  const harnesses = childrenOf('Fall Protection').find((row) => row.name === 'Harnesses')
  const inside = harnesses
    ? await db.asset.findMany({
        where: { categoryId: harnesses.id },
        select: { assetTag: true, model: true },
      })
    : []
  const notHarnesses = inside.filter((asset) => !/harness/i.test(asset.model ?? ''))
  check(
    `all ${inside.length} of them are harnesses`,
    notHarnesses.length === 0,
    notHarnesses.length
      ? notHarnesses.map((asset) => `${asset.assetTag} ${asset.model}`).join(' · ')
      : 'no meters, blowers, lifelines or tripods among them',
  )
  check(
    'and no gas monitor is filed as fall protection',
    !inside.some((asset) => /monitor/i.test(asset.model ?? '')),
    'a meter is not fall protection',
  )

  // ---------------------------------------------------------------------------
  console.log('\nConfined Space holds the entry gear\n')
  // ---------------------------------------------------------------------------

  const confined = byName('Confined Space')
  const confinedAssets = confined
    ? await db.asset.findMany({
        where: { categoryId: confined.id },
        select: { model: true },
      })
    : []
  check(
    'the tripods and winches are in it',
    confinedAssets.some((asset) => /tripod/i.test(asset.model ?? '')),
    `${confinedAssets.length} directly in Confined Space`,
  )
  check(
    'and the davit hoist',
    confinedAssets.some((asset) => /davit/i.test(asset.model ?? '')),
  )
  check(
    'with no “Access” leaf left holding them instead',
    byName('Access') === undefined,
    'Confined Space was already Access’s parent, so the rename is a merge upward',
  )
  check(
    'and Ventilation still nested under it, holding the blowers',
    childrenOf('Confined Space').some((row) => row.name === 'Ventilation'),
    childrenOf('Confined Space').map((row) => row.name).join(', '),
  )

  // ---------------------------------------------------------------------------
  console.log('\nClass follows the corrected path\n')
  // ---------------------------------------------------------------------------

  check(
    'a monitor’s new path classifies RENTAL',
    classifyAssetType('Gas Detection > Portable Monitors') === 'RENTAL',
    'which is the point of re-running classification after a move',
  )
  check(
    'a blower’s does too',
    classifyAssetType('Confined Space > Ventilation') === 'RENTAL',
  )
  check(
    'while a harness stays RESCUE',
    classifyAssetType('Fall Protection > Harnesses') === 'RESCUE',
    'the allow-list defaults to RESCUE on purpose',
  )
  check(
    'and no RENTAL unit sits in a harness category',
    (await db.asset.count({
      where: { categoryId: harnesses?.id ?? '', assetType: 'RENTAL' },
    })) === 0,
    'a rentable unit under Harnesses is what put nonsense in the report',
  )

  // ---------------------------------------------------------------------------
  console.log('\nThe report groups by the corrected tree\n')
  // ---------------------------------------------------------------------------

  const report = await getUtilization(db, yearWindow(new Date().getFullYear()).range)
  const names = report.categories.map((row) => row.categoryName)

  check(
    'no “Access” group',
    !names.some((name) => /(^|\W)Access(\W|$)/.test(name)),
    names.join(' · ').slice(0, 200),
  )
  check(
    'no Harnesses group in a rental report',
    !names.some((name) => /harness/i.test(name)),
    'harnesses are rescue gear — a harness group here meant something rentable was misfiled',
  )
  check(
    'every group names a category that exists',
    names.every((name) => cats.some((row) => row.name === name || `${row.parent?.name} > ${row.name}` === name)),
    names.slice(0, 6).join(' · '),
  )

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')
    await page.goto(`${BASE}/reports/utilization`, { waitUntil: 'networkidle' })
    await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    const text = (await page.locator('main').innerText()).toLowerCase()

    check('the report renders', text.includes('utilization'))
    check(
      'and shows no Harnesses or Access grouping',
      !text.includes('harnesses') && !/\baccess\b/.test(text),
      'the two groupings that read as nonsense',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll taxonomy checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
