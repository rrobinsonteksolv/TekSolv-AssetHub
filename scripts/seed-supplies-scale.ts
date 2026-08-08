/**
 * Seed a realistic supply catalogue, so the page is designed against the scale
 * it has to survive rather than against five rows.
 *
 * Everything created is tagged with a SKU prefix and removed by `--undo`, so
 * this never becomes data somebody has to clean up by hand later.
 *
 *   npx tsx scripts/seed-supplies-scale.ts
 *   npx tsx scripts/seed-supplies-scale.ts --undo
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'

const PREFIX = 'SCALE-'
const undo = process.argv.includes('--undo')

/** name, unit, lot-tracked, gasType, concentration */
type Item = [string, string, boolean, string?, string?]

const CATALOGUE: Item[] = [
  // Calibration gas — lot-tracked, dated cylinders.
  ['Quad gas 34L (LEL/O2/CO/H2S)', 'cylinder', true, 'Quad', '50% LEL'],
  ['Methane 2.5% vol 58L', 'cylinder', true, 'CH4', '2.5% vol'],
  ['Carbon monoxide 100 PPM 34L', 'cylinder', true, 'CO', '100 PPM'],
  ['Hydrogen sulfide 25 PPM 34L', 'cylinder', true, 'H2S', '25 PPM'],
  ['Sulfur dioxide 10 PPM 34L', 'cylinder', true, 'SO2', '10 PPM'],
  ['Ammonia 50 PPM 58L', 'cylinder', true, 'NH3', '50 PPM'],
  ['Chlorine 10 PPM 34L', 'cylinder', true, 'Cl2', '10 PPM'],
  ['Oxygen 18% 34L', 'cylinder', true, 'O2', '18%'],
  ['Pentane 25% LEL 58L', 'cylinder', true, 'C5H12', '25% LEL'],
  ['Zero air 103L', 'cylinder', true, 'Zero air', '20.9% O2'],
  ['Propane 0.5% vol 34L', 'cylinder', true, 'C3H8', '0.5% vol'],
  ['Nitrogen dioxide 5 PPM 34L', 'cylinder', true, 'NO2', '5 PPM'],

  // Filters and cartridges — lot-tracked, they expire.
  ['P100 particulate filter', 'pair', true],
  ['Organic vapour cartridge', 'pair', true],
  ['Acid gas cartridge', 'pair', true],
  ['Multi-gas / vapour cartridge', 'pair', true],
  ['Ammonia / methylamine cartridge', 'pair', true],
  ['Formaldehyde cartridge', 'pair', true],
  ['Mercury vapour cartridge', 'pair', true],
  ['N95 respirator', 'box', true],
  ['PAPR HE filter', 'each', true],
  ['SCBA particulate filter', 'each', true],
  ['Escape hood filter canister', 'each', true],

  // PPE — counted, not dated.
  ['Nitrile gloves, large', 'box', false],
  ['Nitrile gloves, extra large', 'box', false],
  ['Cut-resistant gloves A4', 'pair', false],
  ['Leather rigging gloves', 'pair', false],
  ['Safety glasses, clear', 'pair', false],
  ['Safety glasses, smoke', 'pair', false],
  ['Goggles, indirect vent', 'pair', false],
  ['Face shield', 'each', false],
  ['Hard hat, full brim', 'each', false],
  ['Hard hat suspension', 'each', false],
  ['Hearing protection, corded', 'pair', false],
  ['Hearing protection, banded', 'each', false],
  ['Tyvek coverall, XL', 'each', false],
  ['Tyvek coverall, 2XL', 'each', false],
  ['Chemical splash suit', 'each', false],
  ['Rubber overboots', 'pair', false],
  ['High-vis vest, class 2', 'each', false],
  ['Knee pads', 'pair', false],
  ['Fall-arrest lanyard tag', 'each', false],

  // Shop and field consumables.
  ['Calibration tubing, 3ft', 'each', false],
  ['Regulator O-ring kit', 'each', false],
  ['Sensor filter disc', 'each', false],
  ['Lens cleaning wipes', 'box', false],
  ['Alcohol prep pads', 'box', false],
  ['Zip ties, 8in', 'bag', false],
  ['Electrical tape', 'roll', false],
  ['Duct tape', 'roll', false],
  ['Barricade tape', 'roll', false],
  ['Permanent marker', 'each', false],
  ['Asset label stock, 2.25x1.25', 'roll', false],
  ['Cal sticker stock', 'roll', false],
  ['Thermal printer ribbon', 'each', false],
  ['Battery, AA', 'pack', false],
  ['Battery, 9V', 'pack', false],
  ['Battery, CR123A', 'pack', false],
  ['Confined space entry log pad', 'pad', false],
  ['Lockout tag, danger', 'pack', false],
  ['Absorbent pad', 'bale', false],
  ['Spill kit refill', 'each', false],
]

