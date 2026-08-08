/**
 * Put the Rescue Prop's four bags back, from the sheet they came from.
 *
 * They were deleted by a verification suite's teardown: it removed containers
 * by name across the whole org, and its fixture happened to use the same bag
 * names as the real prop. The suite has since been scoped to its own holder so
 * it cannot reach live data again, and container names are now unique per
 * holder rather than per org — but the bags it took still have to come back.
 *
 * Rebuilt from `RescueProp_inventory_import.csv`, which carries the container
 * column for all fifty-one rows, so nothing here is guessed. Assets are matched
 * on asset tag and only ever have their `containerId` set — no custody, no
 * status, nothing else is touched.
 *
 *   npx tsx scripts/restore-prop-bags.ts [path-to-csv]
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import { prismaUnscoped } from '../src/lib/prisma'

const CSV =
  process.argv[2] ?? 'C:/Users/tapou/Downloads/RescueProp_inventory_import.csv'
const HOLDER = 'Rescue Prop'

async function main() {
  const rows = Papa.parse<Record<string, string>>(readFileSync(CSV, 'utf8'), {
    header: true,
    skipEmptyLines: true,
  }).data

  const byBag = new Map<string, string[]>()
  for (const row of rows) {
    const bag = (row.container ?? '').trim()
    const tag = (row.assetTag ?? '').trim()
    if (!bag || !tag) continue
    byBag.set(bag, [...(byBag.get(bag) ?? []), tag])
  }
  console.log(`${CSV}\n  ${rows.length} rows, ${byBag.size} bags`)

  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const location = await prismaUnscoped.location.findFirstOrThrow({
    where: { orgId: org.id, name: HOLDER },
  })

  for (const [bag, tags] of byBag) {
    const existing = await prismaUnscoped.container.findFirst({
      where: { orgId: org.id, locationId: location.id, name: bag },
    })
    const container =
      existing ??
      (await prismaUnscoped.container.create({
        data: { orgId: org.id, name: bag, locationId: location.id },
      }))

    const { count } = await prismaUnscoped.asset.updateMany({
      where: { orgId: org.id, assetTag: { in: tags } },
      data: { containerId: container.id },
    })
    console.log(
      `  ${bag.padEnd(28)} ${existing ? 'kept' : 'recreated'} — ${count} of ${tags.length} items filed`,
    )
    if (count !== tags.length) {
      const found = await prismaUnscoped.asset.findMany({
        where: { orgId: org.id, assetTag: { in: tags } },
        select: { assetTag: true },
      })
      const missing = tags.filter((tag) => !found.some((asset) => asset.assetTag === tag))
      console.log(`      not on file: ${missing.join(', ')}`)
    }
  }
}

main().finally(() => prismaUnscoped.$disconnect())
