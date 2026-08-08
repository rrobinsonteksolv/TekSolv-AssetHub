/**
 * Remove New Castle Warehouse, whose supply stock was demo data.
 *
 * Driven through the app's own Settings screen rather than by writing SQL, so
 * the guard, the typed confirmation, the ledger adjustments and the audit row
 * all happen exactly as they would for anybody clicking the button. A cleanup
 * that takes a shortcut around the safety it is meant to demonstrate has proved
 * nothing.
 *
 *   npx tsx scripts/delete-new-castle.ts [--dry-run]
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { checkSiteDeletable } from '../src/lib/site-deletion'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const NAME = 'New Castle Warehouse'
const dryRun = process.argv.includes('--dry-run')

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const site = await db.location.findFirst({ where: { name: NAME }, select: { id: true } })
  if (!site) {
    console.log(`${NAME} is already gone.`)
    return
  }

  const check = await checkSiteDeletable(db, site.id)
  console.log(`${NAME}:`)
  for (const blocker of check.blockers) console.log(`  BLOCKS      ${blocker}`)
  for (const line of check.overridable) console.log(`  overridable ${line}`)
  console.log(
    `  → ${check.stockToClear} supply record(s) to adjust out · ${check.peopleToUnhome} home office(s) to clear`,
  )

  if (check.blockers.length > 0) {
    console.log('\nRefused: something real is attached. Nothing was changed.')
    return
  }
  if (dryRun) {
    console.log('\n(dry run — nothing changed)')
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

  await page.goto(`${BASE}/settings/locations`, { waitUntil: 'networkidle' })
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })

  const row = page.locator('div.border-b').filter({ hasText: NAME }).last()
  await row.getByRole('button', { name: 'Delete' }).click()
  await row.getByRole('button', { name: 'Delete' }).click()
  await page.waitForTimeout(2_500)

  const refusal = await page.locator('main').innerText()
  console.log(
    `\n  first attempt refused: ${/type its name to confirm/.test(refusal) ? 'yes, asked for the name' : 'NO — the guard did not resist'}`,
  )

  await row.getByRole('textbox', { name: new RegExp(`Confirm deleting ${NAME}`) }).fill(NAME)
  await row.getByRole('button', { name: 'Delete' }).click()
  await page.waitForTimeout(4_000)

  await browser.close()

  const left = await prismaUnscoped.location.count({ where: { orgId: org.id, name: NAME } })
  console.log(`  ${left === 0 ? 'deleted' : 'STILL THERE'}`)
}

main().finally(() => prismaUnscoped.$disconnect())
