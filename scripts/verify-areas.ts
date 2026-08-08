/**
 * Areas, and kits nested inside them.
 *
 * The claim under test is that **an area is one concept**: a truck and a room
 * answer "what is in here" the same way, list their kits the same way, and give
 * every item in them a real place to point at. Before this, a truck had a
 * loadout page and a room had a name in a dropdown — so fifty-one items landed
 * at the Rescue Prop with nowhere to look at them, which from the outside was
 * indistinguishable from an import that had dropped them.
 *
 * Four things are asserted, in the order somebody would check them by hand:
 * the Areas view lists both kinds; a room area shows its kits with the right
 * counts plus its loose gear; a truck area does the same, through the *same*
 * component; and every item resolves to an area rather than to an em-dash.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-areas.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { areaOfAsset, getArea, listAreas } from '../src/lib/areas'
import { listContainers } from '../src/lib/containers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'

// Named apart from the live Rescue Prop and Ops Manager Office on purpose: the
// importer resolves an area by name, so a fixture sharing a name imports into
// the real one — and the teardown then deletes it.
const PROP = 'Rescue Prop Yard (verification)'
const OFFICE = 'Ops Desk (verification)'
const TAG = 'AREAS'

/** Kits in the room area, and how many items each holds. */
const ROOM_KITS: [string, number][] = [
  ["George's Red Rigging Bag", 6],
  ['Harnesses', 3],
  ['Training 4:1 Rope Bag', 2],
]
/** Plus items on the shelf, in no kit at all. */
const ROOM_LOOSE = 2

/** A kit on a truck, to prove a truck is the same kind of area. */
const TRUCK_KIT = 'Truck Rope Bag'
const TRUCK_KIT_ITEMS = 4
const TRUCK_LOOSE = 3

/**
 * Matchers for names containing regex punctuation.
 *
 * `contains` for a row link, whose accessible name is the whole row — the name
 * plus its subtitle. `exact` only where the link text really is just the name.
 */
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const contains = (text: string) => new RegExp(escapeRe(text))
const exact = (text: string) => new RegExp(`^${escapeRe(text)}$`)

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

/**
 * Wait for the page itself, not just the URL. `waitForURL` resolves while a
 * Suspense boundary is still showing its skeleton, so reading the text then
 * gets the nav chrome and nothing else.
 */
async function settle(page: Page) {
  await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 20_000 })
  return (await page.locator('main').innerText()).toLowerCase()
}

function roomCsv(): string {
  const rows = [['Asset Tag', 'Model', 'Category', 'Holder', 'Container'].join(',')]
  let n = 0
  for (const [kit, count] of ROOM_KITS) {
    for (let index = 0; index < count; index++) {
      rows.push([`${TAG}-R-${++n}`, 'Rigging Plate', 'Rope Rescue > Rigging', PROP, kit].join(','))
    }
  }
  for (let index = 0; index < ROOM_LOOSE; index++) {
    rows.push([`${TAG}-R-${++n}`, 'Spare Sling', 'Rope Rescue > Rigging', PROP, ''].join(','))
  }
  return rows.join('\n')
}

/** A truck sheet: a kit, loose gear, and both classes of asset on one vehicle. */
function truckCsv(truckNumber: string): string {
  const rows = [['Asset Tag', 'Model', 'Category', 'Truck', 'Container'].join(',')]
  for (let index = 0; index < TRUCK_KIT_ITEMS; index++) {
    rows.push(
      [`${TAG}-T-K${index + 1}`, 'Prusik Cord', 'Rope Rescue > Rigging', truckNumber, TRUCK_KIT].join(
        ',',
      ),
    )
  }
  // Loose gear, deliberately RENTAL-classified: an area holds both classes.
  for (let index = 0; index < TRUCK_LOOSE; index++) {
    rows.push(
      [`${TAG}-T-L${index + 1}`, 'Four-Gas Monitor', 'Gas Detection', truckNumber, ''].join(','),
    )
  }
  return rows.join('\n')
}

