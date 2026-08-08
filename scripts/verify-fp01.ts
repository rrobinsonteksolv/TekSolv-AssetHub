/**
 * TekSolv Form FP-01 — Full Body Harness Inspection, end to end.
 *
 * Runs a real harness inspection through the browser and checks the generated
 * form against the record: the four sections render as groups, a critical
 * failure marks FAIL — REMOVE FROM SERVICE, the signature prints as an image
 * rather than a blank line, and the result lands on the unit's documents.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-fp01.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { FP01_HARNESS, sectionsOf } from '../src/lib/inspection-forms'
import { dbForOrg } from '../src/lib/tenant-db'
import { pickTemplatesForAsset } from '../src/lib/inspections'
import { usDate } from '../src/lib/dates'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const NOTE = 'FP01TEST: 2in cut in left leg webbing.'

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
  const template = await prismaUnscoped.inspectionTemplate.findFirstOrThrow({
    where: { orgId: org.id, slug: FP01_HARNESS.slug },
    include: { items: { orderBy: { order: 'asc' } } },
  })

  console.log(
    `\nTemplate "${template.name}" — ${template.items.length} items, ` +
      `${new Set(template.items.map((item) => item.section)).size} sections\n`,
  )

  check(
    'the template carries every item on the paper form',
    template.items.length === FP01_HARNESS.items.length,
    `${template.items.length} of ${FP01_HARNESS.items.length}`,
  )
  check(
    'every item is critical — there is no minor defect on a harness',
    template.items.every((item) => item.failCreatesTicket),
  )
  check(
    'the four sections are present, in printed order',
    JSON.stringify([...new Set(template.items.map((item) => item.section))]) ===
      JSON.stringify(sectionsOf(FP01_HARNESS)),
    [...new Set(template.items.map((item) => item.section))].join(' · '),
  )

  // Give the org a letterhead so the printed form has real details to show.
  const original = (await prismaUnscoped.organization.findUniqueOrThrow({ where: { id: org.id } }))
    .settings as Record<string, unknown> | null
  await prismaUnscoped.organization.update({
    where: { id: org.id },
    data: {
      settings: {
        ...(original ?? {}),
        branding: {
          legalName: 'TekSolv Inc.',
          addressLines: ['FP-01 TEST ADDRESS', 'Newark, NJ'],
          phone: '000-000-0000',
          website: 'teksolv.com',
        },
      },
    },
  })

  // Find a unit the template is actually offered for, rather than assuming a
  // category. FP-01 is bound to "Fall Protection" and the harnesses sit in its
  // child "Lifelines", so it reaches them by ancestor match — asking the same
  // helper the runner asks is the only way to be sure.
  const db = dbForOrg(org.id)
  const candidates = await prismaUnscoped.asset.findMany({
    where: { orgId: org.id, active: true, status: 'AVAILABLE' },
    orderBy: { assetTag: 'asc' },
  })
  let harness: (typeof candidates)[number] | null = null
  for (const candidate of candidates) {
    const offered = await pickTemplatesForAsset(db, candidate.id)
    if (offered.some((entry) => entry.template.id === template.id)) {
      harness = candidate
      break
    }
  }
  if (!harness) throw new Error('no available unit that FP-01 applies to')
  const priorStatus = harness.status
  const priorManufactureDate = harness.manufactureDate
  // Date of manufacture drives service life on a harness and the printed
  // form asks for it — set one so the form has something to print.
  await prismaUnscoped.asset.update({
    where: { id: harness.id },
    data: { manufactureDate: new Date('2019-03-14T00:00:00.000Z') },
  })
  console.log(`Inspecting ${harness.assetTag}\n`)

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  /** Hoisted so the cleanup in `finally` can reach it however the test exits. */
  let filedInspectionId: string | null = null

  try {
    await signIn(page, 'sam@teksolv.com')

    await page.goto(`${BASE}/inspections/run?assetId=${harness.id}&templateId=${template.id}`, {
      waitUntil: 'networkidle',
    })
    const runner = (await page.locator('body').innerText()).toUpperCase()
    for (const section of sectionsOf(FP01_HARNESS)) {
      check(
        `the runner groups items under ${section}`,
        runner.includes(section.toUpperCase()),
      )
    }

    // --- the checklist records in place ------------------------------------
    //
    // Regression guard. The hidden radios were `sr-only`, i.e. absolutely
    // positioned with no positioned ancestor, so all 44 of them escaped to the
    // initial containing block: the document grew to ~4,700px (a vast blank
    // area below the app) and clicking a label focused an input the browser
    // then scrolled the window to. Both symptoms, one cause.
    const scrollMetrics = () =>
      page.evaluate(() => {
        const scroller = Array.from(document.querySelectorAll('div')).find(
          (node) =>
            node.scrollHeight > node.clientHeight + 20 &&
            getComputedStyle(node).overflowY === 'auto',
        )
        return {
          windowY: window.scrollY,
          documentHeight: document.documentElement.scrollHeight,
          viewport: window.innerHeight,
          scrollTop: scroller ? scroller.scrollTop : -1,
        }
      })

    const layout = await scrollMetrics()
    check(
      'the checklist does not stretch the document past the viewport',
      layout.documentHeight <= layout.viewport + 1,
      `document ${layout.documentHeight}px vs viewport ${layout.viewport}px`,
    )

    // Answer a few items mid-list and confirm nothing moves. Playwright's own
    // scroll-into-view happens before the measurement, so any delta is the
    // app's doing.
    let worstScroll = 0
    let worstWindow = 0
    for (const [index, probe] of template.items.slice(4, 10).entries()) {
      const answer = index % 2 === 0 ? 'PASS' : 'FAIL'
      const control = page.locator(
        `label:has(input[name="item.${probe.id}.value"][value="${answer}"])`,
      )
      await control.scrollIntoViewIfNeeded()
      await page.waitForTimeout(150)
      const before = await scrollMetrics()
      await control.click()
      await page.waitForTimeout(200)
      const afterClick = await scrollMetrics()
      worstScroll = Math.max(worstScroll, Math.abs(afterClick.scrollTop - before.scrollTop))
      worstWindow = Math.max(worstWindow, Math.abs(afterClick.windowY - before.windowY))
    }
    check(
      'answering an item moves the scroll position not at all',
      worstScroll === 0 && worstWindow === 0,
      `worst container Δ ${worstScroll}px, worst window Δ ${worstWindow}px across 6 answers`,
    )

    // Keyboard users must still be able to answer — the radios are hidden, not
    // removed, and the label carries the focus ring.
    const keyboard = await page.evaluate(() => {
      const input = document.querySelector('input[type="radio"]') as HTMLInputElement | null
      if (!input) return null
      input.focus()
      const style = getComputedStyle(input)
      return {
        focusable: document.activeElement === input,
        display: style.display,
        visibility: style.visibility,
      }
    })
    check(
      'the answer controls are still real focusable radios',
      keyboard?.focusable === true &&
        keyboard.display !== 'none' &&
        keyboard.visibility !== 'hidden',
      `focusable=${keyboard?.focusable} display=${keyboard?.display}`,
    )

    // Pass everything except one webbing item — a critical failure.
    const failItem = template.items.find((item) => item.label === 'Cuts / burns / holes')
    if (!failItem) throw new Error('expected webbing item missing from template')

    for (const item of template.items) {
      const value = item.id === failItem.id ? 'FAIL' : 'PASS'
      await page
        .locator(`label:has(input[name="item.${item.id}.value"][value="${value}"])`)
        .click()
    }
    await page.fill(`textarea[name="item.${failItem.id}.notes"]`, NOTE)

    const pad = page.locator('canvas').first()
    await pad.scrollIntoViewIfNeeded()
    const box = await pad.boundingBox()
    if (!box) throw new Error('signature pad has no box')
    await page.mouse.move(box.x + 20, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 30, box.y + 20, { steps: 12 })
    await page.mouse.up()

    await page.getByRole('button', { name: /File.*inspection/ }).click()
    // Filing lands on the *form*, not the record: the inspector has just made a
    // document and usually has to print it there and then. The record is one
    // click back from it.
    await page.waitForURL(/\/inspections\/[a-z0-9]{20,}\/form/, { timeout: 45_000 })
    // The route has a `loading.tsx` now, so arriving at the URL and the content
    // being on screen are two different moments. Wait for the document itself
    // rather than for the address bar.
    await page.getByRole('button', { name: 'Save as PDF' }).waitFor({ timeout: 30_000 })

    const inspection = await prismaUnscoped.inspection.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { createdAt: 'desc' },
      include: { responses: true, tickets: true },
    })
    filedInspectionId = inspection.id

    check('the inspection filed as FAIL', inspection.result === 'FAIL')
    check(
      'every item was recorded, not just the failure',
      inspection.responses.length === FP01_HARNESS.items.length,
      `${inspection.responses.length} responses`,
    )
    const after = await prismaUnscoped.asset.findUniqueOrThrow({ where: { id: harness.id } })
    check('the critical failure pulled the harness', after.status === 'OUT_OF_SERVICE', after.status)
    check('and opened a ticket', inspection.tickets.length === 1)

    // --- the printed form ------------------------------------------------
    check(
      'filing shows the form straight away, with a Print action',
      page.url().includes(`/inspections/${inspection.id}/form`) &&
        (await page.getByRole('button', { name: 'Save as PDF' }).isVisible()),
      page.url().replace(BASE, ''),
    )
    check(
      'and says it has been filed rather than looking like a preview',
      (await page.locator('body').innerText()).includes('Report filed'),
    )

    // The record is still one click back, and still links forward to the form.
    await page.goto(`${BASE}/inspections/${inspection.id}`, { waitUntil: 'networkidle' })
    check(
      'a "Form FP-01" link sits on the inspection record',
      await page.getByRole('link', { name: /Form FP-01/ }).isVisible(),
    )
    await page.getByRole('link', { name: /Form FP-01/ }).click()
    await page.waitForURL(/\/form(\?|$)/, { timeout: 30_000 })
    await page.getByRole('button', { name: 'Save as PDF' }).waitFor({ timeout: 30_000 })
    const form = await page.locator('article').innerText()
    const upper = form.toUpperCase()

    // The printed title breaks across two lines, so it is asserted as two
    // lines — matching the paper rather than a convenient single string.
    check(
      'header carries the two-line title and the form code',
      upper.includes('FULL BODY HARNESS') &&
        upper.includes('INSPECTION FORM') &&
        upper.includes('FP-01'),
    )
    check(
      'header carries the letterhead from org settings',
      upper.includes('TEKSOLV') && form.includes('FP-01 TEST ADDRESS'),
      'not hard-coded — an unset address prints nothing rather than filler',
    )
    check(
      'header carries the standard line exactly as printed',
      form.includes('Fall Protection') && form.includes('OSHA 1926.502') && form.includes('ANSI/ASSP Z359'),
    )
    check(
      'checklist bar carries the pre-use instruction',
      form.includes('Inspect before each use'),
    )
    check(
      'sections are numbered 1-4 with the hardware qualifier',
      form.includes('D-rings, buckles, keepers') &&
        ['1', '2', '3', '4'].every((n) => form.includes(n)),
    )
    check(
      'the record has a frequency field and a separate signature date',
      upper.includes('FREQUENCY') && upper.includes('INSPECTOR SIGNATURE'),
    )
    check(
      'the footer carries the form code and revision',
      form.includes('Form FP-01') && form.includes('Rev. 2026'),
    )
    check(
      'the OSHA/ANSI small print is reproduced',
      form.includes('competent person other than the user'),
    )
    check(
      'the equipment block prints the date of manufacture',
      // The record holds 2019-03-14; the paper an inspector signs reads it the
      // way this shop reads dates.
      form.includes(usDate('2019-03-14')!),
      'sourced from Asset.manufactureDate — the field the printed form asks for',
    )
    check(
      'equipment block is pre-filled from the unit',
      form.includes(harness.assetTag) &&
        (harness.serialNumber ? form.includes(harness.serialNumber) : true),
      `${harness.assetTag} · ${harness.manufacturer ?? '—'} · ${harness.serialNumber ?? '—'}`,
    )
    for (const section of sectionsOf(FP01_HARNESS)) {
      check(`checklist renders the ${section} group`, upper.includes(section.toUpperCase()))
    }
    check(
      'overall determination reads FAIL — REMOVE FROM SERVICE',
      upper.includes('FAIL — REMOVE FROM SERVICE'),
    )
    check('the failed item is named on the form', form.includes('Cuts / burns / holes'))
    check('notes / corrective action carries the inspector note', form.includes('FP01TEST'))
    check('inspection record names the competent person', form.includes('Sam Okafor'))
    check(
      'the signature prints as an image, not a blank line',
      (await page.locator('img[alt="Inspector signature"]').count()) === 1,
    )
    check(
      'the form offers a PDF export',
      await page.getByRole('button', { name: 'Save as PDF' }).isVisible(),
    )

    // --- filed against the unit -------------------------------------------
    const attachment = await prismaUnscoped.attachment.findFirst({
      where: { assetId: harness.id, type: 'INSPECTION_PDF' },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'the form is attached to the unit’s documents',
      attachment?.filename?.startsWith('FP-01-') ?? false,
      attachment?.filename,
    )
    check(
      'and Inspection.pdfUrl points at it',
      inspection.pdfUrl === `/inspections/${inspection.id}/form`,
      inspection.pdfUrl ?? 'null',
    )
    await page.goto(`${BASE}/inventory/${harness.id}?tab=documents`, { waitUntil: 'networkidle' })
    check(
      'it appears on the Documents tab',
      (await page.locator('body').innerText()).includes('FP-01-'),
    )

    // --- the blank copy ----------------------------------------------------
    await page.goto(`${BASE}/inspections/forms/fp-01`, { waitUntil: 'networkidle' })
    const blank = await page.locator('article').innerText()
    check(
      'a blank FP-01 is available for field use',
      blank.toUpperCase().includes('FULL BODY HARNESS INSPECTION FORM') &&
        blank.includes('Blank copy'),
    )
    check(
      'the blank carries every item — same source as the filled one',
      FP01_HARNESS.items.every((item) => blank.includes(item.label)),
    )
    check('and nothing is pre-ticked on it', !blank.includes('FP01TEST'))

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))

  } finally {
    await browser.close()

    // --- cleanup -----------------------------------------------------------
    //
    // In the `finally`, not at the end of the `try`. This test deliberately
    // fails a harness, which pulls it OUT_OF_SERVICE — so an assertion that
    // threw part-way through used to leave a seeded unit stranded in the shop
    // with a live ticket against it, quietly breaking *other* suites that
    // expect the fleet as seeded. The failure it was actually reporting was
    // then the second most confusing thing on the screen.
    if (filedInspectionId) {
      await prismaUnscoped.maintenanceTicket.deleteMany({
        where: { sourceInspectionId: filedInspectionId },
      })
      await prismaUnscoped.notification.deleteMany({ where: { entityId: filedInspectionId } })
      await prismaUnscoped.inspectionResponse.deleteMany({
        where: { inspectionId: filedInspectionId },
      })
      await prismaUnscoped.inspection.deleteMany({ where: { id: filedInspectionId } })
    }
    await prismaUnscoped.attachment.deleteMany({
      where: { assetId: harness.id, type: 'INSPECTION_PDF' },
    })
    await prismaUnscoped.asset.update({
      where: { id: harness.id },
      data: { status: priorStatus, manufactureDate: priorManufactureDate },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { action: 'inspection.submit', entityId: harness.id },
    })
    await prismaUnscoped.organization.update({
      where: { id: org.id },
      data: { settings: (original ?? {}) as never },
    })
    console.log('\n  (test data cleaned up)')
  }

  console.log(failures === 0 ? '\nAll FP-01 checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
