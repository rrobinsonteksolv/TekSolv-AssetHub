/**
 * Reconcile assets and rentals that stopped agreeing.
 *
 * Two ways a fixture leaves the pair broken, and both block later work:
 *
 *  - **A line with no unit out.** A suite checks a unit out, fails before its
 *    teardown, and resets the asset to AVAILABLE while leaving the line OPEN.
 *    The line still holds a reservation window, so `rental_no_overlap` refuses
 *    every later checkout of that unit.
 *  - **A unit out with no line.** The reverse: the rentals are deleted and the
 *    asset is left OUT_ON_RENT. It then fails `availableInWindow` forever and
 *    quietly drops out of every picker.
 *
 * The constraint is right and the suites are what need fixing; this exists to
 * clear the wreckage one has already left.
 *
 *   npx tsx scripts/fix-orphan-rentals.ts [--dry-run]
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })

  const orphans = await prismaUnscoped.rental.findMany({
    where: {
      orgId: org.id,
      status: { in: ['OPEN', 'OVERDUE'] },
      asset: { status: { not: 'OUT_ON_RENT' } },
    },
    select: {
      id: true,
      orderId: true,
      createdAt: true,
      asset: { select: { assetTag: true, status: true } },
      order: { select: { customer: { select: { name: true } } } },
    },
  })

  const stranded = await prismaUnscoped.asset.findMany({
    where: {
      orgId: org.id,
      status: 'OUT_ON_RENT',
      rentals: { none: { status: { in: ['OPEN', 'OVERDUE'] } } },
    },
    select: { id: true, assetTag: true },
  })

  console.log(`${orphans.length} incoherent line(s):`)
  for (const row of orphans) {
    console.log(
      `  ${row.asset.assetTag.padEnd(14)} asset is ${row.asset.status}, line is open · ${row.order.customer?.name ?? 'internal'} · ${row.createdAt.toISOString().slice(0, 16)}`,
    )
  }
  console.log(`${stranded.length} stranded unit(s) — out on rent with no open line:`)
  for (const row of stranded) console.log(`  ${row.assetTag}`)

  if (orphans.length + stranded.length === 0 || dryRun) {
    if (dryRun && orphans.length + stranded.length) {
      console.log('\n(dry run — nothing changed)')
    }
    return
  }

  if (orphans.length > 0) {
    await prismaUnscoped.rental.deleteMany({ where: { id: { in: orphans.map((row) => row.id) } } })
    for (const orderId of new Set(orphans.map((row) => row.orderId))) {
      const left = await prismaUnscoped.rental.count({ where: { orderId } })
      if (left === 0) await prismaUnscoped.rentalOrder.delete({ where: { id: orderId } })
    }
  }

  if (stranded.length > 0) {
    // Back on the shelf. Custody is deliberately not restored — checkout
    // released it, and guessing which truck it came off would be inventing a
    // fact rather than recovering one.
    await prismaUnscoped.asset.updateMany({
      where: { id: { in: stranded.map((row) => row.id) } },
      data: { status: 'AVAILABLE' },
    })
  }

  console.log(`\ncleared ${orphans.length} line(s), freed ${stranded.length} unit(s)`)
}

main().finally(() => prismaUnscoped.$disconnect())
