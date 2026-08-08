/** Screenshot the detail drawer and a filtered view. */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const OUT = 'docs/supplies-redesign'

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

  // A lot-tracked item with several offices, so the drawer shows both tables.
  await page.getByRole('cell', { name: /Quad gas 34L/ }).first().click()
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/after-detail.png` })
  console.log(`  ${OUT}/after-detail.png`)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // Filtered: only what needs ordering, sorted worst-first, ungrouped.
  await page.getByRole('button', { name: /At reorder/ }).click()
  await page.getByLabel('Group by category').uncheck()
  await page.getByRole('button', { name: /^On hand/ }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/after-filtered.png` })
  console.log(`  ${OUT}/after-filtered.png`)

  await browser.close()
}

main()
