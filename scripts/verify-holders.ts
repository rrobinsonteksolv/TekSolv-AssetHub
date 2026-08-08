/**
 * Non-truck holders, and kits inside them.
 *
 * The claim being tested is that a **holder-location is a holder in the same
 * sense a truck is** — one at a time, mutually exclusive with a person, a
 * truck and out-on-rent, and written through the same `assignCustody` so it
 * leaves the same trail. If that is true, everything built on custody works
 * unchanged: readiness, the single-holder constraint, the audit trail, and the
 * kit-completeness rule.
 *
 * Two real sheets: the Rescue Prop (51 items in four kits) and the Ops Manager
 * Office (42 items, some already retired or held).
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-holders.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listContainers } from '../src/lib/containers'
import { availableInWindow, windowFromNow } from '../src/lib/availability'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

// Named apart from the real places on purpose. The importer resolves a holder
// by name, so a fixture sharing a name with the live Rescue Prop imports into
// it — and the teardown then deletes the real one.
const PROP = 'Rescue Prop (verification)'
const OFFICE = 'Ops Manager Office (verification)'
const PTAG = 'PROPIMP'
const OTAG = 'OFCIMP'

/** The four kits on the prop, and how many items are in each. */
const KITS: [string, number][] = [
  ["George's Red Rigging Bag", 28],
  ['Training Prop', 13],
  ['Harnesses', 7],
  ['Training 4:1 Rope Bag', 3],
]

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

function propCsv(): string {
  const header = ['Asset Tag', 'Model', 'Category', 'Holder', 'Container'].join(',')
  const rows: string[] = []
  let n = 0
  for (const [kit, count] of KITS) {
    for (let index = 0; index < count; index++) {
      n += 1
      rows.push(
        [
          `${PTAG}-${String(n).padStart(3, '0')}`,
          index % 2 === 0 ? 'Rigging Plate' : 'Prusik Cord',
          'Rope Rescue > Rigging',
          PROP,
          kit,
        ].join(','),
      )
    }
  }
  return [header, ...rows].join('\n')
}

function officeCsv(): string {
  const header = ['Asset Tag', 'Model', 'Category', 'Holder', 'Status', 'Comment'].join(',')
  const rows: string[] = []
  for (let index = 0; index < 39; index++) {
    rows.push(
      [
        `${OTAG}-S-${String(index + 1).padStart(2, '0')}`,
        'Spare Lens Kit',
        'Gas Detection',
        OFFICE,
        'ACTIVE',
        'Office spare stock',
      ].join(','),
    )
  }
  rows.push(
    [`${OTAG}-RET-1`, 'Retired Regulator', 'Respiratory', OFFICE, 'RETIRED', 'Discarded — binned'].join(
      ',',
    ),
  )
  for (let index = 0; index < 2; index++) {
    rows.push(
      [
        `${OTAG}-Q-${index + 1}`,
        'Suspect Lanyard',
        'Fall Protection',
        OFFICE,
        'QUARANTINED',
        'Held pending recall check',
      ].join(','),
    )
  }
  return [header, ...rows].join('\n')
}

