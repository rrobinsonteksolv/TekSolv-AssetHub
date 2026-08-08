/**
 * Supplies v2 — per-office stock, lots, expiry, and the alerts behind both.
 *
 * The scenario asked for, end to end:
 *
 *   PART A  a per-office grab draws down the right office and leaves the others
 *           alone; a worker with no home office is asked which one; an office
 *           that crosses its own reorder point is alerted *by the digest*, not
 *           just flagged on a screen somebody has to open.
 *
 *   PART B  a lot-tracked cal gas item receives two lots with different
 *           expiration dates, issues the soonest-expiring first, warns as that
 *           one approaches, and refuses to issue it once it has lapsed. A
 *           non-lot-tracked item shows no lot or expiry fields anywhere.
 *
 * Plus the v1 guarantees that must survive the change: the page is on the
 * sidebar under its own permission, counts move only through the ledger, and
 * who may do what did not shift.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-supplies.ts
 */
import 'dotenv/config'
import { chromium, type Browser, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { NAV_ITEMS } from '../src/lib/nav'
import { can, PERMISSIONS } from '../src/lib/rbac'
import { resolveOrgPermissions } from '../src/lib/org-permissions'
import { fefoOrder, lotState, planIssue } from '../src/lib/supplies'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const DAY = 86_400_000
const ITEM = 'SUPPLYTEST Cal gas'
const PLAIN = 'SUPPLYTEST Gloves'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

const day = (offset: number) => new Date(Date.now() + offset * DAY)
const iso = (date: Date | null | undefined) => date?.toISOString().slice(0, 10) ?? null

async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
  return page
}

/** The only places `alerts.receive` should still gate anything. */
const ALERT_SURFACES = [
  'src/app/(app)/alerts/page.tsx',
  'src/app/(app)/layout.tsx',
  'src/components/layout/topbar.tsx',
]

