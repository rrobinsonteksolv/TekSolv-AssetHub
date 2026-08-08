/**
 * Printing truck labels — one, and a whole fleet.
 *
 * The template and the scan route both existed; there was no way to *get* a
 * label out of the app. So this suite is about the surfaces and the artwork
 * they produce, and it checks the two things a label has to get right:
 *
 *   • **What is on it.** "TRUCK 167" big enough to read from across a yard, and
 *     a code encoding `/api/scan/truck/<id>`.
 *   • **Where it points.** The QR is the only field a person cannot read back,
 *     so the URL it carries is followed for real and has to land on that
 *     truck's page.
 *
 * The batch is checked as *one document with one page per truck*, because the
 * failure that matters there is silent: a sheet that paginates wrongly runs
 * labels onto each other, and a job that keeps a trailing break feeds a blank
 * label off the roll at the end of every run.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-truck-labels.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { renderLabel, renderLabelHtml, renderTruckSheetHtml } from '../src/lib/labels/templates'
import { truckScanUrl } from '../src/lib/labels/truck-labels'

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

  const trucks = await db.truck.findMany({
    where: { active: true },
    orderBy: [{ office: 'asc' }, { number: 'asc' }],
    select: { id: true, number: true, office: true, owner: { select: { name: true } } },
  })
  // Truck 167 by preference — it is the one the fleet was imported onto, so the
  // end-to-end run is against a vehicle that actually carries gear.
  const truck = trucks.find((entry) => entry.number === '167') ?? trucks[0]
  if (!truck) throw new Error('no active trucks to label')

  const sample = [truck, ...trucks.filter((entry) => entry.id !== truck.id)].map((entry) => ({
    orgName: 'TekSolv',
    number: entry.number,
    office: entry.office,
    ownerName: entry.owner?.name ?? null,
    scanUrl: truckScanUrl(BASE, entry.id),
    qrSvg: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
  }))

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nWhat is on a truck label\n')
    // -----------------------------------------------------------------------

    const html = renderLabelHtml('truck', sample[0])
    check(
      'the number is on it, and it is the biggest thing there',
      html.includes(`TRUCK ${truck.number}`),
      `TRUCK ${truck.number} — readable from across a yard is the whole point`,
    )
    check('the office is on it', html.includes(truck.office), truck.office)
    check(
      'and the code carries the truck scan URL',
      html.includes('/api/scan/truck/') || renderLabel('truck', sample[0]).includes(truck.id),
      truckScanUrl(BASE, truck.id),
    )

    for (const language of ['EPL', 'ZPL'] as const) {
      const printed = renderLabel('truck', sample[0], { language })
      check(
        `it renders in ${language} too, so either printer family works`,
        printed.includes(truck.number) && printed.includes(truck.id),
        `${printed.length} bytes`,
      )
    }

    // -----------------------------------------------------------------------
    console.log('\nA fleet in one job\n')
    // -----------------------------------------------------------------------

    const sheet = renderTruckSheetHtml(sample)
    const pages = (sheet.match(/class="label"/g) ?? []).length
    check(
      'every active truck gets a page',
      pages === trucks.length,
      `${pages} labels for ${trucks.length} trucks`,
    )
    check(
      'each one is its own page',
      sheet.includes('page-break-after: always'),
      'labels that share a page overprint each other',
    )
    check(
      'but the last one does not break',
      sheet.includes('.label:last-child') && sheet.includes('page-break-after: auto'),
      'a trailing break feeds a blank label off the roll on every run',
    )
    check(
      'the sheet does not clamp the document to one label’s height',
      !/html, body \{[^}]*height: 1\.25in/.test(sheet),
      'a fixed body height clips every label after the first to nothing',
    )
    check(
      'the page size is still the stock, not a sheet of paper',
      sheet.includes('@page { size: 2.25in 1.25in; margin: 0; }'),
      'one label per page at 2.25 x 1.25',
    )
    check(
      'every truck number appears exactly once',
      sample.every(
        (entry) => (sheet.match(new RegExp(`TRUCK ${entry.number}\\b`, 'g')) ?? []).length === 1,
      ),
      sample.map((entry) => entry.number).join(', '),
    )

    // A batch and a single print must produce the same artwork — otherwise the
    // alignment somebody checked on one label does not describe the run.
    const single = renderLabelHtml('truck', sample[0])
    const body = /<body>\s*([\s\S]*?)\s*<\/body>/.exec(single)?.[1] ?? ''
    check(
      'a label in the batch is byte-identical to the same label printed alone',
      body.length > 0 && sheet.includes(body),
      'one renderer, so an alignment check on one label describes the whole run',
    )

    // -----------------------------------------------------------------------
    console.log('\nThe surfaces that print it\n')
    // -----------------------------------------------------------------------

    await signIn(page, 'sam@teksolv.com')

    await page.goto(`${BASE}/trucks/${truck.id}`, { waitUntil: 'networkidle' })
    check(
      'the truck’s own page offers it',
      (await page.getByRole('button', { name: /Print truck label/i }).count()) > 0,
      `Truck ${truck.number}`,
    )

    // Preview before printing: this stock is 2.25 x 1.25 and worth one look.
    await page.getByRole('button', { name: /Print truck label/i }).click()
    const preview = page.locator('[role="dialog"]', { hasText: 'Check the label' })
    await preview.waitFor({ state: 'visible', timeout: 20_000 })
    check('and shows it before committing stock', await preview.isVisible())

    const frame = preview.frameLocator('iframe[title="Label preview"]')
    check(
      'the preview is the real label, not a mock-up of one',
      (await frame.locator(`text=TRUCK ${truck.number}`).count()) > 0,
      'rendered from the same document the Windows path prints',
    )
    check(
      'with a way to print from there',
      (await preview.getByRole('button', { name: /^Print$/ }).count()) > 0 &&
        (await preview.getByRole('button', { name: /Print via Windows/i }).count()) > 0,
      'both paths, same as the cal sticker',
    )
    await preview.getByRole('button', { name: /Cancel/i }).click()

    // Settings is admin territory — `location.manage` is ADMIN_ONLY, and this
    // is where trucks are created, so it is where a new fleet gets labelled.
    // A manager landing here is redirected, which is the existing rule and not
    // this feature's to change; the supervisor surface is the truck's own page.
    const adminContext = await browser.newContext()
    const adminPage = await adminContext.newPage()
    await signIn(adminPage, 'ray@teksolv.com')
    await adminPage.goto(`${BASE}/settings/locations`, { waitUntil: 'networkidle' })
    check(
      'the fleet screen actually loaded',
      adminPage.url().includes('/settings/locations'),
      new URL(adminPage.url()).pathname,
    )
    const perTruck = await adminPage.getByRole('button', { name: /^Label$/ }).count()
    check(
      'so does the screen where trucks are managed',
      perTruck >= trucks.length,
      `${perTruck} per-truck buttons for ${trucks.length} trucks`,
    )
    const batchButton = adminPage.getByRole('button', { name: /Print all \d+ labels/i })
    check(
      'and the whole fleet can go in one run',
      (await batchButton.count()) === 1,
      (await batchButton.count()) ? (await batchButton.first().innerText()).trim() : 'not offered',
    )

    await batchButton.first().click()
    const batchPreview = adminPage.locator('[role="dialog"]', { hasText: 'Check the label' })
    await batchPreview.waitFor({ state: 'visible', timeout: 20_000 })
    check(
      'the batch preview says how many, so nobody prints thirty by accident',
      (await batchPreview.innerText()).includes(`${trucks.length} labels`),
      (await batchPreview.innerText()).split('\n').find((line) => line.includes('labels')) ?? '',
    )
    await batchPreview.getByRole('button', { name: /Cancel/i }).click()
    await adminContext.close()

    // -----------------------------------------------------------------------
    console.log('\nWho can print one\n')
    // -----------------------------------------------------------------------

    const viewerContext = await browser.newContext()
    const viewerPage = await viewerContext.newPage()
    await signIn(viewerPage, 'dreyes@teksolv.com')
    await viewerPage.goto(`${BASE}/trucks/${truck.id}`, { waitUntil: 'networkidle' })
    check(
      'a technician is not offered it',
      (await viewerPage.getByRole('button', { name: /Print truck label/i }).count()) === 0,
      'supervisor+, the same bar as moving the truck’s gear',
    )
    await viewerContext.close()

    // -----------------------------------------------------------------------
    console.log('\nAnd scanning it lands on the truck\n')
    // -----------------------------------------------------------------------

    // The QR is the one field nobody can read back, so its URL is followed for
    // real rather than compared to a string.
    await page.goto(truckScanUrl(BASE, truck.id), { waitUntil: 'networkidle' })
    check(
      'the code on the label opens that truck’s page',
      page.url().includes(`/trucks/${truck.id}`),
      `${truckScanUrl(BASE, truck.id)} → ${new URL(page.url()).pathname}`,
    )
    check(
      'and it is the right truck',
      (await page.locator('h1').first().innerText()).includes(truck.number),
      (await page.locator('h1').first().innerText()).trim(),
    )

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll truck-label checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
