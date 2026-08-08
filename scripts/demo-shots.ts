/**
 * Screenshot the demo path, so a visual change can be reviewed rather than
 * described.
 *
 *   npx tsx scripts/demo-shots.ts before
 *   npx tsx scripts/demo-shots.ts after
 *
 * Same viewport, same route order, same theme every run — a before/after pair
 * is only worth looking at if the only difference in it is the change.
 *
 * Needs the dev server running:  npm run dev
 */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const OUT = path.join(process.cwd(), 'docs', 'shots')

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
  const label = process.argv[2] ?? 'shot'
  const dir = path.join(OUT, label)
  mkdirSync(dir, { recursive: true })

  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })

  // A unit with both an inspection and a calibration on it, so the detail
  // drawer in the shot is the one the demo actually opens.
  const asset =
    (await prismaUnscoped.asset.findFirst({
      where: {
        orgId: org.id,
        inspections: { some: {} },
        maintenanceRecords: { some: { type: 'CALIBRATION' } },
      },
      select: { id: true, assetTag: true },
    })) ??
    (await prismaUnscoped.asset.findFirstOrThrow({
      where: { orgId: org.id, inspections: { some: {} } },
      select: { id: true, assetTag: true },
    }))

  const truck = await prismaUnscoped.truck.findFirstOrThrow({
    where: { orgId: org.id, number: '167' },
    select: { id: true },
  })

  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  })
  const page = await context.newPage()

  // The industrial dark base is the demo's look, and next-themes defaults to
  // light — so it is set explicitly rather than left to whatever the last run
  // of some other script happened to leave in storage.
  await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))

  const shots: [string, string][] = [
    ['01-login', `${BASE}/login`],
    ['02-dashboard', `${BASE}/dashboard`],
    ['03-asset-overview', `${BASE}/inventory/${asset.id}`],
    ['04-asset-inspections', `${BASE}/inventory/${asset.id}?tab=inspections`],
    ['05-asset-maintenance', `${BASE}/inventory/${asset.id}?tab=maintenance`],
    ['06-truck-167', `${BASE}/trucks/${truck.id}`],
    ['07-utilization', `${BASE}/reports/utilization`],
    ['08-idle-capital', `${BASE}/reports/utilization?view=idle&sort=idle`],
    // The printed documents are part of the demo: an owner is handed one.
    ['09-fp01-blank', `${BASE}/inspections/forms/fp-01`],
  ]

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.screenshot({ path: path.join(dir, '01-login.png') })
  await signIn(page, 'ray@teksolv.com')

  for (const [name, url] of shots.slice(1)) {
    await page.goto(url, { waitUntil: 'networkidle' })
    // Let any transition settle, so a hover/fade is not caught halfway.
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(dir, `${name}.png`) })
    console.log(`  ${name}`)
  }

  await browser.close()
  await prismaUnscoped.$disconnect()
  console.log(`\nWrote ${shots.length} shots to docs/shots/${label}/`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
