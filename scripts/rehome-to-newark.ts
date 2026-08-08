/**
 * Home the six people who have no office at Newark.
 *
 * They were left unset when New Castle Warehouse — the warehouse they were all
 * homed at — turned out to be test data. Newark is a starting point, not a
 * judgement about where anybody sits: each of them can change it themselves
 * from Settings → Your profile, which is the point of that page existing.
 *
 * Driven through the roster screen rather than by writing to the column, so
 * every one of them gets the same audit row a manual set would write — who
 * moved whom, and when. A cleanup that skips the trail leaves six changes
 * nobody can account for later.
 *
 *   npx tsx scripts/rehome-to-newark.ts [--dry-run]
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listHomeOffices } from '../src/server/actions/settings'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const OFFICE = 'Newark Office'
const dryRun = process.argv.includes('--dry-run')

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const offices = await listHomeOffices(db)
  const newark = offices.find((row) => row.name === OFFICE)
  if (!newark) {
    console.log(`${OFFICE} is not an office the picker offers: ${offices.map((o) => o.name).join(', ')}`)
    return
  }

  const NAMES = [
    'Pat Nguyen',
    'Dave Reyes',
    'Grant Unterreiner',
    'Tim Hopkins',
    'Sam Okafor',
    'Ray B.',
  ]

  const unset = await prismaUnscoped.membership.findMany({
    where: { orgId: org.id, active: true, user: { name: { in: NAMES } } },
    include: { user: { select: { id: true, name: true } }, homeLocation: { select: { name: true } } },
    orderBy: { user: { name: 'asc' } },
  })

  console.log(`${unset.length} of ${NAMES.length} named people found:`)
  for (const row of unset) {
    console.log(`  ${row.user.name.padEnd(20)} ${row.homeLocation?.name ?? 'no home office'}`)
  }
  if (unset.length === 0) return
  if (dryRun) {
    console.log(`\n(dry run — would set each to ${OFFICE})`)
    return
  }

  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'ray@teksolv.com')
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])

  for (const row of unset) {
    await page.goto(`${BASE}/settings/users`, { waitUntil: 'networkidle' })
    await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    // Scoped to the one row, and checked: a roster is a list of near-identical
    // rows, and a locator that drifts one along moves the wrong person.
    const rosterRow = page.locator('div.border-b').filter({ hasText: row.user.name }).first()
    const picker = rosterRow.getByLabel('Home office')

    // Selecting the value it already has fires no change event, so somebody
    // already at Newark would get no audit row. A detour through another office
    // and back leaves the same trail a person clicking twice would leave.
    if ((await picker.inputValue()) === newark.id) {
      const detour = offices.find((office) => office.id !== newark.id)
      if (detour) {
        await picker.selectOption(detour.id)
        await page.waitForTimeout(2_000)
      }
    }
    await picker.selectOption(newark.id)
    await page.waitForTimeout(2_500)

    const now = await prismaUnscoped.membership.findFirstOrThrow({
      where: { userId: row.user.id },
      select: { homeLocationId: true },
    })
    console.log(`  ${row.user.name.padEnd(20)} ${now.homeLocationId === newark.id ? OFFICE : 'FAILED'}`)
  }

  await browser.close()

  const left = await prismaUnscoped.membership.count({
    where: { orgId: org.id, active: true, homeLocationId: null },
  })
  console.log(`\n${left} still unset`)
}

main().finally(() => prismaUnscoped.$disconnect())