function officeCsv(): string {
  const rows = [['Asset Tag', 'Model', 'Category', 'Holder', 'Status', 'Comment'].join(',')]
  for (let index = 0; index < 3; index++) {
    rows.push([`${TAG}-O-${index + 1}`, 'Spare Lens Kit', 'Gas Detection', OFFICE, 'ACTIVE', ''].join(','))
  }
  rows.push([`${TAG}-O-RET`, 'Old Regulator', 'Respiratory', OFFICE, 'RETIRED', 'Discarded — binned'].join(','))
  rows.push([`${TAG}-O-Q`, 'Suspect Lanyard', 'Fall Protection', OFFICE, 'QUARANTINED', 'Recall check'].join(','))
  return rows.join('\n')
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

  const truck = await db.truck.findFirstOrThrow({
    where: { active: true },
    orderBy: { number: 'asc' },
    select: { id: true, number: true },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    await signIn(page, 'ray@teksolv.com')
    await importCsv(page, 'room.csv', roomCsv())
    await importCsv(page, 'truck.csv', truckCsv(truck.number))
    await importCsv(page, 'office.csv', officeCsv())

    const room = await db.location.findFirstOrThrow({ where: { name: PROP } })
    const office = await db.location.findFirstOrThrow({ where: { name: OFFICE } })
    const roomTotal = ROOM_KITS.reduce((sum, [, count]) => sum + count, 0) + ROOM_LOOSE

    // -----------------------------------------------------------------------
    console.log('\nAreas: one list, both kinds\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/areas`, { waitUntil: 'networkidle' })
    const index = await settle(page)
    check('the room is listed', index.includes(PROP.toLowerCase()))
    check('the office is listed', index.includes(OFFICE.toLowerCase()))
    check(
      'and the trucks are listed as areas too',
      index.includes(`truck ${truck.number}`),
      'a truck and a room answer the same question, so they are not on two screens',
    )

    const areas = await listAreas(db)
    check(
      'every truck and every active room is an area',
      areas.filter((area) => area.kind === 'TRUCK').length ===
        (await db.truck.count({ where: { active: true } })) &&
        areas.filter((area) => area.kind === 'LOCATION').length ===
          (await db.location.count({ where: { active: true } })),
      `${areas.filter((a) => a.kind === 'TRUCK').length} trucks · ${areas.filter((a) => a.kind === 'LOCATION').length} rooms`,
    )
    check(
      'an area holding nothing is still listed, not hidden',
      areas.some((area) => area.held === 0),
      'an empty store room is a fact about the store room',
    )
    check(
      'and the index says how many kits each holds',
      areas.find((area) => area.id === room.id)?.kitCount === ROOM_KITS.length,
      `${areas.find((area) => area.id === room.id)?.kitCount} kits at the room`,
    )

    // -----------------------------------------------------------------------
    console.log('\nA room area: kits first, then what is loose\n')
    // -----------------------------------------------------------------------

    await page.getByRole('link', { name: contains(PROP) }).first().click()
    await page.waitForURL(/\/areas\/[^/]+$/, { timeout: 20_000 })
    const roomText = await settle(page)
    check('it opens from the index', page.url().includes(room.id), page.url())
    check(
      `the header counts all ${roomTotal} items and ${ROOM_KITS.length} kits`,
      roomText.includes(`${roomTotal} items here`) && roomText.includes(`${ROOM_KITS.length} kits`),
      roomText.split('\n').slice(0, 6).join(' / '),
    )
    for (const [kit, count] of ROOM_KITS) {
      check(
        `${kit} holds ${count}, all present`,
        new RegExp(
          `${kit.toLowerCase().replace(/[^a-z0-9]/g, '.')}[\\s\\S]{0,80}?${count} items? . all present`,
        ).test(roomText),
      )
    }
    check(`the ${ROOM_LOOSE} shelf items are under Loose items`, roomText.includes('loose items'))
    check(
      'and the kits come first — a kit is what somebody picks up',
      roomText.indexOf('loose items') > roomText.indexOf("george's red rigging bag"),
    )

    const roomArea = await getArea(db, 'LOCATION', room.id)
    check(
      'the page and the data agree',
      roomArea!.held === roomTotal &&
        roomArea!.kits.length === ROOM_KITS.length &&
        roomArea!.loose.length === ROOM_LOOSE,
      `${roomArea!.held} items · ${roomArea!.kits.length} kits · ${roomArea!.loose.length} loose`,
    )

    // -----------------------------------------------------------------------
    console.log('\nA truck is an area, and answers the same way\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/trucks/${truck.id}`, { waitUntil: 'networkidle' })
    const truckText = await settle(page)
    check(
      'the truck lists its kit',
      truckText.includes(TRUCK_KIT.toLowerCase()),
      'which kits are on which trucks, answered by opening the truck',
    )
    check(
      `with its ${TRUCK_KIT_ITEMS} items`,
      new RegExp(
        `${TRUCK_KIT.toLowerCase()}[\\s\\S]{0,80}?${TRUCK_KIT_ITEMS} items? . all present`,
      ).test(truckText),
    )
    check('and its loose gear separately', truckText.includes('loose items'))
    check(
      'links back to Areas, not to a separate trucks screen',
      (await page.getByRole('link', { name: /^Areas$/ }).count()) > 0,
    )

    const truckArea = await getArea(db, 'TRUCK', truck.id)
    check(
      'a truck area is built by the same helper as a room area',
      truckArea !== null &&
        truckArea.kind === 'TRUCK' &&
        truckArea.kits.some((kit) => kit.name === TRUCK_KIT),
      `${truckArea?.kits.length} kits · ${truckArea?.loose.length} loose`,
    )
    check(
      'and holds RENTAL and RESCUE gear at once — an area does not decide class',
      (await db.asset.count({ where: { assetTag: { startsWith: `${TAG}-T-` }, assetType: 'RENTAL' } })) ===
        TRUCK_LOOSE &&
        (await db.asset.count({
          where: { assetTag: { startsWith: `${TAG}-T-` }, assetType: 'RESCUE' },
        })) === TRUCK_KIT_ITEMS,
      'class follows the category, never the area',
    )

    // -----------------------------------------------------------------------
    console.log('\nA kit belongs to exactly one area, and says which\n')
    // -----------------------------------------------------------------------

    const kits = await listContainers(db)
    const roomKit = kits.find((kit) => kit.name === "George's Red Rigging Bag" && kit.areaId === room.id)
    check('a kit names its area', roomKit?.areaLabel === PROP, roomKit?.areaLabel)
    check('and links to it', roomKit?.areaHref === `/areas/${room.id}`, String(roomKit?.areaHref))
    check(
      'a truck kit names its truck as its area',
      kits.find((kit) => kit.name === TRUCK_KIT)?.areaHref === `/trucks/${truck.id}`,
      kits.find((kit) => kit.name === TRUCK_KIT)?.areaLabel,
    )
    check(
      'no kit is left without one',
      kits.every((kit) => kit.areaId !== null),
      'the container_has_one_holder CHECK makes a kit with no area unrepresentable',
    )

    await page.goto(`${BASE}/containers`, { waitUntil: 'networkidle' })
    const kitsText = await settle(page)
    check(
      'the kits index groups them under their area',
      kitsText.includes(PROP.toLowerCase()) && kitsText.includes(`truck ${truck.number}`),
      'kits nest under areas on the page the way they do in the model',
    )

    await page.goto(`${BASE}/containers/${roomKit!.id}`, { waitUntil: 'networkidle' })
    const kitText = await settle(page)
    check('a kit page names its area', kitText.includes(PROP.toLowerCase()))
    const back = await page.getByRole('link', { name: exact(PROP) }).first().getAttribute('href')
    check('and links there by href', back === `/areas/${room.id}`, String(back))

    // -----------------------------------------------------------------------
    console.log('\nEvery item resolves to an area\n')
    // -----------------------------------------------------------------------

    const sample = await db.asset.findFirstOrThrow({
      where: { assetTag: `${TAG}-R-1` },
      select: {
        id: true,
        custodyType: true,
        custodyTruck: { select: { id: true, number: true } },
        custodyLocation: { select: { id: true, name: true } },
        container: {
          select: {
            truck: { select: { id: true, number: true } },
            location: { select: { id: true, name: true } },
          },
        },
        location: { select: { id: true, name: true } },
      },
    })
    check('an item in a kit resolves to that kit’s area', areaOfAsset(sample)?.name === PROP)

    await page.goto(`${BASE}/inventory?q=${TAG}-`, { waitUntil: 'networkidle' })
    const listText = await settle(page)
    check(
      'the list shows a real area for the room’s gear',
      listText.includes(PROP.toLowerCase()),
      'the column used to read the catalogue location, which is null for held gear',
    )
    check('and for the truck’s', listText.includes(`truck ${truck.number}`))
    check(
      'with no em-dash standing in for a place',
      !/\n—\n/.test(listText),
      'every unit imported here has an area, so none should render a dash',
    )

    await page.goto(`${BASE}/inventory/${sample.id}`, { waitUntil: 'networkidle' })
    const unitText = await settle(page)
    check('the unit page names its area', unitText.includes(PROP.toLowerCase()))
    check(
      'and the kit it is in',
      unitText.includes("george's red rigging bag"),
      'area via kit, stated rather than inferred',
    )

    // -----------------------------------------------------------------------
    console.log('\nThe office area: held, quarantined and retired\n')
    // -----------------------------------------------------------------------

    const officeArea = await getArea(db, 'LOCATION', office.id)
    check(
      'the office holds four — its three spares and the quarantined one',
      officeArea!.held === 4,
      `${officeArea!.held} · a hold does not mean it left the area`,
    )
    check(
      'the quarantined one is among them',
      officeArea!.loose.some((item) => item.status === 'QUARANTINED'),
    )
    check(
      'and the retired one is apart, not counted as held',
      officeArea!.retired.length === 1 && officeArea!.held === 4,
      `${officeArea!.held} held · ${officeArea!.retired.length} retired — retirement releases custody`,
    )

    // -----------------------------------------------------------------------
    console.log('\nMoving a kit moves it to another area, contents and all\n')
    // -----------------------------------------------------------------------

    // Captured before the move: this truck carries seed gear as well as the
    // fixture's, and the claim is that the move leaves it alone — not that the
    // truck is empty.
    const looseBefore = (await getArea(db, 'TRUCK', truck.id))!.loose.length

    const truckKit = kits.find((kit) => kit.name === TRUCK_KIT)!
    await page.goto(`${BASE}/containers/${truckKit.id}`, { waitUntil: 'networkidle' })
    await settle(page)
    await page.getByRole('button', { name: /Move this kit/i }).click()
    await page.selectOption('select[name="destination"]', `location:${room.id}`)
    await page.getByRole('button', { name: /^Move \d+ items?$/ }).click()
    await page.waitForTimeout(4_000)

    const movedKit = (await listContainers(db)).find((kit) => kit.name === TRUCK_KIT)
    check(
      'the kit itself is now in the room area',
      movedKit?.areaId === room.id,
      `${movedKit?.areaLabel} — one area at a time, the CHECK sees to that`,
    )
    check(
      'and its contents came with it',
      (await db.asset.count({
        where: { assetTag: { startsWith: `${TAG}-T-K` }, custodyLocationId: room.id },
      })) === TRUCK_KIT_ITEMS,
      'a kit that arrives without its gear is a kit somebody has to go and find',
    )
    check(
      'the kit still reads complete after the move',
      movedKit?.complete === true,
      `${movedKit?.present} of ${movedKit?.members.length} — completeness is derived from custody, so it followed`,
    )

    const afterRoom = await getArea(db, 'LOCATION', room.id)
    const afterTruck = await getArea(db, 'TRUCK', truck.id)
    check(
      'the room area now lists it',
      afterRoom!.kits.some((kit) => kit.name === TRUCK_KIT),
      `${afterRoom!.kits.length} kits`,
    )
    check(
      'and the truck no longer does',
      !afterTruck!.kits.some((kit) => kit.name === TRUCK_KIT),
      `${afterTruck!.kits.length} kits left on the truck`,
    )
    check(
      'the truck keeps every loose item, none of which was in the kit',
      afterTruck!.loose.length === looseBefore,
      `${afterTruck!.loose.length} of ${looseBefore} — moving a kit moves the kit, not the shelf`,
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    const ids = (
      await prismaUnscoped.asset.findMany({
        where: { orgId: org.id, assetTag: { startsWith: TAG } },
        select: { id: true },
      })
    ).map((row) => row.id)
    if (ids.length) {
      await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: ids } } })
      await prismaUnscoped.notification.deleteMany({ where: { entityId: { in: ids } } })
      await prismaUnscoped.auditLog.deleteMany({ where: { entityId: { in: ids } } })
      await prismaUnscoped.asset.deleteMany({ where: { id: { in: ids } } })
    }
    // Only this run's kits: by its own rooms, and by the truck-kit name only
    // this fixture uses. Deleting kits by a shared name across the org is what
    // took the real Rescue Prop's bags once already.
    await prismaUnscoped.container.deleteMany({
      where: {
        orgId: org.id,
        OR: [{ location: { name: { in: [PROP, OFFICE] } } }, { name: TRUCK_KIT }],
      },
    })
    await prismaUnscoped.location.deleteMany({
      where: {
        orgId: org.id,
        name: { in: [PROP, OFFICE] },
        custodyOf: { none: {} },
        assets: { none: {} },
      },
    })
    console.log(`\n(removed ${ids.length} units, this run's kits and two areas)`)
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll area checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
