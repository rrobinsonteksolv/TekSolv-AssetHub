/**
 * NetSuite → AssetHub pull for one organization.
 *
 *   npx tsx scripts/sync-netsuite.ts [org-slug]
 *
 * Read-only against NetSuite; every write lands in AssetHub's own database,
 * scoped to the named tenant. Safe to re-run — NetsuiteRef makes it idempotent.
 * Wired up properly in Phase 8; this is the manual entry point until then.
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getAccountConfig } from '../src/lib/netsuite/client'
import {
  orgIdBySlug,
  syncCustomers,
  syncFamAssets,
  syncOpenRentals,
} from '../src/lib/netsuite/sync'

async function main() {
  const slug = process.argv[2] ?? process.env.NETSUITE_ORG_SLUG ?? 'teksolv'

  const orgId = await orgIdBySlug(slug)
  if (!orgId) {
    console.error(`No organization with slug "${slug}". Seed one first.`)
    process.exit(1)
  }

  const account = await getAccountConfig(orgId)
  if (!account) {
    console.log(
      `NetSuite is not configured for "${slug}" — set the NETSUITE_* env vars ` +
        'or fill in the org\'s NetsuiteConfig row. Nothing to do.',
    )
    return
  }

  console.log(`Syncing NetSuite → AssetHub for "${slug}"`)
  console.log(`  Related Asset column: ${account.rentalAssetColumn}`)
  console.log(`  Open-order status:    ${account.openStatusFilter}\n`)

  const db = dbForOrg(orgId)

  const customers = await syncCustomers(orgId, account)
  console.log(`Customers: +${customers.created} created, ${customers.updated} updated`)

  // Triage category for freshly-imported FAM assets — sorted into the real
  // tree by hand (or by syncRentalCatalog) afterwards.
  const inbox = await db.category.upsert({
    where: { orgId_slug: { orgId, slug: 'netsuite-import' } },
    update: {},
    create: { orgId, name: 'NetSuite Import (unsorted)', slug: 'netsuite-import' },
  })

  // FAM (customrecord_ncfar_asset) = TekSolv's serialized physical units.
  // Names are composites ("FAM001006 4 Gas MSA Atmospheric Monitor: 4095");
  // assetTag = the FAM number, serial → serialNumber, model → model.
  const assets = await syncFamAssets(orgId, inbox.id, { config: account })
  console.log(
    `FAM assets: +${assets.created} created, ${assets.updated} updated, ${assets.skipped} skipped (no usable tag)`,
  )

  // Open rentals — needs the Related Asset column id and a sync user.
  // Run AFTER assets + customers so the joins resolve.
  const rentals = await syncOpenRentals(orgId, account)
  console.log(
    `Open rentals: +${rentals.opened} opened, ${rentals.updated} updated, ${rentals.returned} reconciled-returned`,
  )

  await prismaUnscoped.netsuiteConfig.upsert({
    where: { orgId },
    update: { lastSyncedAt: new Date(), lastSyncLog: { customers, assets, rentals } },
    create: { orgId, lastSyncedAt: new Date(), lastSyncLog: { customers, assets, rentals } },
  })
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
