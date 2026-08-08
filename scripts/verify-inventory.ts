/**
 * Exercises the Phase 2 logic that has real edge cases: asset validation, the
 * custom-field rules, and CSV header/value parsing. Pure functions plus a live
 * query pass, so it runs in a second and needs no browser.
 *
 *   npx tsx scripts/verify-inventory.ts
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { buildAssetWhere, listAssets } from '../src/lib/assets'
import { resolveSchedule, rentalDaysSince, STATE_RANK } from '../src/lib/maintenance'
import {
  createAssetSchema,
  normalizeCsvHeader,
  parseCondition,
  parseStatus,
  validateCustomFields,
  type FieldDefinition,
} from '../src/lib/validators/assets'
import { usDate } from '../src/lib/dates'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  console.log('\nassetTag is never generated (BUILD_SPEC §3.1)\n')

  const category = await db.category.findFirstOrThrow({ where: { slug: 'gas' } })

  for (const [label, tag] of [
    ['missing', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ] as const) {
    const result = createAssetSchema.safeParse({ assetTag: tag, categoryId: category.id })
    check(
      `rejects a ${label} asset tag`,
      !result.success,
      result.success ? 'ACCEPTED — a tag would have been invented' : result.error.issues[0]?.message,
    )
  }

  const trimmed = createAssetSchema.safeParse({ assetTag: '  FAM009999  ', categoryId: category.id })
  check(
    'trims a pasted tag rather than storing the spaces',
    trimmed.success && trimmed.data.assetTag === 'FAM009999',
    trimmed.success ? `-> "${trimmed.data.assetTag}"` : 'rejected',
  )

  console.log('\nForm coercion\n')

  const money = createAssetSchema.safeParse({
    assetTag: 'X1',
    categoryId: category.id,
    purchaseCost: '$1,850',
    dailyRate: '',
    serialNumber: '',
  })
  check(
    'parses "$1,850" and treats blanks as null',
    money.success &&
      money.data.purchaseCost === 1850 &&
      money.data.dailyRate === null &&
      money.data.serialNumber === null,
    money.success ? `cost=${money.data.purchaseCost} rate=${money.data.dailyRate}` : 'rejected',
  )

  const negative = createAssetSchema.safeParse({
    assetTag: 'X1',
    categoryId: category.id,
    purchaseCost: '-5',
  })
  check('rejects a negative cost', !negative.success)

  console.log('\nCustom fields\n')

  const definitions: FieldDefinition[] = [
    { key: 'sensorSet', label: 'Sensor set', type: 'SELECT', options: ['4-gas', 'H2S only'], required: true },
    { key: 'pumped', label: 'Pumped', type: 'BOOLEAN', options: null, required: false },
    { key: 'hours', label: 'Hours', type: 'NUMBER', options: null, required: false },
  ]

  const good = validateCustomFields({ sensorSet: '4-gas', pumped: 'true', hours: '120' }, definitions)
  check(
    'coerces types and accepts a valid set',
    good.issues.length === 0 && good.values.pumped === true && good.values.hours === 120,
    JSON.stringify(good.values),
  )

  const bad = validateCustomFields({ sensorSet: 'nope', hours: 'abc' }, definitions)
  check(
    'rejects an out-of-range SELECT and a non-numeric NUMBER',
    bad.issues.length === 2,
    bad.issues.map((issue) => issue.message).join(' | '),
  )

  const missing = validateCustomFields({}, definitions)
  check('enforces required fields', missing.issues.length === 1, missing.issues[0]?.message)

  const orphan = validateCustomFields({ sensorSet: '4-gas', legacyField: 'keep me' }, definitions)
  check(
    'keeps values whose definition was removed',
    orphan.values.legacyField === 'keep me',
    'editing an asset never silently drops data',
  )

  console.log('\nCSV parsing\n')

  check(
    'maps header aliases',
    normalizeCsvHeader('FAM Number') === 'assetTag' &&
      normalizeCsvHeader('S/N') === 'serialNumber' &&
      normalizeCsvHeader(' Daily Rate ') === 'dailyRate',
  )
  check('ignores an unknown header', normalizeCsvHeader('Widget Colour') === null)
  check(
    'reads the status words people actually type',
    parseStatus('on rent') === 'OUT_ON_RENT' &&
      parseStatus('In Stock') === 'AVAILABLE' &&
      parseStatus('OOS') === 'OUT_OF_SERVICE' &&
      parseStatus('gibberish') === null,
  )
  check('reads conditions', parseCondition('fair') === 'FAIR' && parseCondition('mint') === null)

  console.log('\nList filters (live query)\n')

  const bySerial = await listAssets(db, { q: '8195' })
  check(
    'search finds a unit by the serial on its plate',
    bySerial.rows.length === 1 && bySerial.rows[0].assetTag === 'FAM001007',
    bySerial.rows.map((row) => row.assetTag).join(', '),
  )

  const byTruck = await listAssets(db, { q: 'Truck 165' })
  const truckTags = byTruck.rows.map((row) => row.assetTag).sort()
  check(
    'search finds everything staged on Truck 165',
    truckTags.includes('FAM003001') && truckTags.includes('FAM003002'),
    truckTags.join(', '),
  )

  const byOwner = await listAssets(db, { q: 'Bucky' })
  check(
    "search finds a truck's gear by its owner's name",
    byOwner.rows.some((row) => row.assetTag === 'FAM003001'),
    byOwner.rows.map((row) => row.assetTag).join(', '),
  )

  // Ask the database which units are actually out to this customer rather than
  // asserting a count. The seed said three; then somebody used the app, checked
  // one back in, and a passing test started failing on correct behaviour. The
  // claim worth making is "search returns exactly the units on open rentals to
  // Infinity" — and that stays true however the fleet moves.
  const infinity = await db.rental.findMany({
    where: { status: { in: ['OPEN', 'OVERDUE'] }, customer: { name: { contains: 'Infinity' } } },
    select: { asset: { select: { assetTag: true, active: true } } },
  })
  const expected = [
    ...new Set(infinity.filter((r) => r.asset.active).map((r) => r.asset.assetTag)),
  ].sort()
  const byCustomer = await listAssets(db, { q: 'Infinity' })
  const found = byCustomer.rows.map((row) => row.assetTag).sort()
  check(
    'search finds units by the customer they went out to',
    expected.length > 0 && JSON.stringify(found) === JSON.stringify(expected),
    `${found.join(', ') || 'none'} (out to Infinity: ${expected.join(', ') || 'none'})`,
  )

  const gasDetection = await db.category.findFirstOrThrow({ where: { slug: 'gas-detection' } })
  const byParent = await listAssets(db, { categoryId: gasDetection.id })
  const portable = await db.category.findFirstOrThrow({ where: { slug: 'gas' } })
  const byLeaf = await listAssets(db, { categoryId: portable.id })
  check(
    'a parent category includes its children',
    byParent.filteredCount > byLeaf.filteredCount,
    `Gas Detection=${byParent.filteredCount}, Portable Monitors=${byLeaf.filteredCount}`,
  )

  const unassigned = await listAssets(db, { assignment: 'UNASSIGNED' })
  check(
    'the unassigned filter excludes anything held',
    unassigned.rows.every((row) => row.custodyType === null),
  )

  const truck = await db.truck.findFirstOrThrow({ where: { number: '128' } })
  const staged = await listAssets(db, { assignment: `TRUCK:${truck.id}` })
  check(
    'filtering by a truck returns only its staged gear',
    staged.rows.length > 0 && staged.rows.every((row) => row.custodyTruckId === truck.id),
    staged.rows.map((row) => row.assetTag).join(', '),
  )

  check(
    'a retired asset is out of the list by default',
    JSON.stringify(buildAssetWhere({})).includes('"active":true'),
  )

  console.log('\nUsage estimates (BUILD_SPEC §6.4)\n')

  const compressor = await db.asset.findFirstOrThrow({
    where: { assetTag: 'FAM005001' },
    include: { maintenanceSchedules: true, rentals: true, category: true },
  })
  const now = new Date('2026-08-04T12:00:00Z')
  const resolved = resolveSchedule(compressor.maintenanceSchedules[0], {
    rentals: compressor.rentals,
    categoryHoursPerDay: compressor.category.hoursPerDay,
    now,
  })
  // Asserted against the schedule's own inputs rather than a hard-coded 512.
  // The seeded reading is only true until somebody logs service through the
  // app — which resets priorUsage and moves the anchor, exactly as designed —
  // and a test that fails because the product was *used* is testing the seed,
  // not the arithmetic.
  const compressorSchedule = compressor.maintenanceSchedules[0]
  const expectedHours = Math.max(
    0,
    Math.round(
      Number(compressorSchedule.priorUsage) +
        rentalDaysSince(compressor.rentals, compressorSchedule.usageAnchorAt, now) *
          (compressorSchedule.hoursPerDay ?? compressor.category.hoursPerDay ?? 8),
    ),
  )
  check(
    'FAM005001 accrues priorUsage + rental days × hrs/day, labelled an estimate',
    resolved.estimatedHours === expectedHours && resolved.isEstimate,
    `${resolved.detail} — ${resolved.note}`,
  )
  check(
    'and it trips "service due" once the reading reaches the interval',
    (resolved.estimatedHours ?? 0) >= (resolved.intervalUsage ?? Infinity)
      ? resolved.state === 'due'
      : resolved.state !== 'due',
    `${resolved.estimatedHours} of ${resolved.intervalUsage} → ${resolved.state}`,
  )

  const soon = await db.asset.findFirstOrThrow({
    where: { assetTag: 'FAM005002' },
    include: { maintenanceSchedules: true, rentals: true, category: true },
  })
  const resolvedSoon = resolveSchedule(soon.maintenanceSchedules[0], {
    rentals: soon.rentals,
    categoryHoursPerDay: soon.category.hoursPerDay,
    now,
  })
  const soonSchedule = soon.maintenanceSchedules[0]
  const soonPerDay = soonSchedule.hoursPerDay ?? soon.category.hoursPerDay ?? 8
  const soonExpected = Math.max(
    0,
    Math.round(
      Number(soonSchedule.priorUsage) +
        rentalDaysSince(soon.rentals, soonSchedule.usageAnchorAt, now) * soonPerDay,
    ),
  )
  check(
    'FAM005002 accrues the same way',
    resolvedSoon.estimatedHours === soonExpected,
    `${resolvedSoon.detail} — ${resolvedSoon.note}`,
  )

  // The "due soon" line is now the schedule's own lead time rather than a flat
  // 85% of the interval. At 8 estimated hours per rental day, 7 days' notice
  // is 56 hours, so the line sits at 444 — and a reading of 432 still has
  // roughly eight and a half days of runway, which is not yet a warning.
  const soonLine = (resolvedSoon.intervalUsage ?? 0) - resolvedSoon.leadDays * soonPerDay
  check(
    'the "due soon" line comes from the schedule’s own lead time, not a flat 85%',
    resolvedSoon.state === ((resolvedSoon.estimatedHours ?? 0) >= soonLine ? 'soon' : 'ok'),
    `reading ${resolvedSoon.estimatedHours}, soon starts at ${soonLine} (${resolvedSoon.leadDays}d × ${soonPerDay}h)`,
  )

  // Widening the lead can only ever move the line down, never up.
  const widened = resolveSchedule(
    { ...soonSchedule, leadDays: resolvedSoon.leadDays + 30 },
    { rentals: soon.rentals, categoryHoursPerDay: soon.category.hoursPerDay, now },
  )
  check(
    'widening the lead time can only make a schedule warn earlier, never later',
    STATE_RANK[widened.state] >= STATE_RANK[resolvedSoon.state],
    `${resolvedSoon.leadDays}d → ${resolvedSoon.state}, ${widened.leadDays}d → ${widened.state}`,
  )

  check(
    'a cancelled rental accrues no runtime',
    rentalDaysSince(
      [
        {
          checkoutDate: new Date('2026-01-01'),
          actualReturnDate: new Date('2026-01-31'),
          status: 'CANCELLED',
        },
      ],
      null,
      now,
    ) === 0,
  )

  const scba = await db.asset.findFirstOrThrow({
    where: { assetTag: 'FAM003001' },
    include: { maintenanceSchedules: true, rentals: true, category: true },
  })
  const hydro = scba.maintenanceSchedules.find((s) => s.label.includes('hydrostatic'))!
  const resolvedHydro = resolveSchedule(hydro, { rentals: scba.rentals, now })
  check(
    'a calendar schedule is exact, not an estimate',
    // Compared through the app's own formatter rather than against a second
    // hardcoded spelling of the same day — that is how the two drift.
    !resolvedHydro.isEstimate && resolvedHydro.detail === usDate('2028-01-09'),
    `next due ${resolvedHydro.detail} (${resolvedHydro.state})`,
  )

  console.log(failures === 0 ? '\nAll inventory checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
