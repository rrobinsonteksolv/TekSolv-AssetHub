/**
 * Which controls are still too small for a thumb, and where.
 *
 * Reports the *interactive* ones only. A link inside a sentence is text that
 * happens to be clickable and is not held to 44px — chasing those produces a
 * page of double-spaced prose. What matters is the things people aim at:
 * buttons, selects, inputs, filter chips, pagination, tabs.
 *
 *   npx tsx scripts/audit-touch.ts 390
 */
import 'dotenv/config'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const width = Number(process.argv[2] ?? 390)

const PATHS: [string, string][] = [
  ['dashboard', '/dashboard'],
  ['inventory', '/inventory'],
  ['rentals', '/rentals'],
  ['supplies', '/supplies'],
  ['areas', '/areas'],
  ['kits', '/containers'],
  ['maintenance', '/maintenance'],
  ['inspections', '/inspections'],
  ['grab', '/grab'],
  ['checkout', '/rentals/checkout'],
  ['scan', '/scan'],
]

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width, height: 844 },
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

  const tally = new Map<string, { count: number; height: number; sample: string }>()

  for (const [name, path] of PATHS) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(400)

    const small = await page.evaluate(() => {
      const out: { sig: string; height: number; text: string }[] = []
      const nodes = document.querySelectorAll<HTMLElement>(
        'main button, main select, main input, main a[href], main [role="button"]',
      )
      for (const node of Array.from(nodes)) {
        const rect = node.getBoundingClientRect()
        if (rect.height === 0) continue
        if (rect.height >= 44) continue
        // Inline text links — an anchor whose parent is a paragraph or a
        // sentence — are prose, not controls.
        const inlineProse =
          node.tagName === 'A' &&
          !!node.parentElement &&
          ['P', 'SPAN', 'DD', 'LI'].includes(node.parentElement.tagName) &&
          (node.parentElement.textContent ?? '').length > (node.textContent ?? '').length + 12
        if (inlineProse) continue
        if (node.getAttribute('type') === 'hidden') continue
        // A checkbox inside a label is hit by tapping the label — that is what
        // a wrapped label does — so the label's height is the real target.
        // Growing the box itself to 44px would look like a rendering bug.
        const type = node.getAttribute('type')
        if (type === 'checkbox' || type === 'radio') {
          const label = node.closest('label')
          if (label && label.getBoundingClientRect().height >= 44) continue
        }
        const cls = String(node.className || '').split(' ').slice(0, 3).join('.')
        out.push({
          sig: `${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`,
          height: Math.round(rect.height),
          text: (node.textContent ?? '').trim().slice(0, 28),
        })
      }
      return out
    })

    for (const entry of small) {
      const key = `${name} · ${entry.sig}`
      const existing = tally.get(key)
      if (existing) existing.count++
      else tally.set(key, { count: 1, height: entry.height, sample: entry.text })
    }

    console.log(`${name.padEnd(13)} ${small.length} under 44px`)
  }

  console.log('\nBiggest offenders:')
  const ranked = [...tally.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 22)
  for (const [key, value] of ranked) {
    console.log(`  ${String(value.count).padStart(3)}×  ${String(value.height).padStart(2)}px  ${key}  "${value.sample}"`)
  }

  await browser.close()
}

main()
