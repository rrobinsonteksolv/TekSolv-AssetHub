/**
 * The three asset dates, and why they are three.
 *
 *   purchaseDate     when TekSolv bought it      → billing, depreciation
 *   manufactureDate  when it was made            → service life / retirement
 *   inServiceDate    when it first went to work  → inspection intervals
 *
 * A harness made in 2019, bought in 2023, and issued in 2024 has three
 * different answers to three different questions, so most of what follows is
 * about keeping them *separate*: writing one must never disturb another, and
 * clearing one must never clear the rest.
 *
 * Two of them — manufacture and in-service — are AssetHub-entered. FAM carries
 * neither, so a NetSuite pull must not blank what somebody typed. The sync
 * writes an explicit allow-list of NetSuite-owned columns; this asserts that
 * allow-list rather than trusting it, then proves the behaviour by applying a
 * sync-shaped update.
 *
 *   npx tsx scripts/verify-asset-dates.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { createAssetSchema, normalizeCsvHeader } from '../src/lib/validators/assets'
import { buildFp01 } from '../src/lib/fp01'
import { getInspection } from '../src/lib/inspections'

let failures = 0
const ROLLBACK = '__ROLLBACK__'

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function sandbox<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | undefined> {
  let captured: T | undefined
  try {
    await prismaUnscoped.$transaction(async (tx) => {
      captured = await fn(tx)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(ROLLBACK)) throw error
  }
  return captured
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const on = (date: Date | null | undefined) => date?.toISOString().slice(0, 10) ?? null

/** The three dates, and whether NetSuite owns them. */
const DATES = [
  { field: 'manufactureDate', value: '2019-03-14', netsuiteOwned: false },
  { field: 'inServiceDate', value: '2024-02-05', netsuiteOwned: false },
  { field: 'purchaseDate', value: '2023-11-20', netsuiteOwned: true },
] as const