async function importCsv(page: Page, name: string, csv: string) {
  await page.goto(`${BASE}/inventory/import`, { waitUntil: 'networkidle' })
  await page.setInputFiles('input[type="file"]', {
    name,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  })
  await page.getByRole('button', { name: /Preview import/i }).click()
  await page.waitForTimeout(2_500)
  await page.getByRole('button', { name: /^Import \d+ assets?$/ }).click()
  await page.waitForTimeout(5_000)
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('\nThe Rescue Prop: 51 items in four kits\n')
    // -----------------------------------------------------------------------

    await importCsv(page, 'rescue-prop.csv', propCsv())

    const prop = await db.location.findFirst({ where: { name: PROP } })
    check('the holder was created by the import', prop !== null, PROP)

    const atProp = await db.asset.count({
      where: { custodyType: 'LOCATION', custodyLocationId: prop!.id },
    })
    check('all 51 items are held at it', atProp === 51, `${atProp} of 51`)

    check(
      'as custody, not as a filing detail',
      (await db.asset.count({
        where: { assetTag: { startsWith: PTAG }, custodyType: 'LOCATION' },
      })) === 51,
      'a holder sits in the same exclusive set as a person and a truck',
    )
    check(
      'each with a CustodyEvent, exactly as staging on a truck writes one',
      (await db.custodyEvent.count({
        where: { asset: { assetTag: { startsWith: PTAG } }, locationId: prop!.id },
      })) === 51,
      '“who had it last” answers the same way whichever kind of holder it was',
    )

    const containers = await listContainers(db)
    for (const [kit, count] of KITS) {
      const found = containers.find((entry) => entry.name === kit)
      check(
        `${kit} holds ${count}`,
        found?.members.length === count,
        `${found?.members.length ?? 0} · at ${found?.areaLabel ?? 'nowhere'}`,
      )
    }
    check(
      'and every kit reads complete, since its gear is at its holder',
      KITS.every(([kit]) => containers.find((entry) => entry.name === kit)?.complete === true),
      'completeness compares each item’s custody against the bag’s holder',
    )

    // -----------------------------------------------------------------------
    console.log('\nThe single-holder rule still holds\n')
    // -----------------------------------------------------------------------

    const sample = await db.asset.findFirstOrThrow({
      where: { assetTag: { startsWith: PTAG } },
      select: { id: true, custodyTruckId: true, custodyUserId: true },
    })
    check(
      'a unit held at a holder is on no truck and with no person',
      sample.custodyTruckId === null && sample.custodyUserId === null,
    )

    let refused = false
    try {
      const truck = await prismaUnscoped.truck.findFirstOrThrow({ select: { id: true } })
      await prismaUnscoped.$executeRawUnsafe(
        `UPDATE "Asset" SET "custodyTruckId" = $1 WHERE "id" = $2`,
        truck.id,
        sample.id,
      )
    } catch {
      refused = true
    }
    check(
      'and the database refuses to give it a second holder',
      refused,
      'asset_custody_single_holder — extended rather than left enforcing two kinds out of three',
    )

    // -----------------------------------------------------------------------
    console.log('\nThe office: 42 items, mixed states\n')
    // -----------------------------------------------------------------------

    await importCsv(page, 'ops-manager-office.csv', officeCsv())

    const office = await db.location.findFirst({ where: { name: OFFICE } })
    check('the office holder was created', office !== null, OFFICE)

    const officeUnits = await db.asset.findMany({
      where: { assetTag: { startsWith: OTAG } },
      select: {
        assetTag: true,
        status: true,
        custodyType: true,
        custodyLocationId: true,
        retiredReason: true,
      },
    })
    check('all 42 rows landed', officeUnits.length === 42, `${officeUnits.length}`)

    const spares = officeUnits.filter((unit) => unit.assetTag.includes('-S-'))
    check(
      '39 spares are held at the office',
      spares.length === 39 &&
        spares.every(
          (unit) => unit.custodyType === 'LOCATION' && unit.custodyLocationId === office!.id,
        ),
      `${spares.filter((u) => u.custodyLocationId === office!.id).length} of 39`,
    )

    const retired = officeUnits.find((unit) => unit.assetTag.endsWith('-RET-1'))
    check(
      'the retired one arrived retired, with a disposition',
      retired?.status === 'RETIRED' && retired.retiredReason === 'SCRAPPED',
      `${retired?.status} · ${retired?.retiredReason}`,
    )
    check(
      'and holds nothing — retirement releases custody',
      retired !== undefined &&
        officeUnits.find((u) => u.assetTag.endsWith('-RET-1'))?.custodyType === null,
      'a retired unit is not at the office, it has left the fleet',
    )

    const held = officeUnits.filter((unit) => unit.status === 'QUARANTINED')
    check('two arrived quarantined', held.length === 2, `${held.length}`)
    check(
      'held *at the office*, since a hold does not mean it left',
      held.every((unit) => unit.custodyLocationId === office!.id),
    )
    check(
      'and deployable by nothing',
      (await db.asset.count({
        where: { assetTag: { startsWith: `${OTAG}-Q-` }, ...availableInWindow(windowFromNow(new Date())) },
      })) === 0,
    )

    // -----------------------------------------------------------------------
    console.log('\nHolder does not decide class\n')
    // -----------------------------------------------------------------------

    const propTypes = await db.asset.groupBy({
      by: ['assetType'],
      where: { assetTag: { startsWith: PTAG } },
      _count: true,
    })
    const officeTypes = await db.asset.groupBy({
      by: ['assetType'],
      where: { assetTag: { startsWith: OTAG } },
      _count: true,
    })
    check(
      'the prop’s rope rescue gear classifies RESCUE',
      propTypes.every((row) => row.assetType === 'RESCUE'),
      JSON.stringify(propTypes),
    )
    check(
      'while the office’s gas detection spares classify RENTAL — same kind of holder',
      officeTypes.some((row) => row.assetType === 'RENTAL'),
      `${JSON.stringify(officeTypes)} — class follows the category, never the holder`,
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    const ids = (
      await prismaUnscoped.asset.findMany({
        where: { orgId: org.id, OR: [{ assetTag: { startsWith: PTAG } }, { assetTag: { startsWith: OTAG } }] },
        select: { id: true },
      })
    ).map((row) => row.id)
    if (ids.length) {
      await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: ids } } })
      await prismaUnscoped.notification.deleteMany({ where: { entityId: { in: ids } } })
      await prismaUnscoped.auditLog.deleteMany({ where: { entityId: { in: ids } } })
      await prismaUnscoped.asset.deleteMany({ where: { id: { in: ids } } })
    }
    // Scoped to the fixture's own holders — kit names repeat across places now
    // that a bag is unique per holder rather than per org, so deleting by name
    // alone would take the real Rescue Prop's bags with it.
    await prismaUnscoped.container.deleteMany({
      where: { orgId: org.id, location: { name: { in: [PROP, OFFICE] } } },
    })
    await prismaUnscoped.location.deleteMany({
      where: {
        orgId: org.id,
        name: { in: [PROP, OFFICE] },
        custodyOf: { none: {} },
        assets: { none: {} },
      },
    })
    console.log(`\n(removed ${ids.length} units, four kits and two holders)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll holder checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
