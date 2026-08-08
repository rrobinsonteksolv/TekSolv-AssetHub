/**
 * Search and the drawer agree about what a unit reads as.
 *
 * The bug: the ⌘K result row printed `Asset.status` straight from the column,
 * lowercased. The drawer, the inventory list and the truck page all render the
 * *derived* display status instead — because BUILD_SPEC §3.4 keeps `status`
 * answering only "where is this unit physically", and a monitor staged on a
 * truck is genuinely still `AVAILABLE`. So a staged unit read "available" in
 * search and "Assigned" the moment it was opened: two statements about the same
 * unit, and the one that invited somebody to walk off with it was the one shown
 * first.
 *
 * The fix is not a matching lowercase mapping in the search row — that is a
 * second copy of the rule and the reason they drifted. Search now hands the two
 * columns to the same `StatusBadge` the drawer uses.
 *
 * So this suite never asserts a hard-coded string on its own. It drives a unit
 * into each state through the real app and asserts the two screens **agree**,
 * and that what they agree on is what `displayStatus` says.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-search-status.ts
 */
import 'dotenv/config'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { search } from '../src/lib/search'
import { DISPLAY_LABEL, displayStatus } from '../src/lib/asset-status'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const MARK = 'SRCHSTAT'

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
  const startedAt = new Date()
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const unit = await db.asset.findFirstOrThrow({
    where: {
      active: true,
      status: 'AVAILABLE',
      custodyType: null,
      tickets: { none: { status: { in: ['OPEN', 'IN_PROGRESS'] } } },
    },
    orderBy: { assetTag: 'asc' },
    select: { id: true, assetTag: true, status: true, condition: true },
  })
  const before = { ...unit }
  const truck = await db.truck.findFirstOrThrow({
    where: { active: true },
    select: { id: true, number: true },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  const createdRentals: string[] = []

  /** The ⌘K result row for this unit, open and ready to read. */
  async function openSearchRow() {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' })
    await page.keyboard.press('Control+k')
    const dialog = page.locator('[role="dialog"][aria-label="Global search"]')
    await dialog.waitFor({ state: 'visible', timeout: 20_000 })
    await dialog.locator('input').fill(unit.assetTag)
    const row = dialog.locator('[role="option"]', { hasText: unit.assetTag }).first()
    await row.waitFor({ state: 'visible', timeout: 20_000 })
    return row
  }

  /**
   * What the ⌘K row says for this unit.
   *
   * Read *structurally* — the last element of the row — rather than by matching
   * the labels we expect. Matching on content would make the reported bug
   * (a row saying "available") show up as a locator timeout deep in a helper,
   * when what it should produce is a legible `search "available" · drawer
   * "Available"`. A test for a disagreement has to be able to print the
   * disagreement.
   */
  async function inSearch(): Promise<string> {
    const row = await openSearchRow()
    const label = (await row.locator('> span').last().innerText()).trim()
    await page.keyboard.press('Escape')
    return label
  }

  /**
   * What the unit's own drawer says. Keyed on the badge's own shape, which is
   * `StatusBadge` wherever it is rendered, for the same reason.
   */
  async function inDrawer(): Promise<string> {
    await page.goto(`${BASE}/inventory/${unit.id}`, { waitUntil: 'networkidle' })
    const label = await page.locator('aside span.rounded-full').first().innerText()
    return label.trim()
  }

  /** What the shared helper says, from the columns as they now stand. */
  async function derived(): Promise<string> {
    const row = await db.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: { status: true, custodyType: true },
    })
    return DISPLAY_LABEL[displayStatus(row.status, row.custodyType)]
  }

  async function agree(state: string) {
    const [fromSearch, fromDrawer, fromHelper] = [await inSearch(), await inDrawer(), await derived()]
    check(
      `${state}: search and the drawer say the same thing`,
      fromSearch === fromDrawer,
      `search "${fromSearch}" · drawer "${fromDrawer}"`,
    )
    check(
      `${state}: and it is what displayStatus derives`,
      fromSearch === fromHelper,
      `both read "${fromSearch}"`,
    )
    return fromSearch
  }

  try {
    await signIn(page, 'sam@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nOn the shelf, free to take\n')
    // -----------------------------------------------------------------------

    check('the unit starts free', before.status === 'AVAILABLE', `${unit.assetTag}`)
    const free = await agree('free')
    check('which reads Available', free === 'Available', free)

    // -----------------------------------------------------------------------
    console.log('\nStaged on a truck — the case that was wrong\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/trucks/${truck.id}`, { waitUntil: 'networkidle' })
    await page.fill('input[name="scan"]', unit.assetTag)
    await page.getByRole('button', { name: /Stage on truck/i }).click()
    await page.waitForTimeout(1_200)

    const staged = await db.asset.findUniqueOrThrow({
      where: { id: unit.id },
      select: { status: true, custodyType: true },
    })
    check(
      'staging leaves the stored status alone, as it should',
      staged.status === 'AVAILABLE' && staged.custodyType === 'TRUCK',
      `stored ${staged.status}, held by ${staged.custodyType} — the derived label is the only thing that moves`,
    )

    const assigned = await agree('staged on a truck')
    check(
      'and both read Assigned, not "available"',
      assigned === 'Assigned',
      'this is the disagreement that was reported',
    )

    // The colour carries as much meaning as the word here: amber sits between
    // "take it" and "you cannot have it".
    const badge = (await openSearchRow()).locator('> span').last()
    const colour = await badge.evaluate((node) => getComputedStyle(node).color)
    check(
      'the search badge is amber, the same as everywhere else',
      colour.replace(/\s/g, '') === 'rgb(180,83,9)',
      `computed colour ${colour}`,
    )
    check(
      'and it is a badge rather than bare text',
      (await badge.getAttribute('class'))?.includes('rounded-full') === true,
      'the same StatusBadge the drawer and the inventory list render',
    )
    await page.keyboard.press('Escape')

    // -----------------------------------------------------------------------
    console.log('\nOut on rent\n')
    // -----------------------------------------------------------------------

    // Checking out clears custody by CHECK constraint, so this also proves the
    // derived label follows the columns rather than a cached string.
    await page.goto(`${BASE}/rentals/checkout?assetId=${unit.id}`, { waitUntil: 'networkidle' })
    await page.locator('select[name="customerId"]').selectOption({ index: 1 })
    await page.fill(
      'input[name="expectedReturnDate"]',
      new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    )
    await page.locator('select[name="checkedOutBy"]').selectOption({ index: 1 })
    await page.locator('button[type="submit"]').filter({ hasText: /Check out/i }).first().click()
    // Checkout lands on the order it created — one line, same page.
    await page.waitForURL(/\/rentals\/orders\/[a-z0-9]{20,}$/, { timeout: 45_000 })

    const rental = await db.rental.findFirstOrThrow({
      where: { assetId: unit.id, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    createdRentals.push(rental.id)

    const onRent = await agree('out on rent')
    check('which reads Out on Rent', onRent === 'Out on Rent', onRent)

    // …and back in, clean, so the next state starts from a known place.
    await page.goto(`${BASE}/rentals/${rental.id}`, { waitUntil: 'networkidle' })
    await page.locator('select[name="checkinCondition"]').selectOption('GOOD')
    await page.getByRole('button', { name: /Check in/i }).click()
    await page.waitForURL(/\/inventory\//, { timeout: 45_000 })

    // -----------------------------------------------------------------------
    console.log('\nOut of service\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/inventory/${unit.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Take out of service/i }).first().click()
    await page.fill('textarea[name="description"]', `${MARK}: pulled for a cracked case.`)
    await page.getByRole('button', { name: /^Take out of service$/i }).last().click()
    await page.waitForFunction(() => !document.querySelector('textarea[name="description"]'), undefined, {
      timeout: 30_000,
    })
    await page.waitForTimeout(800)

    const oos = await agree('out of service')
    check('which reads Out of Service', oos === 'Out of Service', oos)

    // -----------------------------------------------------------------------
    console.log('\nThe row carries columns, not a rendered label\n')
    // -----------------------------------------------------------------------

    const hits = await search(db, unit.assetTag)
    const hit = hits.find((entry) => entry.kind === 'asset' && entry.id === unit.id)
    check(
      'an asset hit carries the two columns the badge needs',
      hit?.asset?.status !== undefined && hit.asset.custodyType !== undefined,
      JSON.stringify(hit?.asset ?? null),
    )
    check(
      'and no pre-rendered status string that could disagree with them',
      hit?.badge === undefined,
      hit?.badge ?? 'none — the label is derived where it is drawn',
    )
    check(
      'while a rental hit keeps its own badge, which is not an asset status',
      (await search(db, 'SO')).some((entry) => entry.kind === 'rental' && entry.badge !== undefined),
      'the change is scoped to units',
    )

    // -----------------------------------------------------------------------
    console.log('\nNo raw asset status anywhere in the source\n')
    // -----------------------------------------------------------------------

    // The browser checks above prove the screens that were *looked at* agree.
    // This one proves the rule holds where nobody looked: a grep for the shape
    // of the bug. Every one of these sites lowercased `Asset.status` straight
    // from the column, so a truck-staged unit read "available" in a sentence
    // while its badge two inches away read "Assigned".
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry)) continue
        // The badge component is where the mapping is *allowed* to live.
        if (full.endsWith(path.join('ui', 'status-badge.tsx'))) continue
        if (full.endsWith(path.join('lib', 'asset-status.ts'))) continue

        const source = readFileSync(full, 'utf8')
        for (const [index, line] of source.split(/\r?\n/).entries()) {
          if (/\basset\.status\.(toLowerCase|replace)/.test(line) || /STATUS_LABEL\[/.test(line)) {
            offenders.push(`${path.relative(process.cwd(), full)}:${index + 1}`)
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))

    check(
      'nothing formats an asset status by hand',
      offenders.length === 0,
      offenders.length
        ? offenders.join(', ')
        : 'every render goes through displayStatus / displayStatusLabel',
    )

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // Unconditional: a failure mid-run must not leave a seeded unit staged,
    // rented or out of service.
    await prismaUnscoped.maintenanceTicket.deleteMany({
      where: { orgId: org.id, description: { contains: MARK } },
    })
    await prismaUnscoped.maintenanceRecord.deleteMany({
      where: { orgId: org.id, workDone: { contains: MARK } },
    })
    for (const id of createdRentals) {
      await prismaUnscoped.rental.deleteMany({ where: { id } })
    }
    await prismaUnscoped.custodyEvent.deleteMany({
      where: { assetId: before.id, createdAt: { gte: startedAt } },
    })
    await prismaUnscoped.notification.deleteMany({
      where: { orgId: org.id, createdAt: { gte: startedAt }, entityId: before.id },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { orgId: org.id, entityId: before.id, createdAt: { gte: startedAt } },
    })
    await prismaUnscoped.asset.update({
      where: { id: before.id },
      data: {
        status: before.status as never,
        condition: before.condition,
        custodyType: null,
        custodyUserId: null,
        custodyTruckId: null,
        custodyAssignedById: null,
        custodyAssignedAt: null,
      },
    })
    console.log(`\n(restored ${before.assetTag} to ${before.status}, no holder)`)
  }

  console.log(failures === 0 ? '\nAll search-status checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
