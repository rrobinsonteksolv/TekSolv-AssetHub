/**
 * Photograph the demo path at phone width, and measure what overflows.
 *
 * The number that matters is `scrollWidth > clientWidth` on the document: any
 * page where that is true has a horizontal scrollbar on a phone, which is the
 * single most disqualifying thing a field tool can do.
 *
 *   npx tsx scripts/shoot-mobile.ts before 390
 */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const OUT = 'docs/mobile'
const label = process.argv[2] ?? 'shot'
const width = Number(process.argv[3] ?? 390)

const PATHS: [string, string][] = [
  ['dashboard', '/dashboard'],
  ['inventory', '/inventory'],
  ['rentals', '/rentals'],
  ['supplies', '/supplies'],
  ['areas', '/areas'],
  ['kits', '/containers'],
  ['maintenance', '/maintenance'],
  ['grab', '/grab'],
  ['checkout', '/rentals/checkout'],
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', 'ray@teksolv.com')
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])

  console.log(`at ${width}px:`)
  for (const [name, path] of PATHS) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(500)

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement
      // The widest element that sticks out past the viewport, so a fix has
      // something to aim at rather than "something overflows".
      let worst = { tag: '', width: 0 }
      for (const node of Array.from(document.querySelectorAll('main *'))) {
        const rect = node.getBoundingClientRect()
        if (rect.right > doc.clientWidth + 1 && rect.width > worst.width) {
          worst = {
            tag: `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}`,
            width: Math.round(rect.width),
          }
        }
      }
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        overflows: doc.scrollWidth > doc.clientWidth,
        worst,
        tapTargetsUnder44: Array.from(
          document.querySelectorAll('main button, main a, main select, main input'),
        ).filter((node) => {
          const rect = node.getBoundingClientRect()
          return rect.height > 0 && rect.height < 44
        }).length,
      }
    })

    console.log(
      `  ${name.padEnd(12)} ${metrics.overflows ? `OVERFLOWS ${metrics.scrollWidth}px` : 'fits'.padEnd(16)}` +
        `${metrics.worst.tag ? ` widest: ${metrics.worst.tag} @${metrics.worst.width}px` : ''}` +
        `  ·  ${metrics.tapTargetsUnder44} tap target(s) < 44px`,
    )
    await page.screenshot({ path: `${OUT}/${label}-${name}.png` })
  }

  await browser.close()
}

main()
