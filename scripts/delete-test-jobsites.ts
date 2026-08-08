/**
 * Remove three jobsites that were typed in for testing and never used.
 *
 * Greene Co. Compressor, Marcellus Pad 7 and Washington Co. Turnaround. They
 * hold nothing, no kit sits at them, no custody record names them and nobody is
 * homed there — so they are clutter in every picker and nothing else.
 *
 * Run through `checkSiteDeletable`, the same guard the Delete button in
 * settings consults, rather than a hand-written DELETE. A safety net that one
 * caller skips is not a safety net, and a cleanup script is exactly the caller
 * most tempted to skip it.
 *
 *   npx tsx scripts/delete-test-jobsites.ts [--dry-run]
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { checkSiteDeletable } from '../src/lib/site-deletion'

const DOOMED = ['Greene Co. Compressor', 'Marcellus Pad 7', 'Washington Co. Turnaround']
const dryRun = process.argv.includes('--dry-run')

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  for (const name of DOOMED) {
    const site = await db.location.findFirst({ where: { name }, select: { id: true, name: true } })
    if (!site) {
      console.log(`${name.padEnd(28)} already gone`)
      continue
    }

    const check = await checkSiteDeletable(db, site.id)
    if (!check.deletable) {
      console.log(`${name.padEnd(28)} REFUSED — ${check.blockers.join(' ')}`)
      continue
    }

    if (dryRun) {
      console.log(`${name.padEnd(28)} would delete · unfiles ${check.unfiles} unit(s)`)
      continue
    }

    await db.$transaction(async (tx) => {
      // Only the catalogue address. These units are out on rent, so they hold
      // nothing and their rentals are untouched — what is cleared is the note
      // saying which site they were filed against.
      if (check.unfiles > 0) {
        await tx.asset.updateMany({ where: { locationId: site.id }, data: { locationId: null } })
      }
      await tx.location.delete({ where: { id: site.id } })
    })
    console.log(`${name.padEnd(28)} deleted · unfiled ${check.unfiles} unit(s)`)
  }
}

main().finally(() => prismaUnscoped.$disconnect())
