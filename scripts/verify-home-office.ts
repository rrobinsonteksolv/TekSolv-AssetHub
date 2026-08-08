/**
 * Home office: who can set whose, and what it defaults.
 *
 * The action to set one existed with **no screen wired to it** — gated on
 * `user.manage`, callable by nobody. So when the warehouse five people were
 * homed at turned out to be test data, they were left with no home office and
 * no way to fix it, including the owner account.
 *
 * Three things are worth holding still. That an admin can set anyone's and a
 * person can set their own — the second matters, because routing "fix my own
 * default" through an administrator is what makes people stop bothering. That
 * somebody who is *not* an admin still cannot set somebody else's. And that the
 * grab form defaults to it when set and keeps asking when it is not, because
 * unset is a real state and forms that assume otherwise break at 6am.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-home-office.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listHomeOffices } from '../src/server/actions/settings'
import { listStockLocations, listSupplies } from '../src/lib/supplies-queries'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

const ADMIN = 'ray@teksolv.com'
const TECH = 'dreyes@teksolv.com'

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

const homeOf = (userId: string) =>
  prismaUnscoped.membership
    .findFirstOrThrow({ where: { userId }, select: { homeLocationId: true } })
    .then((row) => row.homeLocationId)

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const admin = await prismaUnscoped.user.findFirstOrThrow({ where: { email: ADMIN } })
  const tech = await prismaUnscoped.user.findFirstOrThrow({ where: { email: TECH } })
  const before = {
    admin: await homeOf(admin.id),
    tech: await homeOf(tech.id),
  }

  /**
   * Everybody's home office before this runs.
   *
   * Restoring only the two people the suite *means* to touch is how it quietly
   * moved four others and left them there: a roster screen is a list of nearly
   * identical rows, and a locator that drifts one row along does its damage
   * silently. Snapshotting all of them makes the drift assertable and the
   * cleanup total.
   */
  const rosterBefore = new Map(
    (
      await prismaUnscoped.membership.findMany({
        where: { orgId: org.id },
        select: { id: true, userId: true, homeLocationId: true, user: { select: { name: true } } },
      })
    ).map((row) => [row.userId, row]),
  )
  const othersBefore = [...rosterBefore.values()].filter(
    (row) => row.userId !== tech.id && row.userId !== admin.id,
  )

  const offices = await listHomeOffices(db)
  const [first, second] = offices
  let probeConsumable: string | null = null

  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nWhich places can be somebody’s office\n')
    // -----------------------------------------------------------------------

    const stock = await listStockLocations(db)
    check(
      'offices, and only offices',
      offices.length > 0 && offices.every((row) => row.type === 'OFFICE'),
      offices.map((row) => `${row.name} (${row.type})`).join(', '),
    )
    check(
      'a service bay is not one — it has a shelf, nobody is based at it',
      !offices.some((row) => row.type === 'SERVICE_BAY'),
      '“where does stock live” and “where does this person work out of” are different questions',
    )
    check(
      'nor a rescue area',
      !offices.some((row) => row.type === 'RESCUE_AREA'),
      'the Rescue Prop is where gear lives',
    )
    check(
      'but every office offered does hold stock, so the forms it defaults have something to show',
      offices.every((row) => stock.some((entry) => entry.id === row.id)),
      `${offices.length} of ${stock.length} stock locations are offices`,
    )
    check(
      'and the service bay still counts as a stock location',
      stock.some((row) => row.type === 'SERVICE_BAY'),
      'narrowing the home-office list did not narrow where supplies can sit',
    )

    // Not just present in a list — stock actually goes onto its shelf. The two
    // rules are enforced by different queries, and a change to one that
    // silently broke the other is exactly what this is here to catch.
    const bay = stock.find((row) => row.type === 'SERVICE_BAY')
    if (bay) {
      // Cleared first: a run that died before its teardown leaves the name
      // behind, and (orgId, name) is unique — so the next run would fail on the
      // fixture rather than on anything it is testing.
      const stale = await prismaUnscoped.consumable.findFirst({
        where: { orgId: org.id, name: 'HOMETEST bay widgets' },
        select: { id: true },
      })
      if (stale) {
        await prismaUnscoped.consumableStock.deleteMany({ where: { consumableId: stale.id } })
        await prismaUnscoped.consumable.delete({ where: { id: stale.id } })
      }
      const probe = await prismaUnscoped.consumable.create({
        data: { orgId: org.id, name: 'HOMETEST bay widgets', unit: 'each' },
      })
      probeConsumable = probe.id
      await prismaUnscoped.consumableStock.create({
        data: { orgId: org.id, consumableId: probe.id, locationId: bay.id, onHand: 7 },
      })
      const rows = await listSupplies(db, { includeRetired: true })
      const onBayShelf = rows
        .find((row) => row.id === probe.id)
        ?.offices.find((office) => office.locationId === bay.id)
      check(
        'and stock received into it still shows on its shelf',
        onBayShelf?.available === 7,
        `${bay.name}: ${onBayShelf?.available ?? 'nothing'} — it holds stock, it is just not somewhere people are based`,
      )
    }

    // -----------------------------------------------------------------------
    console.log('\nAn admin sets anybody’s\n')
    // -----------------------------------------------------------------------

    await signIn(page, ADMIN)
    await page.goto(`${BASE}/settings/users`, { waitUntil: 'networkidle' })
    await settle(page)

    const techRow = page.locator('div.border-b').filter({ hasText: 'Dave Reyes' }).first()
    await techRow.getByLabel('Home office').selectOption(first.id)
    await page.waitForTimeout(3_000)
    check(
      'picking one on the roster saves it',
      (await homeOf(tech.id)) === first.id,
      `${first.name}`,
    )

    await techRow.getByLabel('Home office').selectOption(second.id)
    await page.waitForTimeout(3_000)
    check('and changing it changes it', (await homeOf(tech.id)) === second.id, `${second.name}`)

    check(
      'and nobody else on the roster moved',
      (
        await Promise.all(
          othersBefore.map(async (row) => (await homeOf(row.userId)) === row.homeLocationId),
        )
      ).every(Boolean),
      `${othersBefore.length} other rows checked — a roster is a list of near-identical rows, and a locator that drifts one along does it silently`,
    )
    check(
      'with an audit row saying who moved whom',
      (await prismaUnscoped.auditLog.count({
        where: { action: 'user.home-office', entityId: tech.id },
      })) >= 2,
      'a roster change is somebody’s decision, not an anonymous state flip',
    )

    // -----------------------------------------------------------------------
    console.log('\nAnd the roster says who has none\n')
    // -----------------------------------------------------------------------

    await prismaUnscoped.membership.updateMany({
      where: { userId: tech.id },
      data: { homeLocationId: null },
    })
    await page.reload({ waitUntil: 'networkidle' })
    await settle(page)
    const rosterText = (await page.locator('main').innerText()).toLowerCase()
    check(
      'an unset home office is called out, not left to be noticed',
      rosterText.includes('no home office') && rosterText.includes('dave reyes'),
      rosterText.split('\n').find((line) => line.includes('no home office')) ?? 'no banner',
    )

    // -----------------------------------------------------------------------
    console.log('\nA person sets their own\n')
    // -----------------------------------------------------------------------

    const techPage = await (await browser.newContext()).newPage()
    await signIn(techPage, TECH)
    await techPage.goto(`${BASE}/settings/profile`, { waitUntil: 'networkidle' })
    await settle(techPage)

    const profileText = (await techPage.locator('main').innerText()).toLowerCase()
    check(
      'a technician can open their own profile',
      profileText.includes('home office'),
      'setting your own default is not an administrative act',
    )
    check('and is told theirs is unset', profileText.includes('no home office set'))

    await techPage.getByLabel('Home office').selectOption(first.id)
    await techPage.waitForTimeout(3_000)
    check(
      'they can set it themselves',
      (await homeOf(tech.id)) === first.id,
      `${first.name} — no administrator needed`,
    )

    check(
      'but the roster screen is still admin-only',
      await techPage
        .goto(`${BASE}/settings/users`, { waitUntil: 'domcontentloaded' })
        .then(async () => {
          await techPage.waitForTimeout(1_000)
          return !techPage.url().includes('/settings/users')
        }),
      techPage.url(),
    )

    // The profile page carries their own id and nobody else's, so there is no
    // control here that could set another person's — the permission check on
    // the server is the backstop, not the only line of defence.
    await techPage.goto(`${BASE}/settings/profile`, { waitUntil: 'networkidle' })
    await settle(techPage)
    const targets = await techPage
      .locator('input[name="userId"]')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))
    check(
      'their profile can only ever set their own',
      targets.length > 0 && targets.every((value) => value === tech.id),
      `${targets.length} form(s), all pointed at themselves`,
    )
    check(
      'and the admin’s own office was untouched throughout',
      (await homeOf(admin.id)) === before.admin,
      'nothing a technician did reached somebody else’s row',
    )

    // -----------------------------------------------------------------------
    console.log('\nWhat a home office actually does\n')
    // -----------------------------------------------------------------------

    await techPage.goto(`${BASE}/grab`, { waitUntil: 'networkidle' })
    await settle(techPage)
    const grabText = await techPage.locator('main').innerText()
    check(
      'the grab form starts at their office rather than asking',
      grabText.includes(first.name),
      `${first.name} — the shelf they are standing at`,
    )

    await prismaUnscoped.membership.updateMany({
      where: { userId: tech.id },
      data: { homeLocationId: null },
    })
    await techPage.goto(`${BASE}/grab`, { waitUntil: 'networkidle' })
    await settle(techPage)
    const noHome = await techPage.locator('main').innerText()
    check(
      'and still asks when they have none',
      /which office|choose an office|pick an office|office/i.test(noHome),
      'unset is a real state — nobody gets blocked at 6am over a roster field',
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    await prismaUnscoped.membership.updateMany({
      where: { userId: tech.id },
      data: { homeLocationId: before.tech },
    })
    await prismaUnscoped.membership.updateMany({
      where: { userId: admin.id },
      data: { homeLocationId: before.admin },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { action: 'user.home-office', entityId: tech.id },
    })
    console.log('\n(home offices restored to how they were found)')
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll home-office checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
