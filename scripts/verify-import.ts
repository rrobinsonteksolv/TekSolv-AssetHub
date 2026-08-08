/**
 * CSV import: the row-level analysis, plus one real committed batch that is
 * rolled back afterwards. Run against a seeded dev database.
 *
 *   npx tsx scripts/verify-import.ts
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { analyzeImport } from '../src/lib/import'

let failures = 0

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const fallback = await db.category.findFirstOrThrow({ where: { slug: 'gas' } })

  console.log('\nHeaders\n')

  const noTag = await analyzeImport(db, 'Model,Serial\nWidget,123\n', null)
  check('refuses a file with no asset tag column', Boolean(noTag.error), noTag.error)

  const aliases = await analyzeImport(
    db,
    'FAM Number,S/N,Make,Description\nZZZ-1,S1,MSA,Monitor\n',
    fallback.id,
  )
  check(
    'accepts real-world header names',
    aliases.rows?.[0]?.assetTag === 'ZZZ-1' &&
      aliases.rows?.[0]?.serialNumber === 'S1' &&
      aliases.rows?.[0]?.manufacturer === 'MSA' &&
      aliases.rows?.[0]?.model === 'Monitor',
    JSON.stringify(aliases.rows?.[0] && { tag: aliases.rows[0].assetTag, model: aliases.rows[0].model }),
  )

  const extra = await analyzeImport(db, 'Asset Tag,Widget Colour\nZZZ-2,blue\n', fallback.id)
  check(
    'reports ignored columns instead of failing',
    extra.unmappedHeaders?.includes('Widget Colour') === true && extra.errorCount === 0,
    `ignored: ${extra.unmappedHeaders?.join(', ')}`,
  )

  console.log('\nRow validation\n')

  const anyLocation = await db.location.findFirstOrThrow({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { name: true },
  })

  const csv = [
    'Asset Tag,Model,Category,Location,Status,Condition,Purchase Cost',
    ',No tag here,Portable Monitors,,,,',
    'FAM001006,Duplicate of a real one,Portable Monitors,,,,',
    'ZZZ-DUPE,First,Portable Monitors,,,,',
    'ZZZ-DUPE,Second copy in file,Portable Monitors,,,,',
    'ZZZ-CAT,Bad category,Nonexistent Category,,,,',
    'ZZZ-LOC,Bad location,Portable Monitors,Mars Base,,,',
    'ZZZ-RENT,Claims to be out,Portable Monitors,,On Rent,,',
    'ZZZ-STAT,Bad status,Portable Monitors,,Teleported,,',
    // A real site, looked up rather than hardcoded: the importer *rejects* an
    // unknown location rather than creating one, so naming a specific office
    // here ties the suite to that office still existing.
    `ZZZ-OK,"Blower, 8 inch",Portable Monitors,${anyLocation.name},Available,Good,"$1,850"`,
  ].join('\n')

  const analysis = await analyzeImport(db, csv, null)
  const rows = analysis.rows ?? []
  const errorFor = (tag: string) => rows.find((row) => row.assetTag === tag)?.errors.join(' ') ?? ''

  check('flags a missing tag', rows[0].errors.length > 0, rows[0].errors[0])
  check(
    'flags a tag that already exists',
    errorFor('FAM001006').includes('Already in inventory'),
    errorFor('FAM001006'),
  )
  check(
    'flags the second copy of a tag, not the first',
    rows[2].errors.length === 0 && rows[3].errors.join(' ').includes('Duplicated earlier'),
    `row 4: ${rows[2].errors.length} errors, row 5: ${rows[3].errors.join(' ')}`,
  )
  // A category the org does not have is no longer an error: the commit creates
  // it. Loading a truck's kit from a supplier's spreadsheet always brings a
  // handful of new ones, and making somebody create fifteen by hand first is
  // how a good file gets abandoned. The preview names them, which is the check
  // against a typo quietly creating a sixteenth.
  const unknownCategory = rows.find((row) => row.assetTag === 'ZZZ-CAT')!
  check(
    'an unknown category is queued for creation, not rejected',
    unknownCategory.errors.length === 0 && unknownCategory.newCategory,
    `newCategory=${unknownCategory.newCategory}, errors=${unknownCategory.errors.join(' ') || 'none'}`,
  )
  check(
    'and the preview names it so a typo cannot slip through unseen',
    (analysis.newCategories ?? []).includes(unknownCategory.categoryName!),
    (analysis.newCategories ?? []).join(', '),
  )
  check('flags an unknown location', errorFor('ZZZ-LOC').includes('Unknown location'), errorFor('ZZZ-LOC'))
  check(
    'refuses to import a unit as already on rent (§3.4)',
    errorFor('ZZZ-RENT').includes('check it out'),
    errorFor('ZZZ-RENT'),
  )
  check('flags an unreadable status', errorFor('ZZZ-STAT').includes('Unknown status'), errorFor('ZZZ-STAT'))

  const ok = rows.find((row) => row.assetTag === 'ZZZ-OK')!
  check(
    'a good row parses quoted commas and money',
    ok.errors.length === 0 && ok.model === 'Blower, 8 inch' && ok.purchaseCost === 1850,
    `model="${ok.model}" cost=${ok.purchaseCost}`,
  )
  check(
    'counts split correctly',
    analysis.validCount === 3 && analysis.errorCount === 6,
    `${analysis.validCount} valid / ${analysis.errorCount} with problems` +
      ' — the unknown-category row is now valid and creates its category on commit',
  )

  const withDefault = await analyzeImport(db, 'Asset Tag\nZZZ-DEF\n', fallback.id)
  check(
    'a default category fills in for rows that omit one',
    withDefault.rows?.[0]?.categoryId === fallback.id && withDefault.errorCount === 0,
  )
  const withoutDefault = await analyzeImport(db, 'Asset Tag\nZZZ-DEF\n', null)
  check(
    'without a default, a category-less row is an error',
    (withoutDefault.errorCount ?? 0) === 1,
    withoutDefault.rows?.[0]?.errors.join(' '),
  )

  console.log('\nCommit (rolled back)\n')

  try {
    await prismaUnscoped.$transaction(async (tx) => {
      const scoped = tx as unknown as Parameters<typeof analyzeImport>[0]
      const batch = 'Asset Tag,Model,Category\nZZZ-C1,One,Portable Monitors\nZZZ-C2,Two,Portable Monitors\n'
      const result = await analyzeImport(scoped, batch, null)
      const importable = (result.rows ?? []).filter((row) => row.errors.length === 0)

      await tx.asset.createMany({
        data: importable.map((row) => ({
          orgId: org.id,
          assetTag: row.assetTag,
          model: row.model,
          categoryId: row.categoryId!,
        })),
      })

      const created = await tx.asset.count({ where: { orgId: org.id, assetTag: { startsWith: 'ZZZ-C' } } })
      check('a batch commits every valid row', created === 2, `${created} rows created`)

      // Re-analysing the same file now sees them as duplicates.
      const again = await analyzeImport(scoped, batch, null)
      check(
        're-running the same file finds them already imported',
        again.errorCount === 2 && (again.rows ?? []).every((row) => row.errors[0].includes('Already in inventory')),
        again.rows?.map((row) => row.errors.join('')).join(' | '),
      )

      throw new Error('__ROLLBACK__')
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('__ROLLBACK__')) throw error
  }

  const leftover = await db.asset.count({ where: { assetTag: { startsWith: 'ZZZ-' } } })
  check('nothing leaked out of the rolled-back transaction', leftover === 0, `${leftover} left behind`)

  console.log(failures === 0 ? '\nAll import checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