/** Deterministic pseudo-randomness, so a re-run produces the same catalogue. */
function rng(seed: number) {
  let value = seed
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648
    return value / 2147483648
  }
}

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })

  if (undo) {
    const items = await prismaUnscoped.consumable.findMany({
      where: { orgId: org.id, sku: { startsWith: PREFIX } },
      select: { id: true },
    })
    const ids = items.map((row) => row.id)
    await prismaUnscoped.consumableTxn.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumableLot.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumableStock.deleteMany({ where: { consumableId: { in: ids } } })
    await prismaUnscoped.consumable.deleteMany({ where: { id: { in: ids } } })
    console.log(`removed ${ids.length} seeded supply items`)
    return
  }

  const offices = await prismaUnscoped.location.findMany({
    where: { orgId: org.id, active: true, type: { in: ['OFFICE', 'WAREHOUSE'] } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  const actor = await prismaUnscoped.user.findFirstOrThrow({ select: { id: true } })
  const random = rng(20260808)
  const today = Date.now()

  let made = 0
  for (const [index, [name, unit, lotTracked, gasType, concentration]] of CATALOGUE.entries()) {
    const existing = await prismaUnscoped.consumable.findFirst({
      where: { orgId: org.id, name },
      select: { id: true },
    })
    if (existing) continue

    const item = await prismaUnscoped.consumable.create({
      data: {
        orgId: org.id,
        name,
        sku: `${PREFIX}${String(index + 1).padStart(3, '0')}`,
        unit,
        lotTracked,
        expiryLeadDays: lotTracked ? 45 : 30,
      },
    })

    if (gasType) {
      // Everything seeded here is a single-gas cylinder except the quad, which
      // is the case this field exists for.
      const components =
        gasType === 'Quad'
          ? [
              { gas: 'H2S', amount: '25', unit: 'PPM' as const },
              { gas: 'CO', amount: '100', unit: 'PPM' as const },
              { gas: 'O2', amount: '18', unit: 'PERCENT_VOL' as const },
              { gas: 'LEL/CH4', amount: '50', unit: 'PERCENT_LEL' as const },
            ]
          : [
              {
                gas: gasType,
                amount: (concentration ?? '').replace(/[^0-9.]/g, '') || '0',
                unit: /lel/i.test(concentration ?? '')
                  ? ('PERCENT_LEL' as const)
                  : /%/.test(concentration ?? '')
                    ? ('PERCENT_VOL' as const)
                    : ('PPM' as const),
              },
            ]
      await prismaUnscoped.gasComponent.createMany({
        data: components.map((component, position) => ({
          orgId: org.id,
          consumableId: item.id,
          gas: component.gas,
          amount: component.amount,
          unit: component.unit,
          position,
        })),
      })
    }
    made += 1

    // Stocked in two or three offices, with a reorder point somewhere near the
    // count so the page has a realistic mix of fine, low and empty.
    const shuffled = [...offices].sort(() => random() - 0.5).slice(0, 2 + Math.floor(random() * 2))
    for (const office of shuffled) {
      const quantity = Math.floor(random() * 40)
      const reorderPoint = Math.floor(random() * 12)

      await prismaUnscoped.consumableStock.create({
        data: {
          orgId: org.id,
          consumableId: item.id,
          locationId: office.id,
          onHand: lotTracked ? 0 : quantity,
          reorderPoint,
        },
      })

      if (lotTracked && quantity > 0) {
        const lots = 1 + Math.floor(random() * 3)
        let left = quantity
        for (let n = 0; n < lots; n++) {
          const take = n === lots - 1 ? left : Math.max(1, Math.floor(left / 2))
          left -= take
          if (take <= 0) continue
          // A spread of dates: some long-dated, some inside the warning
          // window, a few already gone.
          const offsetDays = Math.floor(random() * 900) - 120
          await prismaUnscoped.consumableLot.create({
            data: {
              orgId: org.id,
              consumableId: item.id,
              locationId: office.id,
              lotNumber: `${String(26 + (n % 2))}-${String(1000 + Math.floor(random() * 8999))}`,
              quantity: take,
              expiresAt: new Date(today + offsetDays * 86_400_000),
              receivedAt: new Date(today - Math.floor(random() * 180) * 86_400_000),
            },
          })
        }
        await prismaUnscoped.consumableStock.update({
          where: {
            orgId_consumableId_locationId: {
              orgId: org.id,
              consumableId: item.id,
              locationId: office.id,
            },
          },
          data: { onHand: quantity },
        })
      }

      if (quantity > 0) {
        await prismaUnscoped.consumableTxn.create({
          data: {
            orgId: org.id,
            consumableId: item.id,
            locationId: office.id,
            qtyDelta: quantity,
            reason: 'RESTOCK',
            note: 'Seeded for scale testing',
            userId: actor.id,
          },
        })
      }
    }
  }

  const total = await prismaUnscoped.consumable.count({ where: { orgId: org.id } })
  console.log(`created ${made} supply items · ${total} tracked in total`)
}

main().finally(() => prismaUnscoped.$disconnect())
