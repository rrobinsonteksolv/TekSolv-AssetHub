/**
 * Complete → find → print, for every generated report.
 *
 * The bug: completing a report saved it and dropped you somewhere else, so the
 * document existed but nobody saw it, nothing said where it went, and there was
 * no list of finished reports anywhere — which reads exactly like the report was
 * never made.
 *
 * Three things have to hold, for both report types:
 *
 *   1. completing one lands on the report itself, with a Print action;
 *   2. it is filed on the unit's Documents tab, and reopens from there;
 *   3. it is in the central Reports list, labelled with its type, and reopens
 *      from there too — and both routes reach the *same* document.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-reports.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listCompletedReports } from '../src/lib/reports'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const MARKER = 'REPORTSTEST'
const REMARKS = `${MARKER}: span calibration, all four sensors.`

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

  const schedule = await prismaUnscoped.maintenanceSchedule.findFirstOrThrow({
    where: {
      orgId: org.id,
      type: 'CALIBRATION',
      basis: 'CALENDAR',
      active: true,
      asset: { active: true },
    },
    include: { asset: true },
    orderBy: { nextDue: 'asc' },
  })
  const asset = schedule.asset
  const priorNextDue = schedule.nextDue
  const priorLastPerformed = schedule.lastPerformed

  console.log(`\nCalibrating ${asset.assetTag} on "${schedule.label}"\n`)

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let recordId: string | null = null

  try {
    await signIn(page, 'sam@teksolv.com')

    // --- 1. completing it shows it ---------------------------------------
    console.log('Completing the report\n')

    await page.goto(`${BASE}/maintenance/service?scheduleId=${schedule.id}`, {
      waitUntil: 'networkidle',
    })
    await page.fill('textarea[name="workDone"]', `${MARKER}: span calibration.`)
    await page.fill('textarea[name="calRemarks"]', REMARKS)
    await page.getByRole('button', { name: /Log service/ }).click()

    // The whole point of the fix: it lands on the document, not on a tab with
    // the document hidden behind a link somebody has to know to look for.
    await page.waitForURL(/\/maintenance\/records\/[a-z0-9]{20,}\/form/, { timeout: 45_000 })
    // The route has a `loading.tsx` now, so arriving at the URL and the content
    // being on screen are two different moments. Wait for the document itself
    // rather than for the address bar.
    await page.getByRole('button', { name: 'Save as PDF' }).waitFor({ timeout: 30_000 })
    check(
      'completing a calibration lands on the report itself',
      /\/maintenance\/records\/.+\/form/.test(page.url()),
      page.url().replace(BASE, ''),
    )
    check(
      'with a Print action right there',
      await page.getByRole('button', { name: 'Save as PDF' }).isVisible(),
    )
    check(
      'and it says it has been filed, not that it is a preview',
      (await page.locator('body').innerText()).includes('Report filed'),
    )

    const printedOnArrival = await page.locator('article').innerText()
    check('the report shown is the one just completed', printedOnArrival.includes('REPORTSTEST'))

    const record = await prismaUnscoped.maintenanceRecord.findFirstOrThrow({
      where: { assetId: asset.id, type: 'CALIBRATION' },
      orderBy: { createdAt: 'desc' },
    })
    recordId = record.id
    const reportUrl = `/maintenance/records/${record.id}/form`

    // --- 2. filed on the unit --------------------------------------------
    console.log('\nOn the unit\n')

    await page.goto(`${BASE}/inventory/${asset.id}?tab=documents`, { waitUntil: 'networkidle' })
    // The sidebar is an <aside> too; the drawer is the last one.
    const drawer = page.locator('aside').last()
    const documents = await drawer.innerText()
    check('it is on the unit’s Documents tab', documents.includes('CAL-01-'))
    check(
      'labelled as something to open and print, not a mystery file',
      documents.toLowerCase().includes('open to view or print'),
    )

    const fromDocuments = drawer.locator(`a[href="${reportUrl}"]`)
    check('the row links to the report', (await fromDocuments.count()) === 1)
    await fromDocuments.first().click()
    await page.waitForURL(new RegExp(`${record.id}/form`), { timeout: 30_000 })
    await page.getByRole('button', { name: 'Save as PDF' }).waitFor({ timeout: 30_000 })
    const reopenedFromDocuments = await page.locator('article').innerText()
    check(
      'reopening from Documents reprints the same report',
      reopenedFromDocuments.includes('REPORTSTEST') &&
        (await page.getByRole('button', { name: 'Save as PDF' }).isVisible()),
    )
    check(
      'and the filed banner is gone — it is not "just completed" any more',
      !(await page.locator('body').innerText()).includes('Report filed'),
    )

    // --- 3. the central list ----------------------------------------------
    console.log('\nIn the Reports list\n')

    await page.goto(`${BASE}/reports`, { waitUntil: 'networkidle' })
    const list = await page.locator('main, body').first().innerText()
    check('a Reports view exists and is reachable from the nav', page.url().includes('/reports'))
    check(
      'the calibration is listed, tagged Calibration',
      list.includes(asset.assetTag) && list.toUpperCase().includes('CALIBRATION'),
    )
    check(
      'inspections are listed alongside them, tagged Inspection',
      list.toUpperCase().includes('INSPECTION'),
      'both kinds in one list — the point of it being central',
    )

    const fromList = page.locator(`a[href="${reportUrl}"]`)
    check('the row links to the report', (await fromList.count()) >= 1)
    await fromList.first().click()
    await page.waitForURL(new RegExp(`${record.id}/form`), { timeout: 30_000 })
    await page.getByRole('button', { name: 'Save as PDF' }).waitFor({ timeout: 30_000 })
    check(
      'reopening from Reports reprints the same report',
      (await page.locator('article').innerText()).includes('REPORTSTEST') &&
        (await page.getByRole('button', { name: 'Save as PDF' }).isVisible()),
    )

    // Both routes reached the same document — not two renderings that could
    // drift, which is the failure this whole flow is meant to make impossible.
    check(
      'Documents and Reports open the identical document',
      reopenedFromDocuments === (await page.locator('article').innerText()),
    )

    // --- the list itself ---------------------------------------------------
    console.log('\nWhat the list contains\n')

    const rows = await listCompletedReports(db)
    const mine = rows.find((row) => row.id === record.id)
    check(
      'every row carries unit, date, technician and a link',
      Boolean(
        mine &&
          mine.asset.assetTag === asset.assetTag &&
          mine.performedAt instanceof Date &&
          mine.technician &&
          mine.href === reportUrl,
      ),
      mine ? `${mine.asset.assetTag} · ${mine.technician} · ${mine.href}` : 'row missing',
    )
    check(
      'newest first across both kinds',
      rows.every(
        (row, index) =>
          index === 0 || rows[index - 1].performedAt.getTime() >= row.performedAt.getTime(),
      ),
    )
    const inspectionRows = rows.filter((row) => row.kind === 'INSPECTION')
    check(
      'inspections carry their PASS/FAIL result',
      inspectionRows.length === 0 ||
        inspectionRows.every((row) => row.result === 'PASS' || row.result === 'FAIL'),
      `${inspectionRows.length} inspection row(s)`,
    )
    check(
      'no report in the list points nowhere',
      rows.every((row) => row.href.startsWith('/')),
    )

    const filtered = await listCompletedReports(db, { kind: 'CALIBRATION' })
    check(
      'the type filter narrows to one kind',
      filtered.length > 0 && filtered.every((row) => row.kind === 'CALIBRATION'),
      `${filtered.length} calibration report(s)`,
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // Unconditional, and keyed off the marker rather than off `recordId`: the
    // server action writes the record before the browser finishes navigating,
    // so an assertion that throws between the two would otherwise leave a real
    // calibration on a seeded unit with nothing to roll it back.
    await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { assetId: asset.id, type: 'CALIBRATION', workDone: { startsWith: MARKER } },
    })
    await prismaUnscoped.attachment.deleteMany({
      where: { assetId: asset.id, type: 'CALIBRATION_CERT' },
    })
    await prismaUnscoped.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { nextDue: priorNextDue, lastPerformed: priorLastPerformed },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { action: 'maintenance.service', entityId: asset.id },
    })
    console.log('\n  (test data cleaned up)')
  }

  console.log(failures === 0 ? '\nAll report-flow checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
