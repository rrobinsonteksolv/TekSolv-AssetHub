/**
 * Retirement: what leaves the fleet, why, and that it really is gone.
 *
 * The interesting half is not the retire button — it is the **exclusion**. A
 * retired unit that survives in one query is worse than one that survives in
 * none, because it will be offered for checkout exactly once, to somebody who
 * has no reason to doubt the list. So most of this suite is a sweep: retire a
 * real unit, then walk every surface that could deploy it and assert it is
 * absent from each.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-retired.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getDashboard } from '../src/lib/dashboard'
import { getUtilization, resolveYear, yearWindow } from '../src/lib/utilization'
import { resolveTrackingBaseline } from '../src/lib/tracking-baseline'
import { availableInWindow, windowFromNow } from '../src/lib/availability'
import { listRetired } from '../src/lib/retired'
import { listInspectableAssets } from '../src/lib/inspections'
import { listServiceableAssets } from '../src/lib/maintenance-queue'
import { usDate } from '../src/lib/dates'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const NOTE = 'RETTEST: cracked shell after a drop, not economical to repair.'

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

  // A healthy rental unit with rental history, so the utilization half of this
  // is testing something rather than a row of zeroes.
  const unit =
    (await db.asset.findFirst({
      where: {
        active: true,
        assetType: 'RENTAL',
        status: 'AVAILABLE',
        custodyType: null,
        rentals: { some: { status: 'RETURNED' } },
      },
      orderBy: { assetTag: 'asc' },
      select: { id: true, assetTag: true, status: true, condition: true },
    })) ??
    (await db.asset.findFirstOrThrow({
      where: { active: true, assetType: 'RENTAL', status: 'AVAILABLE', custodyType: null },
      orderBy: { assetTag: 'asc' },
      select: { id: true, assetTag: true, status: true, condition: true },
    }))

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const before = { ...unit }

  try {
    await signIn(page, 'ray@teksolv.com')

    const baseline = resolveTrackingBaseline(
      (await prismaUnscoped.organization.findUniqueOrThrow({
        where: { id: org.id },
        select: { settings: true },
      })).settings,
    )
    const thisYear = resolveYear(undefined, baseline)
    const utilBefore = await getUtilization(db, thisYear.range)
    const dashBefore = await getDashboard(db)

    // -----------------------------------------------------------------------
    console.log('\nRetiring says what happened to it\n')
    // -----------------------------------------------------------------------

    // Retiring is offered from the unit's edit page and from the Out of
    // Service list — both admin-gated, both unchanged by this work.
    await page.goto(`${BASE}/inventory/${unit.id}/edit`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Retire$/ }).click()
    const dialog = page.locator('[role="dialog"]', { hasText: 'Retire' })
    await dialog.waitFor({ state: 'visible', timeout: 20_000 })

    await dialog.locator('select[name="reason"]').selectOption('DAMAGED_BEYOND_REPAIR')
    await dialog.locator('textarea[name="note"]').fill(NOTE)
    await dialog.getByRole('button', { name: /^Retire$/ }).click()
    await page.waitForTimeout(1_500)

    const retired = await prismaUnscoped.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: {
        status: true,
        active: true,
        retiredAt: true,
        retiredReason: true,
        retiredNote: true,
        retiredById: true,
        custodyType: true,
      },
    })
    check('it is retired', retired.status === 'RETIRED' && !retired.active, retired.status)
    check(
      'with the disposition it was given',
      retired.retiredReason === 'DAMAGED_BEYOND_REPAIR',
      retired.retiredReason ?? 'none',
    )
    check('and the note', retired.retiredNote === NOTE, retired.retiredNote ?? '—')
    check('dated, and attributed', retired.retiredAt !== null && retired.retiredById !== null)
    check('holding nothing', retired.custodyType === null, 'retiring releases whoever had it')

    const trail = await db.auditLog.findFirst({
      where: { entityType: 'Asset', entityId: unit.id, action: 'asset.retire' },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true } } },
    })
    check(
      'the retirement is on the audit trail with its reason',
      (trail?.metadata as Record<string, unknown> | null)?.reason === 'DAMAGED_BEYOND_REPAIR',
      trail ? `${trail.action} by ${trail.user?.name}` : 'nothing logged',
    )

    // The database refuses a half-retired row, whatever the code does.
    let constrained = false
    try {
      await prismaUnscoped.$executeRawUnsafe(
        `UPDATE "Asset" SET "retiredReason" = NULL WHERE "id" = $1`,
        unit.id,
      )
    } catch {
      constrained = true
    }
    check(
      'a retired unit cannot lose its reason',
      constrained,
      'asset_retirement_is_complete — so the Retired list can never show a unit nobody can account for',
    )

    // -----------------------------------------------------------------------
    console.log('\nIt is gone from everything deployable\n')
    // -----------------------------------------------------------------------

    const dashAfter = await getDashboard(db)
    check(
      'the dashboard fleet count drops by one',
      dashAfter.fleet.total === dashBefore.fleet.total - 1,
      `${dashBefore.fleet.total} → ${dashAfter.fleet.total}`,
    )
    check(
      'and so does the deployable pool behind the composition bar',
      dashAfter.fleet.deployable === dashBefore.fleet.deployable - 1,
      `${dashBefore.fleet.deployable} → ${dashAfter.fleet.deployable} — it is not idle capacity, it is not capacity`,
    )

    const grabbable = await db.asset.count({
      where: { id: unit.id, ...availableInWindow(windowFromNow(new Date())) },
    })
    check('availability will not offer it', grabbable === 0, 'so it cannot be grabbed or booked')

    check(
      'checkout will not offer it',
      (await db.asset.count({ where: { id: unit.id, active: true, status: 'AVAILABLE' } })) === 0,
      'the checkout picker filters on exactly this',
    )
    check(
      'inspections will not offer it',
      !(await listInspectableAssets(db)).some((asset) => asset.id === unit.id),
    )
    check(
      'maintenance will not offer it',
      !(await listServiceableAssets(db)).some((asset) => asset.id === unit.id),
    )
    check(
      'it cannot be staged on a truck',
      (await db.asset.count({ where: { id: unit.id, active: true } })) === 0,
      'scan-to-stage resolves through the same active filter',
    )

    await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' })
    check(
      'and it is off the inventory list',
      !(await page.locator('main').innerText()).includes(unit.assetTag),
      unit.assetTag,
    )

    // -----------------------------------------------------------------------
    console.log('\nUtilization measures it up to the day it went\n')
    // -----------------------------------------------------------------------

    const utilAfter = await getUtilization(db, thisYear.range)
    const row = utilAfter.categories
      .flatMap((category) => category.units)
      .find((entry) => entry.id === unit.id)

    check(
      'it still appears in this year — it was part of the fleet for part of it',
      row !== undefined,
      'dropping it would erase rental days the fleet genuinely earned',
    )
    check(
      'but its window closes on the day it was retired',
      row !== undefined && row.daysOwned < utilBefore.fleet.daysOnRent + 400 && row.retiredAt !== null,
      row ? `${row.daysOwned}d measured, retired ${row.retiredAt?.toISOString().slice(0, 10)}` : '',
    )
    check(
      'so it is not carried as idle capacity for the rest of the year',
      row !== undefined &&
        row.daysOwned <=
          (retired.retiredAt!.getTime() - thisYear.range.from.getTime()) / 86_400_000 + 1,
      'the denominator stops when the unit did',
    )
    check(
      'and no unit exceeds 100%',
      utilAfter.categories.every((category) => (category.utilization ?? 0) <= 100),
    )

    // Retiring in 2026 does *not* remove the unit from 2025 — it was in the
    // fleet all through 2025 and its rentals that year were real. What it does
    // is close the window, so any year that opens after the retirement finds
    // nothing to measure.
    const priorYear = await getUtilization(db, yearWindow(thisYear.year - 1).range)
    check(
      'a year it lived through still counts it',
      priorYear.categories.flatMap((c) => c.units).some((entry) => entry.id === unit.id),
      `retiring in ${thisYear.year} does not rewrite ${thisYear.year - 1}`,
    )

    const afterYear = await getUtilization(db, yearWindow(thisYear.year + 1).range)
    check(
      'a year that opens after it went finds nothing to measure',
      !afterYear.categories.flatMap((c) => c.units).some((entry) => entry.id === unit.id),
      'the window closes at the retirement, so a later year drops it entirely',
    )

    // -----------------------------------------------------------------------
    console.log('\nIt exists for the record\n')
    // -----------------------------------------------------------------------

    const listed = await listRetired(db)
    check(
      'it is in the retired list',
      listed.some((entry) => entry.id === unit.id),
      `${listed.length} retired unit(s)`,
    )

    await page.goto(`${BASE}/inventory/retired`, { waitUntil: 'networkidle' })
    // Lowercased: the disposition badge is `text-transform: uppercase`, and
    // `innerText` returns text as rendered.
    const retiredPage = (await page.locator('main').innerText()).toLowerCase()
    check('the section shows it', retiredPage.includes(unit.assetTag.toLowerCase()))
    check('with what happened', retiredPage.includes('damaged beyond repair'))
    check(
      'and when',
      retiredPage.includes(usDate(retired.retiredAt)!.toLowerCase()),
      usDate(retired.retiredAt) ?? 'null',
    )
    check('and the note', retiredPage.includes('cracked shell'), NOTE)

    await page.goto(`${BASE}/inventory/retired?reason=SOLD`, { waitUntil: 'networkidle' })
    check(
      'filtering by disposition works',
      !(await page.locator('main').innerText()).toLowerCase().includes(unit.assetTag.toLowerCase()),
      'a unit damaged beyond repair is not in the “sold” group',
    )

    // -----------------------------------------------------------------------
    console.log('\nAnd it can come back\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/inventory/retired`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Un-retire/i }).first().click()
    const back = page.locator('[role="dialog"]', { hasText: 'back' })
    await back.waitFor({ state: 'visible', timeout: 20_000 })
    await back.locator('textarea[name="note"]').fill('RETTEST: retired in error.')
    await back.getByRole('button', { name: /Bring it back/i }).click()
    await page.waitForTimeout(1_500)

    const restored = await prismaUnscoped.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: { status: true, active: true, retiredAt: true, retiredReason: true },
    })
    check(
      'un-retiring returns it to Available',
      restored.status === 'AVAILABLE' && restored.active,
      restored.status,
    )
    check(
      'and clears the disposition, so the row cannot claim both',
      restored.retiredAt === null && restored.retiredReason === null,
    )
    check(
      'the round trip is its own audit event, not buried in an edit',
      (await db.auditLog.count({
        where: { entityType: 'Asset', entityId: unit.id, action: 'asset.unretire' },
      })) === 1,
    )
    check(
      'and it is deployable again',
      (await db.asset.count({
        where: { id: unit.id, ...availableInWindow(windowFromNow(new Date())) },
      })) === 1,
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    // Unconditional: a failure mid-run must not leave a seeded unit retired.
    await prismaUnscoped.asset.update({
      where: { id: before.id },
      data: {
        status: before.status,
        active: true,
        retiredAt: null,
        retiredReason: null,
        retiredNote: null,
        retiredById: null,
      },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: {
        entityId: before.id,
        action: { in: ['asset.retire', 'asset.unretire'] },
      },
    })
    console.log(`\n(restored ${before.assetTag} to ${before.status})`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll retirement checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
