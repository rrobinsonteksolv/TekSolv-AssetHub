/**
 * Loading a whole truck's kit from one CSV.
 *
 * The scenario: 45 rows for Truck 167 — 4 rental SCBAs and 41 rescue items —
 * with the inspection paperwork columns alongside. All 45 land, all 45 stage on
 * the truck with a custody record each, the rescue gear stays out of
 * utilization, and the truck's loadout shows every one of them regardless of
 * class.
 *
 * **The CSV is generated here, not supplied.** The real Truck 167 file was not
 * available, so this builds one with the shape described: the column names, the
 * rental/rescue split, categories the org does not have yet, and the paperwork
 * columns. It exercises the importer; it is not a check against real data.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-import-truck.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { classifyAssetType } from '../src/lib/validators/assets'
import { dbForOrg } from '../src/lib/tenant-db'
import { analyzeImport } from '../src/lib/import'
import { getTruckReadiness } from '../src/lib/rentals'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const TAG = 'T167IMP'

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

/** A Truck 167 loadout: 4 rental SCBAs and 41 rescue items. */
function buildCsv(truckNumber: string): string {
  const header = [
    'Asset Tag',
    'Model',
    'Manufacturer',
    'Serial Number',
    'Category',
    'Asset Type',
    'Truck',
    'Part Number',
    'DOM',
    'First Use',
    'Cert Expiry',
    'Certification',
    'Last Inspection Result',
    'Comment',
  ].join(',')

  const rescueKit = [
    ['Rescue Rope 200ft', 'Rescue Rope'],
    ['Rescue Harness Class III', 'Rescue Harness'],
    ['Locking Carabiner', 'Rescue Hardware'],
    ['Rescue Pulley', 'Rescue Hardware'],
    ['Tripod Anchor', 'Rescue Hardware'],
    ['Full Body Litter', 'Patient Handling'],
  ]

  const rows: string[] = []
  for (let index = 0; index < 4; index++) {
    rows.push(
      [
        `${TAG}-SCBA-${index + 1}`,
        'SCBA 4500psi 45min',
        'MSA',
        `SCBA-${9000 + index}`,
        'Portable Monitors',
        'RENTAL',
        truckNumber,
        `PN-SCBA-${index + 1}`,
        '2024-02-11',
        '2024-03-01',
        '2027-02-11',
        'NFPA 1981',
        'Pass',
        'Cylinder hydro current',
      ].join(','),
    )
  }
  for (let index = 0; index < 41; index++) {
    const [model, category] = rescueKit[index % rescueKit.length]
    rows.push(
      [
        `${TAG}-R-${String(index + 1).padStart(2, '0')}`,
        model,
        'Petzl',
        `RSC-${7000 + index}`,
        category,
        'RESCUE',
        truckNumber,
        `PN-${1000 + index}`,
        '2023-06-04',
        '2023-07-15',
        '2026-06-04',
        'NFPA 1983',
        index % 9 === 0 ? 'Monitor - minor wear' : 'Pass',
        '',
      ].join(','),
    )
  }
  return `${header}\n${rows.join('\n')}\n`
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const truck = await prismaUnscoped.truck.findFirst({
    where: { orgId: org.id, number: '167', active: true },
  })
  if (!truck) throw new Error('Truck 167 is not in the fleet')

  const csv = buildCsv(truck.number)
  const before = await prismaUnscoped.asset.count({ where: { orgId: org.id } })

  console.log(`\nImporting 45 rows onto Truck ${truck.number}\n`)

  // --- the analysis, before any browser ------------------------------------
  const analysis = await analyzeImport(db, csv, null)
  check(
    'every row parses without errors',
    (analysis.errorCount ?? -1) === 0 && analysis.validCount === 45,
    `${analysis.validCount} valid, ${analysis.errorCount} with problems` +
      (analysis.rows?.find((row) => row.errors.length)
        ? ` — first: ${analysis.rows.find((row) => row.errors.length)!.errors.join(' ')}`
        : ''),
  )
  check(
    'the preview names the categories it will create',
    (analysis.newCategories ?? []).length > 0,
    (analysis.newCategories ?? []).join(', '),
  )
  check(
    'and says what stages on which truck',
    analysis.staging?.some((entry) => entry.truckName === truck.number && entry.count === 45) ??
      false,
    JSON.stringify(analysis.staging),
  )
  check(
    'and how the batch splits between rental and rescue',
    analysis.byType?.RENTAL === 4 && analysis.byType?.RESCUE === 41,
    JSON.stringify(analysis.byType),
  )
  check(
    'the paperwork columns are recognised',
    ['partNumber', 'certExpiry', 'certification', 'lastInspectionResult'].every((key) =>
      (analysis.customFieldKeys ?? []).includes(key),
    ),
    (analysis.customFieldKeys ?? []).join(', '),
  )
  check(
    'DOM and first use map to the real date columns, not to a Json blob',
    analysis.rows?.[0]?.manufactureDate === '2024-02-11' &&
      analysis.rows?.[0]?.inServiceDate === '2024-03-01',
    'they drive service life and print on FP-01',
  )
  check(
    'a comment becomes the note',
    (analysis.rows?.[0]?.notes ?? '').includes('Cylinder hydro current'),
  )

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  try {
    // -----------------------------------------------------------------------
    console.log('\nClassification, when the sheet does not say\n')
    // -----------------------------------------------------------------------

    // An explicit column always wins; this is the fallback. Ventilation is the
    // case that was wrong: canister fans and blowers rent out exactly like
    // meters and SCBAs, and were landing as rescue gear because they live on a
    // truck — which is custody, not classification.
    const RENTAL_PATHS = [
      'Respiratory > SCBA',
      'SCBA > Cylinders',
      'Gas Detection',
      'Gas Detection > Portable Monitors',
      'Gas Detection > Single-Gas',
      'Confined Space > Ventilation',
      'Ventilation',
      'Air Movers',
      'Canister Fans',
      'Blowers',
    ]
    const RESCUE_PATHS = [
      'Rope Rescue > Rope',
      'Rope Rescue > Descenders',
      'Fall Protection > Harnesses',
      'Rescue > Litters',
      'Medical > AED',
      'Patient Handling',
    ]

    check(
      'SCBA, gas detection and ventilation infer RENTAL',
      RENTAL_PATHS.every((path) => classifyAssetType(path) === 'RENTAL'),
      RENTAL_PATHS.filter((path) => classifyAssetType(path) !== 'RENTAL').join(', ') || 'all ten',
    )
    check(
      'and everything else defaults to RESCUE',
      RESCUE_PATHS.every((path) => classifyAssetType(path) === 'RESCUE'),
      RESCUE_PATHS.filter((path) => classifyAssetType(path) !== 'RESCUE').join(', ') || 'all six',
    )
    check(
      'a category nobody anticipated is rescue, not rental',
      classifyAssetType('Something Nobody Listed') === 'RESCUE' &&
        classifyAssetType(null) === 'RESCUE',
      'wrong-towards-rescue is visible and harmless; wrong-towards-rental joins the utilization denominator and reads as idle capital forever',
    )
    check(
      '"fan" is matched as a word, not as a substring',
      classifyAssetType('Infant Extrication') === 'RESCUE',
      'a loose match would quietly promote unrelated gear into the rental fleet',
    )

    await signIn(page, 'sam@teksolv.com')

    // --- through the wizard -------------------------------------------------
    console.log('\nThrough the import wizard\n')

    await page.goto(`${BASE}/inventory/import`, { waitUntil: 'networkidle' })
    await page.setInputFiles('input[type="file"]', {
      name: 'truck-167.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    })
    await page.getByRole('button', { name: /Preview import/ }).click()
    await page.waitForTimeout(3000)

    const previewText = await page.locator('body').innerText()
    check('the preview says 45 are ready', previewText.includes('45 ready'), previewText.slice(0, 0))
    check(
      'it warns which categories are new before committing',
      previewText.includes('New categories, created on import'),
    )
    check(
      'and that 45 will be staged on the truck',
      previewText.includes(`45 on Truck ${truck.number}`),
    )
    check(
      'and shows the rental/rescue split',
      previewText.includes('4 rental, 41 rescue'),
    )

    await page.getByRole('button', { name: /Import 45 assets/ }).click()
    await page.waitForTimeout(6000)

    check(
      'the commit reports what it did',
      (await page.locator('body').innerText()).includes('Imported 45 assets'),
    )

    // --- what landed --------------------------------------------------------
    console.log('\nWhat landed\n')

    const imported = await prismaUnscoped.asset.findMany({
      where: { orgId: org.id, assetTag: { startsWith: TAG } },
      select: { id: true, assetTag: true, assetType: true, custodyTruckId: true, custodyType: true, customFields: true, manufactureDate: true },
    })
    check(
      '45 assets created',
      imported.length === 45,
      `${await prismaUnscoped.asset.count({ where: { orgId: org.id } })} total, was ${before}`,
    )
    check(
      'all 45 staged on Truck 167',
      imported.every(
        (asset) => asset.custodyTruckId === truck.id && asset.custodyType === 'TRUCK',
      ),
      `${imported.filter((a) => a.custodyTruckId === truck.id).length} of ${imported.length}`,
    )
    check(
      'each with a custody record, exactly as if it had been scanned on',
      (await prismaUnscoped.custodyEvent.count({
        where: { assetId: { in: imported.map((asset) => asset.id) }, truckId: truck.id },
      })) === 45,
    )
    check(
      'the 4 SCBAs are rental',
      imported.filter((asset) => asset.assetType === 'RENTAL').length === 4,
    )
    check(
      'and the 41 rescue items are rescue',
      imported.filter((asset) => asset.assetType === 'RESCUE').length === 41,
    )
    check(
      'the inspection paperwork came along on each unit',
      imported.every((asset) => {
        const fields = (asset.customFields ?? {}) as Record<string, string>
        return Boolean(fields.partNumber && fields.certification && fields.lastInspectionResult)
      }),
      'partNumber, certExpiry, certification, lastInspectionResult',
    )
    check(
      'and is visible, not just stored',
      (await prismaUnscoped.customFieldDefinition.count({
        where: { orgId: org.id, categoryId: null, key: { in: ['partNumber', 'certification'] } },
      })) === 2,
      'a custom-field key with no definition renders nowhere',
    )
    check(
      'the date of manufacture landed in the real column',
      imported.every((asset) => asset.manufactureDate !== null),
    )

    // --- the split ----------------------------------------------------------
    console.log('\nRental vs rescue\n')

    // Searched rather than read off page one: the list paginates at 50, and as
    // real trucks get imported the fixtures fall off the first page. The
    // assertion is about classification, not about where a row happens to sort.
    await page.goto(`${BASE}/inventory?type=RESCUE&q=${TAG}`, { waitUntil: 'networkidle' })
    const rescueTab = await page.locator('body').innerText()
    check(
      'the Rescue tab lists the rescue gear',
      rescueTab.includes(`${TAG}-R-01`),
    )
    check(
      'and not the rental SCBAs',
      !rescueTab.includes(`${TAG}-SCBA-1`),
    )

    await page.goto(`${BASE}/inventory?type=RENTAL&q=${TAG}`, { waitUntil: 'networkidle' })
    const rentalTab = await page.locator('body').innerText()
    check('the rental fleet lists the SCBAs', rentalTab.includes(`${TAG}-SCBA-1`))
    check('and not the rescue gear', !rentalTab.includes(`${TAG}-R-01`))

    const { getDashboard } = await import('../src/lib/dashboard')
    const dashboard = await getDashboard(db)
    check(
      'utilization counts rental gear only',
      dashboard.fleet.total ===
        (await prismaUnscoped.asset.count({
          where: { orgId: org.id, active: true, assetType: 'RENTAL' },
        })),
      `fleet total ${dashboard.fleet.total} — 41 rescue items would otherwise read as permanently idle`,
    )

    // --- the truck sees everything -------------------------------------------
    console.log('\nThe truck loadout\n')

    await page.goto(`${BASE}/trucks/${truck.id}`, { waitUntil: 'networkidle' })
    const loadout = await page.locator('body').innerText()
    check(
      'the loadout shows the rescue gear',
      loadout.includes(`${TAG}-R-01`),
    )
    check(
      'and the rental SCBAs alongside it',
      loadout.includes(`${TAG}-SCBA-1`),
      'a truck carries what it carries — the class split is a reporting concern',
    )

    const readiness = await getTruckReadiness(db)
    const truck167 = readiness.find((entry) => entry.id === truck.id)!
    check(
      'and readiness counts all 45',
      truck167.stagedAssets.length >= 45,
      `${truck167.stagedAssets.length} staged, ready=${truck167.ready}`,
    )

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    const imported = await prismaUnscoped.asset.findMany({
      where: { orgId: org.id, assetTag: { startsWith: TAG } },
      select: { id: true },
    })
    const ids = imported.map((asset) => asset.id)
    await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: ids } } })
    await prismaUnscoped.notification.deleteMany({ where: { entityId: { in: ids } } })
    await prismaUnscoped.asset.deleteMany({ where: { id: { in: ids } } })
    await prismaUnscoped.customFieldDefinition.deleteMany({
      where: {
        orgId: org.id,
        categoryId: null,
        key: { in: ['partNumber', 'certExpiry', 'certification', 'lastInspectionResult'] },
      },
    })
    await prismaUnscoped.category.deleteMany({
      where: {
        orgId: org.id,
        name: { in: ['Rescue Rope', 'Rescue Harness', 'Rescue Hardware', 'Patient Handling'] },
        assets: { none: {} },
      },
    })
    await prismaUnscoped.auditLog.deleteMany({
      where: { action: { in: ['asset.import', 'custody.assign'] } },
    })
    console.log('\n  (test data cleaned up)')
  }

  console.log(failures === 0 ? '\nAll truck-import checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
