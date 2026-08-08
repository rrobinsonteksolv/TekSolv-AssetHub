/** Screenshot the rentals board. */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const OUT = 'docs/rentals-orders'
const label = process.argv[2] ?? 'shot'

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'ray@teksolv.com')
  await page.fill('input[name="password"]', process.env.SEED_PASSWORD ?? 'assethub-dev')
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
  await page.goto(`${BASE}/rentals`, { waitUntil: 'networkidle' })
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${OUT}/${label}.png` })
  await page.screenshot({ path: `${OUT}/${label}-full.png`, fullPage: true })
  console.log(`  ${OUT}/${label}.png`)
  await browser.close()
}
main()