async function main() {
  const startedAt = new Date()
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const fs = await import('node:fs/promises')
  const supplyPage = await fs.readFile('src/app/(app)/supplies/page.tsx', 'utf8')
  const supplyPageGate = supplyPage.match(/requirePageAccess\('([^']+)'\)/)?.[1] ?? null
  const alertGated: string[] = []
  for (const file of [...ALERT_SURFACES, 'src/app/(app)/supplies/page.tsx', 'src/lib/nav.ts']) {
    if (/'alerts\.receive'/.test(await fs.readFile(file, 'utf8'))) alertGated.push(file)
  }
  const storedOverrides = (
    await prismaUnscoped.organization.findMany({ select: { slug: true, settings: true } })
  ).map((entry) => ({ slug: entry.slug, permissions: resolveOrgPermissions(entry.settings) }))

  // -------------------------------------------------------------------------
  console.log('\nWhere it lives, and who may touch it\n')
  // -------------------------------------------------------------------------

  const supplies = NAV_ITEMS.find((item) => item.href === '/supplies')
  check('Supplies is a top-level nav item', supplies?.label === 'Supplies')
  // The intent is that consumables are not buried at the bottom of the nav —
  // they were, and a stockroom nobody can find is a stockroom nobody counts.
  //
  // Stated structurally rather than as a distance, because the distance keeps
  // growing for good reasons: Kits & bags and Places both went in between, and
  // both are views of the same inventory. So what is actually asserted is that
  // Supplies still sits in the inventory block, before the operational screens
  // — a rule that survives the next view being added, where "within two of
  // Inventory" would have to be edited again.
  const labels = NAV_ITEMS.map((item) => item.label)
  const suppliesAt = NAV_ITEMS.findIndex((item) => item.href === '/supplies')
  const inventoryAt = NAV_ITEMS.findIndex((item) => item.href === '/inventory')
  const operationsAt = NAV_ITEMS.findIndex((item) => item.href === '/rentals')
  const INVENTORY_VIEWS = ['/inventory', '/areas', '/containers', '/supplies']
  check(
    'sitting in the inventory block rather than at the end',
    suppliesAt > inventoryAt &&
      suppliesAt < operationsAt &&
      NAV_ITEMS.slice(inventoryAt, suppliesAt).every((item) =>
        INVENTORY_VIEWS.includes(item.href),
      ),
    labels.join(' · '),
  )
  check(
    'gated on its own consumable.view, not borrowed from alerts',
    supplies!.permission === 'consumable.view' && supplyPageGate === 'consumable.view',
  )
  check(
    'nothing outside the alert feed is gated on alerts.receive',
    alertGated.every((file) => ALERT_SURFACES.includes(file)) &&
      ALERT_SURFACES.every((file) => alertGated.includes(file)),
    alertGated.join(', '),
  )
  check(
    'supervisors read, admins manage, techs take through grab',
    can('MANAGER', 'consumable.view') &&
      !can('TECHNICIAN', 'consumable.view') &&
      can('ADMIN', 'consumable.manage') &&
      !can('MANAGER', 'consumable.manage') &&
      can('TECHNICIAN', 'consumable.take'),
    `view=${PERMISSIONS['consumable.view'].join('/')} manage=${PERMISSIONS['consumable.manage'].join('/')}`,
  )
  check(
    'no org override this would strand',
    storedOverrides.every((entry) => Object.keys(entry.permissions).length === 0),
  )

  // -------------------------------------------------------------------------
  console.log('\nThe model: a count belongs to a shelf, not to the fleet\n')
  // -------------------------------------------------------------------------

  const columns = await prismaUnscoped.$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'Consumable'
  `
  const names = columns.map((column) => column.column_name)
  check(
    'Consumable holds no count of its own any more',
    !names.includes('onHand') && !names.includes('reorderPoint'),
    names.join(', '),
  )
  check(
    'it gained the lot-tracking flags instead',
    names.includes('lotTracked') && names.includes('expiryLeadDays'),
  )

  const offices = await db.location.findMany({
    where: { active: true, type: { in: ['WAREHOUSE', 'OFFICE'] } },
    orderBy: { name: 'asc' },
  })
  if (offices.length < 2) throw new Error('need at least two offices to prove per-office stock')
  const [officeA, officeB] = offices

  // --- fixtures ------------------------------------------------------------
  const cleanup: string[] = []
  const restoreHome: { id: string; homeLocationId: string | null }[] = []

  const calGas = await prismaUnscoped.consumable.create({
    data: { orgId: org.id, name: ITEM, unit: 'cylinder', lotTracked: true, expiryLeadDays: 30 },
  })
  cleanup.push(calGas.id)
  const gloves = await prismaUnscoped.consumable.create({
    data: { orgId: org.id, name: PLAIN, unit: 'box', lotTracked: false },
  })
  cleanup.push(gloves.id)

  // Plain stock at two offices, with different reorder points — the warehouse
  // carries a case, the satellite carries two.
  for (const [office, onHand, reorderPoint] of [
    [officeA, 10, 3],
    [officeB, 4, 3],
  ] as const) {
    await prismaUnscoped.consumableStock.create({
      data: {
        orgId: org.id,
        consumableId: gloves.id,
        locationId: office.id,
        onHand,
        reorderPoint,
      },
    })
  }

  const browser = await chromium.launch()

  try {
    const admin = await signIn(browser, 'ray@teksolv.com')
    const errors: string[] = []
    admin.on('pageerror', (error) => errors.push(error.message))

    // -----------------------------------------------------------------------
    console.log('\nPART A — a grab draws down one office, not the fleet\n')
    // -----------------------------------------------------------------------

    const tech = await prismaUnscoped.user.findFirstOrThrow({
      where: { email: 'dreyes@teksolv.com' },
    })
    const techMembership = await prismaUnscoped.membership.findFirstOrThrow({
      where: { userId: tech.id, orgId: org.id },
    })
    restoreHome.push({ id: techMembership.id, homeLocationId: techMembership.homeLocationId })

    // No home office yet: the form must ask rather than guess.
    await prismaUnscoped.membership.update({
      where: { id: techMembership.id },
      data: { homeLocationId: null },
    })

    const techPage = await signIn(browser, 'dreyes@teksolv.com')
    await techPage.goto(`${BASE}/grab`, { waitUntil: 'networkidle' })
    const officeSelect = techPage.locator('select').filter({ hasText: 'Which office?' }).first()
    check(
      'a worker with no home office is asked which one',
      (await officeSelect.count()) === 1 && (await officeSelect.inputValue()) === '',
      'nothing pre-picked — a wrong default silently decrements the wrong building',
    )
    check(
      'and no shelf is shown until they pick',
      (await techPage.locator('main').innerText()).includes('Pick an office to see'),
    )

    // Give them office A and reload: it should now be their default.
    await prismaUnscoped.membership.update({
      where: { id: techMembership.id },
      data: { homeLocationId: officeA.id },
    })
    await techPage.goto(`${BASE}/grab`, { waitUntil: 'networkidle' })
    check(
      'with a home office set, that office is the default',
      (await techPage.locator('select').filter({ hasText: 'Which office?' }).first().inputValue()) ===
        officeA.id,
      officeA.name,
    )

    const beforeA = 10
    const beforeB = 4
    await techPage.locator(`button[aria-label="One more ${PLAIN}"]`).click()
    await techPage.locator(`button[aria-label="One more ${PLAIN}"]`).click()
    await techPage.fill('input[name="destination"]', 'SUPPLYTEST Pad')
    await techPage.click('button:has-text("Record & alert manager")')
    await techPage.waitForURL('**/grab?done=1', { timeout: 45_000 })

    const stockA = await prismaUnscoped.consumableStock.findFirstOrThrow({
      where: { consumableId: gloves.id, locationId: officeA.id },
    })
    const stockB = await prismaUnscoped.consumableStock.findFirstOrThrow({
      where: { consumableId: gloves.id, locationId: officeB.id },
    })
    check(
      'the grabbing office is drawn down',
      stockA.onHand === beforeA - 2,
      `${officeA.name}: ${beforeA} → ${stockA.onHand}`,
    )
    check(
      'and the other office is untouched',
      stockB.onHand === beforeB,
      `${officeB.name}: still ${stockB.onHand}`,
    )

    const grabTxn = await prismaUnscoped.consumableTxn.findFirst({
      where: { consumableId: gloves.id, destination: 'SUPPLYTEST Pad' },
    })
    check(
      'the ledger row records which shelf moved',
      grabTxn?.locationId === officeA.id && grabTxn?.qtyDelta === -2,
      `${grabTxn?.qtyDelta} at ${officeA.name}`,
    )

    // -----------------------------------------------------------------------
    console.log('\nLow stock is per (item, office), and the digest says so\n')
    // -----------------------------------------------------------------------

    // Office A is now at 8 against a line of 3; take it under.
    await prismaUnscoped.consumableStock.update({
      where: { id: stockA.id },
      data: { onHand: 3, alertedAt: null, alertedState: null },
    })

    const cronUrl = `${BASE}/api/cron/notifications${
      process.env.CRON_SECRET ? `?key=${encodeURIComponent(process.env.CRON_SECRET)}` : ''
    }`
    const firstRun = await fetch(cronUrl)
    const firstBody = (await firstRun.json()) as { lowStock?: number }

    const lowAlert = await prismaUnscoped.notification.findFirst({
      where: {
        orgId: org.id,
        entityId: gloves.id,
        createdAt: { gte: startedAt },
        title: { contains: 'low on' },
      },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'the digest alerts on a low office without anybody opening the page',
      firstRun.ok && Boolean(lowAlert),
      lowAlert?.title ?? `lowStock=${firstBody.lowStock}`,
    )
    check(
      'and it names the office, because that is who has to order',
      lowAlert?.title?.includes(officeA.name) ?? false,
      lowAlert?.title ?? undefined,
    )
    check(
      'the other office, which is not low, is not alerted about',
      !(lowAlert?.title?.includes(officeB.name) ?? true),
    )

    const claimed = await prismaUnscoped.consumableStock.findUniqueOrThrow({
      where: { id: stockA.id },
    })
    check(
      'the shelf is claimed so "still low" does not re-announce every run',
      claimed.alertedState === 'low' && claimed.alertedAt !== null,
    )

    const before2nd = await prismaUnscoped.notification.count({
      where: { orgId: org.id, entityId: gloves.id, title: { contains: 'low on' } },
    })
    await fetch(cronUrl)
    const after2nd = await prismaUnscoped.notification.count({
      where: { orgId: org.id, entityId: gloves.id, title: { contains: 'low on' } },
    })
    check('a second run stays quiet about it', after2nd === before2nd, `${before2nd} → ${after2nd}`)


    // -----------------------------------------------------------------------
    console.log('\nThe two header dialogs cannot overlap\n')
    // -----------------------------------------------------------------------
    //
    // They used to be independent popovers pinned bottom-right, each holding
    // its own open flag, so both could be showing at once on top of each other.
    // The fix is one piece of state above both plus a real scrim.

    const dialogs = () => admin.locator('[role="dialog"]')

    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    check('no dialog is open to begin with', (await dialogs().count()) === 0)

    await admin.getByRole('button', { name: /Add an item/i }).click()
    await admin.waitForTimeout(300)
    check(
      'Add item opens as a modal dialog',
      (await dialogs().count()) === 1 &&
        (await admin.locator('[role="dialog"][aria-modal="true"]').count()) === 1,
      'role=dialog, aria-modal=true — the ⌘K palette pattern, not a bare popover',
    )

    // The *panel*, not the dialog element — that outer node is the full-viewport
    // scrim, and measuring it would centre trivially and prove nothing.
    const panelBox = await admin.locator('[role="dialog"] > div').first().boundingBox()
    const viewport = admin.viewportSize()!
    check(
      'the panel is centered, not pinned to the bottom-right corner',
      Boolean(panelBox) &&
        panelBox!.width < viewport.width * 0.75 &&
        Math.abs(panelBox!.x + panelBox!.width / 2 - viewport.width / 2) < 24 &&
        panelBox!.y < viewport.height / 2,
      panelBox
        ? `panel x=${Math.round(panelBox.x)} w=${Math.round(panelBox.width)} y=${Math.round(
            panelBox.y,
          )} in ${viewport.width}×${viewport.height}`
        : 'no panel',
    )

    const scrim = await admin.evaluate(() => {
      const node = document.querySelector('[role="dialog"]')
      if (!node) return null
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        position: style.position,
        covers: rect.width >= window.innerWidth && rect.height >= window.innerHeight,
        tinted: style.backgroundColor,
        zIndex: style.zIndex,
      }
    })
    check(
      'behind a scrim that covers the page',
      scrim?.position === 'fixed' && scrim.covers === true && scrim.tinted !== 'rgba(0, 0, 0, 0)',
      `${scrim?.position}, covers=${scrim?.covers}, ${scrim?.tinted}, z=${scrim?.zIndex}`,
    )

    // The heart of the bug: reach for the other trigger while this one is open.
    // The scrim is over it, so a normal click cannot land — which is the point.
    const blocked = await admin
      .getByRole('button', { name: /Receive stock/i })
      .click({ timeout: 1500 })
      .then(() => false)
      .catch(() => true)
    check(
      'the scrim blocks the other trigger while a dialog is open',
      blocked,
      'a real click cannot reach it — no second dialog can be summoned',
    )

    // And if it is triggered anyway, the state above both still allows only one.
    await admin.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Receive stock'),
      )
      button?.click()
    })
    await admin.waitForTimeout(400)
    check(
      'and forcing it through still leaves exactly one dialog',
      (await dialogs().count()) === 1,
      `${await dialogs().count()} open`,
    )
    const swapped = await admin.locator('[role="dialog"]').first().innerText()
    check(
      'the new one replaces the old rather than stacking on it',
      swapped.includes('Receive stock') && !swapped.includes('New supply item'),
      'opening either closes whatever was open',
    )

    // Never on top of each other, from either direction.
    check(
      'Add item is gone from the page entirely',
      (await admin.locator('[role="dialog"]').filter({ hasText: 'New supply item' }).count()) === 0,
    )

    await admin.keyboard.press('Escape')
    await admin.waitForTimeout(300)
    check('Escape closes it', (await dialogs().count()) === 0)

    await admin.getByRole('button', { name: /Receive stock/i }).click()
    await admin.waitForTimeout(300)
    await admin.mouse.click(8, 8)
    await admin.waitForTimeout(300)
    check('and a click on the scrim closes it', (await dialogs().count()) === 0)

    // Both dialogs, one at a time, in the other order too.
    await admin.getByRole('button', { name: /Receive stock/i }).click()
    await admin.waitForTimeout(300)
    await admin.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        node.textContent?.includes('Add an item'),
      )
      button?.click()
    })
    await admin.waitForTimeout(400)
    const reverse = await admin.locator('[role="dialog"]').first().innerText()
    check(
      'the same holds opening Add item from Receive stock',
      (await dialogs().count()) === 1 && reverse.includes('New supply item'),
      `${await dialogs().count()} open`,
    )
    await admin.keyboard.press('Escape')
    await admin.waitForTimeout(300)


    // -----------------------------------------------------------------------
    console.log('\nAdd item never asks for a lot; Receive always does\n')
    // -----------------------------------------------------------------------
    //
    // The division of labour: an item is a thing the org tracks, a lot is one
    // delivery of it, and an item collects many lots over time. So Add item
    // must not offer lot fields at all, and Receive must offer them for exactly
    // the items that have lots.

    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.getByRole('button', { name: /Add an item/i }).click()
    await admin.waitForTimeout(300)
    const addForm = admin.locator('[role="dialog"]')
    check(
      'Add item has no lot number, expiry, quantity or office field',
      (await addForm.locator('input[name="lotNumber"]').count()) === 0 &&
        (await addForm.locator('input[name="expiresAt"]').count()) === 0 &&
        (await addForm.locator('input[name="quantity"]').count()) === 0 &&
        (await addForm.locator('select[name="locationId"]').count()) === 0,
      'an item is not a delivery',
    )
    check(
      'and it says where lots are entered instead, so nobody hunts for them',
      (await addForm.innerText()).includes('Receive stock'),
    )

    // --- polish, asserted rather than eyeballed ---------------------------
    const unitField = admin.locator('[role="dialog"] label:has(input[name="unit"])')
    const layout = await unitField.evaluate((node) => {
      const label = node.querySelector('span')
      const input = node.querySelector('input')
      return {
        labelLines: label ? Math.round(label.getBoundingClientRect().height / 16) : 0,
        labelText: label?.textContent ?? '',
        placeholder: input?.getAttribute('placeholder') ?? '',
      }
    })
    check(
      'the Unit caption no longer wraps beside its label',
      layout.labelLines <= 1 && !layout.labelText.includes('what one of them is'),
      `label reads "${layout.labelText.trim()}", placeholder "${layout.placeholder}"`,
    )

    const badges = await admin.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return null
      const text = (dialog as HTMLElement).innerText
      const marks = dialog.querySelectorAll('[aria-label="required"]')
      return {
        chips: (text.match(/REQUIRED/g) ?? []).length,
        optional: (text.match(/\boptional\b/g) ?? []).length,
        asterisks: marks.length,
      }
    })
    check(
      'REQUIRED chips are gone, replaced by a quiet asterisk',
      badges?.chips === 0 && (badges?.asterisks ?? 0) >= 2,
      `${badges?.asterisks} asterisks, ${badges?.chips} chips, ${badges?.optional} "optional" captions`,
    )

    await admin.keyboard.press('Escape')
    await admin.waitForTimeout(250)

    // --- Receive, for a lot-tracked item -----------------------------------
    await admin.getByRole('button', { name: /Receive stock/i }).click()
    await admin.locator('select[name="consumableId"]').selectOption({ label: ITEM })
    await admin.waitForTimeout(300)
    const lotDialog = admin.locator('[role="dialog"]')
    check(
      'Receive asks a lot-tracked item for lot number, expiry, quantity and office',
      (await lotDialog.locator('input[name="lotNumber"]').isVisible()) &&
        (await lotDialog.locator('input[name="expiresAt"]').isVisible()) &&
        (await lotDialog.locator('input[name="quantity"]').isVisible()) &&
        (await lotDialog.locator('select[name="locationId"]').isVisible()),
    )
    // Measured on a field that actually carries a hint. The old layout put it
    // beside the label, competing for the same line — which is what wrapped.
    const hinted = await admin
      .locator('[role="dialog"] label:has(input[name="lotNumber"])')
      .evaluate((node) => {
        const input = node.querySelector('input')!
        const hint = [...node.querySelectorAll('span')].find((span) =>
          span.textContent?.includes('stamped on'),
        )
        if (!hint) return null
        return {
          text: hint.textContent ?? '',
          belowInput: hint.getBoundingClientRect().top >= input.getBoundingClientRect().bottom - 1,
        }
      })
    check(
      'a hint sits under its field rather than competing with the label',
      hinted?.belowInput === true,
      `"${hinted?.text}" renders below the input`,
    )

    check(
      'and both lot fields are marked required, not optional extras',
      (await lotDialog
        .locator('label:has(input[name="lotNumber"]) [aria-label="required"]')
        .count()) === 1 &&
        (await lotDialog
          .locator('label:has(input[name="expiresAt"]) [aria-label="required"]')
          .count()) === 1,
    )

    // --- and for one that is not -------------------------------------------
    await admin.locator('select[name="consumableId"]').selectOption({ label: PLAIN })
    await admin.waitForTimeout(300)
    check(
      'switching to a non-lot item hides the lot fields entirely',
      (await lotDialog.locator('input[name="lotNumber"]').count()) === 0 &&
        (await lotDialog.locator('input[name="expiresAt"]').count()) === 0 &&
        (await lotDialog.locator('input[name="quantity"]').isVisible()),
      'quantity and office remain — those are true of every delivery',
    )
    await admin.keyboard.press('Escape')
    await admin.waitForTimeout(250)

    // -----------------------------------------------------------------------
    console.log('\nA brand-new item points at its first lot\n')
    // -----------------------------------------------------------------------

    const fresh = await prismaUnscoped.consumable.create({
      data: {
        orgId: org.id,
        name: 'SUPPLYTEST Fresh cal gas',
        unit: 'cylinder',
        lotTracked: true,
        expiryLeadDays: 30,
      },
    })
    cleanup.push(fresh.id)

    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })

    // The list is a table now, and the detail lives in a panel rather than
    // inside the row — so the row carries the summary and the panel carries
    // the guidance. Both claims below are the same as before; only where they
    // are read has moved.
    const freshRow = admin.locator('tbody tr').filter({ hasText: 'SUPPLYTEST Fresh cal gas' }).first()
    const freshText = await freshRow.innerText()
    check(
      'an unstocked item reads "none yet" rather than a bare zero',
      /none yet/i.test(freshText) && /not stocked/i.test(freshText),
      'a 0 looks like a count somebody took to zero; this looks like something to do',
    )
    check(
      'and the "not stocked" filter finds it without hunting',
      await admin
        .getByRole('button', { name: /Not stocked \d+/ })
        .isEnabled(),
      'the one chip that answers "what has nobody put on a shelf yet"',
    )

    await freshRow.click()
    const freshPanel = admin.locator('[role="dialog"]')
    await freshPanel.waitFor({ state: 'visible', timeout: 10_000 })
    const freshOpen = await freshPanel.innerText()
    check(
      'and its panel says exactly where lots are entered',
      freshOpen.includes('No stock yet.') && freshOpen.toLowerCase().includes('lot number'),
      'no hunting for lot fields on Add item',
    )

    // The nudge is a working button, not just a sentence.
    await freshPanel.getByRole('button', { name: /Add first lot/i }).click()
    await admin.waitForTimeout(400)
    check(
      'its "Add first lot" button opens Receive with that item chosen',
      (await admin.locator('select[name="consumableId"]').inputValue()) === fresh.id,
      'no hunting, and no picking the wrong item out of the list',
    )
    check(
      'showing the lot fields straight away',
      (await admin.locator('input[name="lotNumber"]').isVisible()) &&
        (await admin.locator('input[name="expiresAt"]').isVisible()),
    )

    // Fill it in and confirm the lot is what actually gets created.
    await admin.locator('select[name="locationId"]').selectOption(officeB.id)
    await admin.fill('input[name="quantity"]', '3')
    await admin.fill('input[name="lotNumber"]', 'FIRST-001')
    await admin.fill('input[name="expiresAt"]', iso(day(120))!)
    await admin.getByRole('button', { name: /^Receive$/i }).click()
    await admin.waitForTimeout(2000)

    const firstLot = await prismaUnscoped.consumableLot.findFirst({
      where: { consumableId: fresh.id },
    })
    check(
      'and receiving it creates the lot with its number and date',
      firstLot?.lotNumber === 'FIRST-001' &&
        firstLot?.quantity === 3 &&
        iso(firstLot?.expiresAt) === iso(day(120)),
      `${firstLot?.lotNumber} ×${firstLot?.quantity} exp ${iso(firstLot?.expiresAt)}`,
    )
    check(
      'the item is no longer an empty shell',
      (
        await prismaUnscoped.consumableStock.findFirstOrThrow({
          where: { consumableId: fresh.id, locationId: officeB.id },
        })
      ).onHand === 3,
    )

    // A non-lot item gets the same nudge without the lot wording.
    const freshPlain = await prismaUnscoped.consumable.create({
      data: { orgId: org.id, name: 'SUPPLYTEST Fresh gloves', unit: 'box', lotTracked: false },
    })
    cleanup.push(freshPlain.id)
    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    await admin.locator('tbody tr').filter({ hasText: 'SUPPLYTEST Fresh gloves' }).first().click()
    const plainPanel = admin.locator('[role="dialog"]')
    await plainPanel.waitFor({ state: 'visible', timeout: 10_000 })
    const plainFresh = await plainPanel.innerText()
    check(
      'a non-lot item says receive it into an office, with no mention of lots',
      plainFresh.includes('No stock yet.') &&
        plainFresh.includes('Receive it into an office') &&
        plainFresh.includes('Add first stock') &&
        !plainFresh.toLowerCase().includes('lot number'),
      'the nudge matches the item, and its button does not share a name with the header one',
    )

    // -----------------------------------------------------------------------
    console.log('\nPART B — two lots, two dates, and the order they go out in\n')
    // -----------------------------------------------------------------------

    // Received through the real form, because the lot fields only appear for a
    // lot-tracked item and that is half of what is being checked.
    await admin.keyboard.press('Escape')
    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.getByRole('button', { name: /Receive stock/i }).click()
    await admin.locator('select[name="consumableId"]').selectOption({ label: ITEM })
    await admin.waitForTimeout(300)
    check(
      'a lot-tracked item asks for a lot number and an expiry',
      (await admin.locator('input[name="lotNumber"]').isVisible()) &&
        (await admin.locator('input[name="expiresAt"]').isVisible()),
    )

    // Lot NEAR expires in 20 days; lot FAR in 300. NEAR is received *second*,
    // so drawing it first proves FEFO rather than insertion order.
    for (const [lotNumber, days, quantity] of [
      ['FAR-001', 300, 5],
      ['NEAR-001', 20, 2],
    ] as const) {
      await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
      await admin.getByRole('button', { name: /Receive stock/i }).click()
      await admin.locator('select[name="consumableId"]').selectOption({ label: ITEM })
      await admin.locator('select[name="locationId"]').selectOption(officeA.id)
      await admin.fill('input[name="quantity"]', String(quantity))
      await admin.fill('input[name="lotNumber"]', lotNumber)
      await admin.fill('input[name="expiresAt"]', iso(day(days))!)
      await admin.getByRole('button', { name: /^Receive$/i }).click()
      await admin.waitForTimeout(2000)
    }

    const lots = await prismaUnscoped.consumableLot.findMany({
      where: { consumableId: calGas.id, locationId: officeA.id },
      orderBy: { lotNumber: 'asc' },
    })
    check(
      'both lots landed with their own dates and quantities',
      lots.length === 2 &&
        lots.find((lot) => lot.lotNumber === 'NEAR-001')?.quantity === 2 &&
        lots.find((lot) => lot.lotNumber === 'FAR-001')?.quantity === 5,
      lots.map((lot) => `${lot.lotNumber}×${lot.quantity} exp ${iso(lot.expiresAt)}`).join(' · '),
    )

    const calStock = await prismaUnscoped.consumableStock.findFirstOrThrow({
      where: { consumableId: calGas.id, locationId: officeA.id },
    })
    check(
      'on hand is the sum of the lots',
      calStock.onHand === 7,
      `${calStock.onHand} = 2 + 5`,
    )

    // Receiving must go through the ledger like everything else.
    check(
      'each receipt wrote a ledger row naming its lot',
      (await prismaUnscoped.consumableTxn.count({
        where: { consumableId: calGas.id, reason: 'RESTOCK', lotId: { not: null } },
      })) === 2,
    )

    // --- FEFO, through a real grab ----------------------------------------
    await techPage.goto(`${BASE}/grab?office=${officeA.id}`, { waitUntil: 'networkidle' })
    const nextLotLine = await techPage.locator('main').innerText()
    check(
      'the picker tells the worker which cylinder they will be handed',
      nextLotLine.includes('NEAR-001'),
      'the soonest-expiring one',
    )

    await techPage.locator(`button[aria-label="One more ${ITEM}"]`).click()
    await techPage.fill('input[name="destination"]', 'SUPPLYTEST FEFO')
    await techPage.click('button:has-text("Record & alert manager")')
    await techPage.waitForURL('**/grab?done=1', { timeout: 45_000 })

    const afterFefo = await prismaUnscoped.consumableLot.findMany({
      where: { consumableId: calGas.id, locationId: officeA.id },
    })
    const near = afterFefo.find((lot) => lot.lotNumber === 'NEAR-001')!
    const far = afterFefo.find((lot) => lot.lotNumber === 'FAR-001')!
    check(
      'the grab drew from the soonest-expiring lot',
      near.quantity === 1 && far.quantity === 5,
      `NEAR ${near.quantity}, FAR ${far.quantity}`,
    )
    const fefoTxn = await prismaUnscoped.consumableTxn.findFirst({
      where: { consumableId: calGas.id, destination: 'SUPPLYTEST FEFO' },
      include: { lot: true },
    })
    check(
      'and the ledger records which lot went out',
      fefoTxn?.lot?.lotNumber === 'NEAR-001',
      'a month later, "which cylinder did that calibration use" has an answer',
    )

    // --- the expiry warning ------------------------------------------------
    // Inside its 30-day lead window, so the digest should warn while there is
    // still time to order a replacement.
    const warned = await fetch(cronUrl)
    const expiringAlert = await prismaUnscoped.notification.findFirst({
      where: { orgId: org.id, entityId: near.id, createdAt: { gte: startedAt } },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'the digest warns before the near lot expires',
      warned.ok && Boolean(expiringAlert) && expiringAlert!.title.includes('expires in'),
      expiringAlert?.title ?? undefined,
    )
    check(
      'naming the lot, the office and how long is left',
      (expiringAlert?.title?.includes('NEAR-001') ?? false) &&
        (expiringAlert?.body?.includes(officeA.name) ?? false),
      expiringAlert?.body ?? undefined,
    )
    check(
      'the far lot, comfortably in date, is not warned about',
      (await prismaUnscoped.notification.count({
        where: { orgId: org.id, entityId: far.id },
      })) === 0,
    )

    // --- and once it lapses ------------------------------------------------
    await prismaUnscoped.consumableLot.update({
      where: { id: near.id },
      data: { expiresAt: day(-1) },
    })

    const expiredRun = await fetch(cronUrl)
    const expiredAlert = await prismaUnscoped.notification.findFirst({
      where: { orgId: org.id, entityId: near.id, title: { contains: 'has expired' } },
    })
    check(
      'and again, separately, once it has actually lapsed',
      expiredRun.ok && Boolean(expiredAlert),
      expiredAlert?.title ?? undefined,
    )
    // Counted by distinct *title*, not by row: `notifyManagers` writes one
    // notification per manager, so a row count measures the size of the roster
    // rather than the number of things announced.
    const lotAlerts = await prismaUnscoped.notification.findMany({
      where: { orgId: org.id, entityId: near.id },
      select: { title: true },
    })
    const stages = [...new Set(lotAlerts.map((alert) => alert.title))]
    check(
      'the two stages are distinct alerts, not one repeated',
      stages.length === 2 &&
        stages.some((title) => title.includes('expires in')) &&
        stages.some((title) => title.includes('has expired')),
      `${stages.length} stages across ${lotAlerts.length} recipients — warned while there was time, then told when there was not`,
    )

    // The heart of the feature: an expired cylinder must not go out.
    await techPage.goto(`${BASE}/grab?office=${officeA.id}`, { waitUntil: 'networkidle' })
    const shelfNow = await techPage.locator('main').innerText()
    check(
      'the picker offers only in-date stock',
      shelfNow.includes('5 available') && shelfNow.includes('1 expired on the shelf'),
      'on hand 6, issuable 5',
    )
    check(
      'and points at the next in-date lot instead',
      shelfNow.includes('FAR-001') && !shelfNow.includes('next: lot NEAR-001'),
    )

    // Try to take all six anyway — the server has to refuse.
    const refusal = await db.consumableLot.findMany({
      where: { consumableId: calGas.id, locationId: officeA.id, quantity: { gt: 0 } },
    })
    check(
      'planning an issue that needs the expired lot is refused outright',
      planIssue(refusal, 6) === null && planIssue(refusal, 5) !== null,
      'a partial issue would be worse than a clear "there is not enough"',
    )
    check(
      'the expired lot is not in the issue order at all',
      !fefoOrder(refusal).some((lot) => lot.id === near.id) &&
        lotState({ expiresAt: day(-1), quantity: 1 }) === 'expired',
    )

    // -----------------------------------------------------------------------
    console.log('\nA non-lot-tracked item shows none of this\n')
    // -----------------------------------------------------------------------

    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.getByRole('button', { name: /Receive stock/i }).click()
    await admin.locator('select[name="consumableId"]').selectOption({ label: PLAIN })
    await admin.waitForTimeout(300)
    check(
      'receiving it asks for no lot number and no expiry',
      (await admin.locator('input[name="lotNumber"]').count()) === 0 &&
        (await admin.locator('input[name="expiresAt"]').count()) === 0,
      'a lot number box on a packet of gloves is a field somebody learns to ignore',
    )
    await admin.keyboard.press('Escape')

    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    await admin.locator('tbody tr').filter({ hasText: PLAIN }).first().click()
    // Scoped to this item's own panel. Reading the whole page would pick up the
    // movement ledger, which prints lot dates for *other* items and would fail
    // this for the wrong reason.
    const plainRow = await admin.locator('[role="dialog"]').innerText()
    check(
      'and its rows carry no lots — just a count per office',
      !plainRow.includes('exp ') &&
        !plainRow.toLowerCase().includes('lots') &&
        plainRow.includes(officeA.name) &&
        plainRow.includes(officeB.name),
      `${officeA.name} and ${officeB.name} listed, no lot column`,
    )

    await admin.keyboard.press('Escape')
    await admin.goto(`${BASE}/supplies`, { waitUntil: 'networkidle' })
    await admin.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
    await admin.locator('tbody tr').filter({ hasText: ITEM }).first().click()
    const lotRow = await admin.locator('[role="dialog"]').innerText()
    check(
      'while the lot-tracked item shows its lots and dates',
      lotRow.includes('FAR-001') && lotRow.includes('NEAR-001') && lotRow.includes('expired'),
    )

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    for (const entry of restoreHome) {
      await prismaUnscoped.membership.update({
        where: { id: entry.id },
        data: { homeLocationId: entry.homeLocationId },
      })
    }
    for (const id of cleanup) {
      await prismaUnscoped.notification.deleteMany({
        where: { orgId: org.id, entityId: { in: [id] } },
      })
      const lotIds = (
        await prismaUnscoped.consumableLot.findMany({
          where: { consumableId: id },
          select: { id: true },
        })
      ).map((lot) => lot.id)
      if (lotIds.length) {
        await prismaUnscoped.notification.deleteMany({ where: { entityId: { in: lotIds } } })
      }
      await prismaUnscoped.consumableTxn.deleteMany({ where: { consumableId: id } })
      await prismaUnscoped.consumableLot.deleteMany({ where: { consumableId: id } })
      await prismaUnscoped.consumableStock.deleteMany({ where: { consumableId: id } })
      await prismaUnscoped.consumable.deleteMany({ where: { id } })
    }
    await prismaUnscoped.rental.deleteMany({ where: { destination: { startsWith: 'SUPPLYTEST' } } })
    await prismaUnscoped.notification.deleteMany({
      where: { orgId: org.id, createdAt: { gte: startedAt }, body: { contains: 'SUPPLYTEST' } },
    })
    console.log(`\n(removed ${cleanup.length} test item(s) and restored home offices)`)
  }

  console.log(failures === 0 ? '\nAll supplies checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
