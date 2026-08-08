/**
 * Put a few multi-item orders on the board.
 *
 * The demo fleet's rentals all predate orders, so every one of them is a
 * one-line order — which is exactly the shape that makes an order-grouped board
 * look pointless. This adds the case the feature exists for: one customer, one
 * site, several units, and one of them already back so a partially-returned
 * order is visible too.
 *
 * The units are **created by this script**, not borrowed from the fleet: nearly
 * every real unit is staged on a truck or held at an area, and un-assigning
 * real gear to make a demo look good would change what the trucks are carrying.
 *
 * Removed again by `--undo`, units included.
 *
 *   npx tsx scripts/seed-multi-orders.ts [--undo]
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { listPickableAssets, windowFromNow } from '../src/lib/availability'
import { openSingleLineOrder } from '../src/lib/rental-orders'

const NOTE = 'Demo multi-item order'
const TAG = 'DEMO-ORD'
const MODELS = [
  '4 Gas Atmospheric Monitor',
  'Confined Space Blower 8in',
  'Self-Retracting Lifeline 30ft',
  'Entry Tripod + Winch',
]
const undo = process.argv.includes('--undo')

/** customer, job site, how many units, due in N days, how many already back */
const ORDERS: [string, string, number, number, number][] = [
  ['EQT', 'Marcellus Pad 7', 4, 9, 0],
  ['Range Resources', 'Washington Co. Turnaround', 3, 4, 1],
  ['Infinity Resources', 'Greene Co. Compressor', 2, -2, 0],
]

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  if (undo) {
    const orders = await prismaUnscoped.rentalOrder.findMany({
      where: { orgId: org.id, notes: NOTE },
      include: { lines: { select: { assetId: true } } },
    })
    // Every unit these orders held goes back on the shelf first — including
    // any borrowed from the real fleet by an earlier version of this script.
    // Deleting the rentals without doing so strands the unit OUT_ON_RENT with
    // nothing to explain why, and it silently leaves every picker.
    const heldIds = orders.flatMap((order) => order.lines.map((line) => line.assetId))
    await prismaUnscoped.rental.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } })
    await prismaUnscoped.rentalOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } })
    if (heldIds.length > 0) {
      await prismaUnscoped.asset.updateMany({
        where: { id: { in: heldIds }, status: 'OUT_ON_RENT' },
        data: { status: 'AVAILABLE' },
      })
    }
    const made = await prismaUnscoped.asset.findMany({
      where: { orgId: org.id, assetTag: { startsWith: TAG } },
      select: { id: true },
    })
    await prismaUnscoped.custodyEvent.deleteMany({ where: { assetId: { in: made.map((a) => a.id) } } })
    await prismaUnscoped.auditLog.deleteMany({ where: { entityId: { in: made.map((a) => a.id) } } })
    await prismaUnscoped.asset.deleteMany({ where: { id: { in: made.map((a) => a.id) } } })
    console.log(`removed ${orders.length} demo order(s) and ${made.length} demo unit(s)`)
    return
  }

  /**
   * A category per model, rather than whatever `findFirst` happened to return.
   *
   * It used to take the first category in the table, which put gas monitors and
   * blowers into "Fall Protection > Harnesses" — demo data that then read as a
   * mislabelled taxonomy. Seed data that lies about the shape of the catalogue
   * is worse than no seed data.
   */
  const categoryFor = async (model: string) => {
    const wanted = /monitor/i.test(model)
      ? 'Portable Monitors'
      : /blower/i.test(model)
        ? 'Ventilation'
        : /lifeline/i.test(model)
          ? 'Lifelines'
          : 'Confined Space'
    const found = await prismaUnscoped.category.findFirst({
      where: { orgId: org.id, name: wanted },
      select: { id: true },
    })
    return (
      found ??
      (await prismaUnscoped.category.findFirstOrThrow({
        where: { orgId: org.id },
        orderBy: { name: 'asc' },
        select: { id: true },
      }))
    )
  }
  const staff = await prismaUnscoped.membership.findFirstOrThrow({
    where: { orgId: org.id, active: true, role: { in: ['ADMIN', 'MANAGER'] } },
    select: { userId: true },
  })

  let made = 0
  for (const [customerName, jobName, count, dueInDays, backCount] of ORDERS) {
    // Made here rather than taken from the shelf: the real fleet is almost
    // entirely staged on trucks or held at areas, and freeing gear to populate
    // a demo would change what those trucks are carrying.
    const pickable: { id: string }[] = []
    for (let index = 0; index < count; index++) {
      pickable.push(
        await prismaUnscoped.asset.create({
          data: {
            orgId: org.id,
            assetTag: `${TAG}-${made}-${index + 1}`,
            model: MODELS[index % MODELS.length],
            categoryId: (await categoryFor(MODELS[index % MODELS.length])).id,
            status: 'AVAILABLE',
            condition: 'GOOD',
            assetType: 'RENTAL',
            replacementCost: 1200 + index * 350,
            dailyRate: 45 + index * 10,
          },
          select: { id: true },
        }),
      )
    }

    const customer =
      (await prismaUnscoped.customer.findFirst({ where: { orgId: org.id, name: customerName } })) ??
      (await prismaUnscoped.customer.create({ data: { orgId: org.id, name: customerName } }))
    const job =
      (await prismaUnscoped.job.findFirst({ where: { orgId: org.id, name: jobName } })) ??
      (await prismaUnscoped.job.create({
        data: { orgId: org.id, name: jobName, customerId: customer.id },
      }))

    const checkoutDate = new Date(Date.now() - 3 * 86_400_000)
    const expectedReturnDate = new Date(Date.now() + dueInDays * 86_400_000)

    await prismaUnscoped.$transaction(async (tx) => {
      const orderId = await openSingleLineOrder(tx, {
        orgId: org.id,
        customerId: customer.id,
        jobId: job.id,
        orderNumber: `SO-${1000 + made}`,
        recordedById: staff.userId,
        checkedOutById: staff.userId,
        checkoutDate,
        expectedReturnDate,
        notes: NOTE,
      })

      for (const [index, asset] of pickable.entries()) {
        const back = index < backCount
        const line = await tx.rental.create({
          data: {
            orgId: org.id,
            orderId,
            assetId: asset.id,
            customerId: customer.id,
            jobId: job.id,
            orderNumber: `SO-${1000 + made}`,
            recordedById: staff.userId,
            checkedOutById: staff.userId,
            checkoutDate,
            expectedReturnDate,
            checkoutCondition: 'GOOD',
            status: back ? 'RETURNED' : dueInDays < 0 ? 'OVERDUE' : 'OPEN',
            ...(back
              ? {
                  actualReturnDate: new Date(Date.now() - 86_400_000),
                  checkinCondition: 'GOOD',
                  checkedInById: staff.userId,
                }
              : {}),
          },
        })

        if (!back) {
          await tx.$executeRaw`
            UPDATE "Rental"
            SET period = tstzrange(${checkoutDate}, ${expectedReturnDate}, '[)')
            WHERE id = ${line.id} AND "orgId" = ${org.id}
          `
          await tx.asset.update({
            where: { id: asset.id },
            data: {
              status: 'OUT_ON_RENT',
              custodyType: null,
              custodyUserId: null,
              custodyTruckId: null,
              custodyLocationId: null,
              custodyAssignedById: null,
              custodyAssignedAt: null,
            },
          })
        }
      }
    })

    made += 1
    console.log(
      `  ${customerName.padEnd(20)} ${count} unit(s), ${backCount} already back, due ${dueInDays}d`,
    )
  }

  console.log(`\n${made} demo order(s) created`)
}

main().finally(() => prismaUnscoped.$disconnect())