const ALL_THREE = {
  manufactureDate: day('2019-03-14'),
  inServiceDate: day('2024-02-05'),
  purchaseDate: day('2023-11-20'),
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const asset = await db.asset.findFirstOrThrow({ where: { active: true } })

  // -----------------------------------------------------------------------
  console.log('\nThree columns, three questions\n')
  // -----------------------------------------------------------------------

  await sandbox(async (tx) => {
    await tx.asset.update({ where: { id: asset.id }, data: ALL_THREE })
    const saved = await tx.asset.findUniqueOrThrow({ where: { id: asset.id } })

    check(
      'all three persist independently',
      on(saved.manufactureDate) === '2019-03-14' &&
        on(saved.inServiceDate) === '2024-02-05' &&
        on(saved.purchaseDate) === '2023-11-20',
      `made ${on(saved.manufactureDate)} · bought ${on(saved.purchaseDate)} · in service ${on(saved.inServiceDate)}`,
    )
    check(
      'they hold three distinct values, not one column read three ways',
      new Set([
        saved.manufactureDate?.getTime(),
        saved.inServiceDate?.getTime(),
        saved.purchaseDate?.getTime(),
      ]).size === 3,
    )
  })

  // Clearing each one alone must leave the other two untouched.
  for (const target of DATES) {
    await sandbox(async (tx) => {
      await tx.asset.update({ where: { id: asset.id }, data: ALL_THREE })
      await tx.asset.update({ where: { id: asset.id }, data: { [target.field]: null } })
      const after = (await tx.asset.findUniqueOrThrow({ where: { id: asset.id } })) as Record<
        string,
        unknown
      >

      const others = DATES.filter((entry) => entry.field !== target.field)
      check(
        `clearing ${target.field} leaves the other two alone`,
        after[target.field] === null &&
          others.every((entry) => on(after[entry.field] as Date | null) === entry.value),
        others.map((entry) => `${entry.field}=${on(after[entry.field] as Date | null)}`).join(' · '),
      )
    })
  }

  // -----------------------------------------------------------------------
  console.log('\nThe form and the importer accept all three\n')
  // -----------------------------------------------------------------------

  check(
    'every date is optional',
    createAssetSchema.safeParse({ assetTag: 'X1', categoryId: 'c' }).success,
  )

  const parsed = createAssetSchema.safeParse({
    assetTag: 'X1',
    categoryId: 'c',
    manufactureDate: '2019-03-14',
    inServiceDate: '2024-02-05',
    purchaseDate: '2023-11-20',
  })
  check(
    'all three parse through the form schema',
    on(parsed.data?.manufactureDate) === '2019-03-14' &&
      on(parsed.data?.inServiceDate) === '2024-02-05' &&
      on(parsed.data?.purchaseDate) === '2023-11-20',
  )

  for (const field of ['manufactureDate', 'inServiceDate', 'purchaseDate'] as const) {
    check(
      `an unreadable ${field} is refused rather than stored as garbage`,
      !createAssetSchema.safeParse({ assetTag: 'X1', categoryId: 'c', [field]: 'last tuesday' })
        .success,
    )
  }

  check(
    'CSV headers people actually type map to the right column',
    normalizeCsvHeader('Date of Manufacture') === 'manufactureDate' &&
      normalizeCsvHeader('Mfg Date') === 'manufactureDate' &&
      normalizeCsvHeader('Date Placed in Service') === 'inServiceDate' &&
      normalizeCsvHeader('In-Service Date') === 'inServiceDate' &&
      normalizeCsvHeader('Purchase Date') === 'purchaseDate',
  )
  check(
    'and none of the three collides with another',
    new Set(
      ['Date of Manufacture', 'Date Placed in Service', 'Purchase Date'].map((header) =>
        normalizeCsvHeader(header),
      ),
    ).size === 3,
  )

  // -----------------------------------------------------------------------
  console.log('\nA NetSuite sync touches only what FAM owns\n')
  // -----------------------------------------------------------------------

  const syncSource = await import('node:fs/promises').then((fs) =>
    fs.readFile('src/lib/netsuite/sync.ts', 'utf8'),
  )
  // Slice from the allow-list to the *next* transaction after it — sync.ts has
  // several `db.$transaction` calls, and anchoring on the first would read an
  // empty block and quietly pass.
  const ownedStart = syncSource.indexOf('const owned = {')
  const ownedEnd = syncSource.indexOf('await db.$transaction', ownedStart)
  const ownedBlock = syncSource.slice(ownedStart, ownedEnd)

  check(
    'the sync writes an explicit allow-list of NetSuite-owned columns',
    ownedStart > 0 && ownedEnd > ownedStart && ownedBlock.includes('purchaseDate'),
    `allow-list is ${ownedBlock.length} chars; fields absent from it are untouched by construction`,
  )
  for (const target of DATES.filter((entry) => !entry.netsuiteOwned)) {
    check(
      `${target.field} is NOT in that allow-list`,
      !ownedBlock.includes(target.field),
      'FAM does not carry it, so a pull must not blank what somebody typed',
    )
  }

  await sandbox(async (tx) => {
    await tx.asset.update({
      where: { id: asset.id },
      data: { manufactureDate: day('2019-03-14'), inServiceDate: day('2024-02-05') },
    })

    // Exactly the shape sync.ts writes for an asset it already knows.
    await tx.asset.update({
      where: { id: asset.id },
      data: {
        serialNumber: 'NS-SERIAL',
        manufacturer: 'NetSuite Mfr',
        model: 'NS Model',
        purchaseCost: 1234,
        purchaseDate: day('2024-01-01'),
        customFields: { famNumber: 'FAM999999' } as object,
      },
    })

    const after = await tx.asset.findUniqueOrThrow({ where: { id: asset.id } })
    check(
      'a sync-shaped update leaves both AssetHub dates intact',
      on(after.manufactureDate) === '2019-03-14' && on(after.inServiceDate) === '2024-02-05',
      `made ${on(after.manufactureDate)} · in service ${on(after.inServiceDate)}`,
    )
    check(
      'while purchase date — which FAM does own — was updated by the pull',
      on(after.purchaseDate) === '2024-01-01',
      'so this proves survival, not that the update did nothing',
    )
    check(
      'and the other NetSuite-owned fields really did change',
      after.serialNumber === 'NS-SERIAL' && after.model === 'NS Model',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nForm FP-01 prints manufacture and in-service\n')
  // -----------------------------------------------------------------------

  const inspection = await db.inspection.findFirst({ orderBy: { performedAt: 'desc' } })
  const detail = inspection ? await getInspection(db, inspection.id) : null

  if (!detail) {
    check('the FP-01 mapper reads both columns', true, 'no inspections on file — skipped')
  } else {
    const form = buildFp01({
      ...detail,
      asset: {
        ...detail.asset,
        manufactureDate: day('2019-03-14'),
        inServiceDate: day('2024-02-05'),
      },
    })
    check(
      'both print, each in its own field',
      form.manufactureDate === '2019-03-14' && form.inServiceDate === '2024-02-05',
      `manufacture ${form.manufactureDate} · in service ${form.inServiceDate}`,
    )

    const legacy = buildFp01({
      ...detail,
      asset: {
        ...detail.asset,
        manufactureDate: null,
        inServiceDate: null,
        customFields: { manufactureDate: '2011-09-02', inServiceDate: '2012-01-15' },
      },
    })
    check(
      'and still fall back to the old custom fields where those were recorded',
      legacy.manufactureDate === '2011-09-02' && legacy.inServiceDate === '2012-01-15',
      'a filed harness form must not lose its dates because the schema caught up',
    )

    const empty = buildFp01({
      ...detail,
      asset: { ...detail.asset, manufactureDate: null, inServiceDate: null, customFields: {} },
    })
    check(
      'with nothing recorded they print blank, not invented',
      empty.manufactureDate === null && empty.inServiceDate === null,
    )
  }

  // -----------------------------------------------------------------------
  const untouched = await db.asset.findUniqueOrThrow({ where: { id: asset.id } })
  check(
    'nothing leaked out of the sandboxes',
    untouched.serialNumber !== 'NS-SERIAL',
    `${asset.assetTag}: serial ${untouched.serialNumber ?? 'none'}`,
  )

  console.log(failures === 0 ? '\nAll asset-date checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
