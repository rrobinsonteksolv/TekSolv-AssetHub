/**
 * Screenshot the Supplies page, at whatever scale the database is currently in.
 *
 *   npx tsx scripts/shoot-supplies.ts before-5
 *   npx tsx scripts/shoot-supplies.ts after-50
 */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const OUT = 'docs/supplies-redesign'
const label = process.argv[2] ?? 'shot'

async function main() {
  mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'ray@teksolv.com')
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])

  await page.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1_200)

  const count = await prismaUnscoped.consumable.count()
  await page.screenshot({ path: `${OUT}/${label}-viewport.png` })
  await page.screenshot({ path: `${OUT}/${label}-full.png`, fullPage: true })

  const height = await page.evaluate(() => document.body.scrollHeight)
  console.log(`${label}: ${count} supply items · page ${height}px tall`)
  console.log(`  ${OUT}/${label}-viewport.png`)
  console.log(`  ${OUT}/${label}-full.png`)

  await browser.close()
  await prismaUnscoped.$disconnect()
}

main()
