/**
 * The status filter matches what the badge says.
 *
 * A unit staged on a truck is stored `AVAILABLE` — correctly, it is physically
 * on the shelf — and shown as **Assigned**, because it is not free to take.
 * The inventory filter was matching the stored column, so selecting "Available"
 * returned every assigned unit, each wearing an "Assigned" badge in the same
 * row the filter had just claimed was available.
 *
 * This is the third surface to trip over the same split — badges, then search,
 * now the filter. So the last check here is a **source guard**: nothing outside
 * `asset-status.ts` may spell the derived rule out by hand, because every
 * hand-written copy is another place for it to drift.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-status-filter.ts
 */
import 'dotenv/config'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { buildAssetWhere, listAssets } from '../src/lib/assets'
import {
  DISPLAY_LABEL,
  DISPLAY_STATUSES,
  displayStatus,
  displayStatusWhere,
} from '../src/lib/asset-status'

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

async function settle(page: Page) {
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
}

function sourceFiles(dir = 'src'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // ---------------------------------------------------------------------------
  console.log('\nThe query form agrees with the display form\n')
  // ---------------------------------------------------------------------------

  check(
    'Available means on the shelf and nobody’s',
    JSON.stringify(displayStatusWhere('AVAILABLE')) ===
      JSON.stringify({ status: 'AVAILABLE', custodyType: null }),
    JSON.stringify(displayStatusWhere('AVAILABLE')),
  )
  check(
    'Assigned means available *plus* a holder',
    JSON.stringify(displayStatusWhere('ASSIGNED')) ===
      JSON.stringify({ status: 'AVAILABLE', custodyType: { not: null } }),
    'Assigned is not a stored status — it is the pair, and that pair lives in one place now',
  )
  check(
    'and every other state asks for itself',
    (['OUT_ON_RENT', 'OUT_OF_SERVICE', 'QUARANTINED', 'RETIRED', 'IN_MAINTENANCE'] as const).every(
      (state) => JSON.stringify(displayStatusWhere(state)) === JSON.stringify({ status: state }),
    ),
    'a unit out on rent cannot hold custody, so there is nothing to derive',
  )

  // ---------------------------------------------------------------------------
  console.log('\nEvery filter returns exactly what its badge says\n')
  // ---------------------------------------------------------------------------

  for (const state of DISPLAY_STATUSES) {
    const rows = await db.asset.findMany({
      where: buildAssetWhere({ status: state }),
      select: { assetTag: true, status: true, custodyType: true },
    })
    const wrong = rows.filter((row) => displayStatus(row.status, row.custodyType) !== state)
    check(
      `“${DISPLAY_LABEL[state]}” returns ${rows.length} unit(s), all badged ${DISPLAY_LABEL[state]}`,
      wrong.length === 0,
      wrong.length
        ? `${wrong.length} wrong: ${wrong
            .slice(0, 3)
            .map((row) => `${row.assetTag} is ${displayStatus(row.status, row.custodyType)}`)
            .join(', ')}`
        : rows.length === 0
          ? 'none in that state right now'
          : `e.g. ${rows[0].assetTag}`,
    )
  }

  // Retiring clears `active`, so an "active inventory" clause would make this
  // option permanently empty — which reads as "nothing is retired" rather than
  // as a filter that cannot work.
  const retiredRows = await db.asset.findMany({
    where: buildAssetWhere({ status: 'RETIRED' }),
    select: { assetTag: true, status: true, active: true },
  })
  const retiredOnFile = await db.asset.count({ where: { status: 'RETIRED' } })
  check(
    'Retired returns the retired units rather than nothing',
    retiredRows.length === retiredOnFile && retiredRows.every((row) => !row.active),
    `${retiredRows.length} of ${retiredOnFile} on file — retiring clears \`active\`, so this filter lifts that clause`,
  )

  // The bug, stated as its own check so a regression is unmistakable.
  const availableRows = await db.asset.findMany({
    where: buildAssetWhere({ status: 'AVAILABLE' }),
    select: { custodyType: true },
  })
  check(
    'no assigned unit leaks into Available',
    availableRows.every((row) => row.custodyType === null),
    `${availableRows.length} available, ${availableRows.filter((row) => row.custodyType !== null).length} of them held — the original bug`,
  )
  const assignedRows = await db.asset.findMany({
    where: buildAssetWhere({ status: 'ASSIGNED' }),
    select: { status: true, custodyType: true },
  })
  check(
    'and Assigned returns only held units',
    assignedRows.length > 0 &&
      assignedRows.every((row) => row.custodyType !== null && row.status === 'AVAILABLE'),
    `${assignedRows.length} assigned — a state the filter could not express at all before`,
  )
  check(
    'the two are disjoint and together make the stored AVAILABLE pool',
    availableRows.length + assignedRows.length ===
      (await db.asset.count({ where: { status: 'AVAILABLE', active: true } })),
    `${availableRows.length} + ${assignedRows.length} = the stored AVAILABLE count`,
  )

  // ---------------------------------------------------------------------------
  console.log('\nOn the page, the rows and their badges agree\n')
  // ---------------------------------------------------------------------------

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')

    for (const state of ['AVAILABLE', 'ASSIGNED', 'OUT_ON_RENT'] as const) {
      await page.goto(`${BASE}/inventory?status=${state}`, { waitUntil: 'networkidle' })
      await settle(page)
      const badges = await page.locator('tbody tr td:nth-child(4)').allInnerTexts()
      const label = DISPLAY_LABEL[state].toLowerCase()
      check(
        `filtering to ${DISPLAY_LABEL[state]} shows only ${DISPLAY_LABEL[state]} badges`,
        badges.length > 0 && badges.every((text) => text.trim().toLowerCase() === label),
        badges.length === 0
          ? 'no rows'
          : `${badges.length} rows · ${[...new Set(badges.map((t) => t.trim()))].join(', ')}`,
      )
    }

    // The count under the table has to agree with the rows in it.
    await page.goto(`${BASE}/inventory?status=ASSIGNED`, { waitUntil: 'networkidle' })
    await settle(page)
    const { filteredCount } = await listAssets(db, { status: 'ASSIGNED' })
    check(
      'and the count matches the filter, not the raw column',
      filteredCount === assignedRows.length,
      `${filteredCount} counted · ${assignedRows.length} assigned`,
    )

    const options = await page.locator('select[aria-label="Status"] option').allInnerTexts()
    check(
      'the filter offers Assigned, which it never used to',
      options.some((text) => text.trim() === 'Assigned'),
      options.map((text) => text.trim()).join(' · '),
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.$disconnect()
  }

  // ---------------------------------------------------------------------------
  console.log('\nAnd nowhere else spells the rule out by hand\n')
  // ---------------------------------------------------------------------------

  const HELPER = join('src', 'lib', 'asset-status.ts')
  const handRolled = sourceFiles().filter((file) => {
    if (file === HELPER) return false
    const text = readFileSync(file, 'utf8')
    // The derived rule in longhand: an AVAILABLE test sitting beside a custody
    // test inside the same query object.
    return /status:\s*'AVAILABLE'[^}]*custodyType:|custodyType:[^}]*status:\s*'AVAILABLE'/.test(text)
  })
  check(
    'no surface writes `status: AVAILABLE` beside a custody test itself',
    handRolled.length === 0,
    handRolled.length
      ? handRolled.join(', ')
      : 'three surfaces hit this split; the mapping now lives in one place',
  )

  console.log(failures === 0 ? '\nAll status-filter checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
