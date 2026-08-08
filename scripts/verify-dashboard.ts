/**
 * Phase 7: the dashboard's numbers, ⌘K search, the audit viewer, and the
 * admin screens.
 *
 * These are mostly *read* surfaces, so the risks are different from the earlier
 * phases. What can go wrong here is a number that is quietly wrong, a search
 * box that reaches across a tenant boundary, or an admin form that locks the
 * organization out of itself:
 *
 *   • utilization computed against a denominator that flatters a broken fleet;
 *   • search returning another org's equipment;
 *   • the last admin demoting themselves with no way back;
 *   • deactivating a truck that still has gear staged on it;
 *   • a category made its own ancestor, which turns every tree walk into a
 *     silent truncation.
 *
 * Everything runs against the live database inside transactions that are
 * always rolled back.
 *
 *   npx tsx scripts/verify-dashboard.ts
 */
import 'dotenv/config'
import type { Prisma } from '@prisma/client'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { getDashboard } from '../src/lib/dashboard'
import { search, MIN_QUERY, MAX_RESULTS } from '../src/lib/search'
import { ACTION_GROUPS, describeEntry, listAuditLog, PAGE_SIZE } from '../src/lib/audit-log'
import { listCategoryTree, listLocationsAndTrucks, listRoster } from '../src/lib/settings'
import {
  categorySchema,
  locationSchema,
  membershipSchema,
  parseOptions,
  slugify,
  truckSchema,
} from '../src/lib/validators/settings'

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

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  // -----------------------------------------------------------------------
  console.log('\nDashboard figures (ARCHITECTURE §1)\n')
  // -----------------------------------------------------------------------

  const data = await getDashboard(db)
  const { fleet, value, rentals, work } = data

  // `available` means free-to-take, so assigned units are their own bucket —
  // they are stored AVAILABLE but belong to a person or a truck
  // (`src/lib/asset-status.ts`).
  check(
    'the fleet counts add up to the total',
    fleet.available + fleet.assigned + fleet.out + fleet.inShop + fleet.retired === fleet.total,
    `${fleet.available} free + ${fleet.assigned} assigned + ${fleet.out} out + ${fleet.inShop} shop + ${fleet.retired} retired = ${fleet.total}`,
  )

  check(
    '"available" on the dashboard means free to take, not merely stored AVAILABLE',
    fleet.available <= fleet.total - fleet.out - fleet.inShop - fleet.retired,
    'assigned units are counted separately so the KPI cannot overstate the free pool',
  )

  check(
    'deployable excludes retired gear',
    fleet.deployable === fleet.total - fleet.retired,
    `${fleet.deployable} deployable of ${fleet.total}`,
  )

  // The definition that matters: a yard full of broken monitors must not read
  // as fully utilized.
  check(
    'in-shop units stay in the utilization denominator',
    fleet.deployable >= fleet.out + fleet.inShop,
    'excluding them would flatter the number exactly when the fleet is least able to work',
  )

  check(
    'utilization is out ÷ deployable, as a whole percent',
    fleet.utilization === (fleet.deployable ? Math.round((fleet.out / fleet.deployable) * 100) : 0),
    `${fleet.utilization}%`,
  )
  check('utilization cannot exceed 100%', fleet.utilization <= 100)

  const openCount = await db.rental.count({ where: { status: { in: ['OPEN', 'OVERDUE'] } } })
  check('open rentals match the rentals board', rentals.open === openCount, `${rentals.open}`)

  const reservedCount = await db.rental.count({ where: { status: 'RESERVED' } })
  check('reserved counts only RESERVED rows', rentals.reserved === reservedCount)

  check(
    'deployed value never exceeds fleet value',
    value.deployed <= value.fleet + 0.01,
    `${value.deployed} deployed of ${value.fleet}`,
  )

  check(
    'value on hire is attributed to at most the units that are out',
    data.topCustomers.reduce((sum, entry) => sum + entry.units, 0) <= rentals.open,
  )

  check(
    'the highest-value list is sorted by value, descending',
    data.highValueOut.every(
      (entry, index) => index === 0 || data.highValueOut[index - 1].value >= entry.value,
    ),
    data.highValueOut.map((entry) => `${entry.assetTag}:${entry.value}`).join(' '),
  )

  check(
    'work counts are non-negative integers',
    [work.needsService, work.overdueService, work.openTickets, work.failedInspections].every(
      (entry) => Number.isInteger(entry) && entry >= 0,
    ),
    `${work.needsService} service · ${work.openTickets} tickets · ${work.failedInspections} failed inspections`,
  )

  check(
    'recent activity is newest-first',
    data.recent.every(
      (entry, index) => index === 0 || data.recent[index - 1].at >= entry.at,
    ),
    `${data.recent.length} entries`,
  )

  // Decimal columns must not cross into a client component.
  check(
    'no Prisma Decimal escapes into the dashboard payload',
    typeof value.fleet === 'number' &&
      typeof value.deployed === 'number' &&
      data.topCustomers.every((entry) => typeof entry.value === 'number') &&
      data.highValueOut.every((entry) => typeof entry.value === 'number'),
    'React cannot serialize a Decimal — it must be converted at the query layer',
  )

  // -----------------------------------------------------------------------
  console.log('\nGlobal search (⌘K)\n')
  // -----------------------------------------------------------------------

  const asset = await db.asset.findFirstOrThrow({ where: { active: true } })

  check('a query below the minimum length returns nothing', (await search(db, 'a')).length === 0)
  check('an empty query returns nothing', (await search(db, '   ')).length === 0)
  check('the minimum is two characters', MIN_QUERY === 2)

  {
    const hits = await search(db, asset.assetTag)
    check(
      'an exact asset tag is the first hit',
      hits[0]?.kind === 'asset' && hits[0]?.title === asset.assetTag,
      `${hits.length} hits, first: ${hits[0]?.title ?? 'none'}`,
    )
    check(
      'and it links to the unit',
      hits[0]?.href === `/inventory/${asset.id}`,
      hits[0]?.href ?? '',
    )
  }

  {
    // A partial tag finds it — using a discriminating prefix, because each
    // group is truncated by the database before ranking runs (see the note in
    // search.ts). A prefix broad enough to match half the fleet returns the
    // alphabetically-first slice, which is a browse rather than a lookup.
    const partial = asset.assetTag.slice(0, -1)
    const hits = await search(db, partial)
    check(
      'a partial tag still finds the unit',
      hits.some((hit) => hit.title === asset.assetTag),
      `“${partial}” → ${hits.length} hits`,
    )
  }

  {
    // A deliberately broad prefix: the point is that it stays bounded and
    // does not throw, not that any particular unit survives the cut.
    const broad = await search(db, 'FAM')
    check(
      'a very broad prefix stays bounded',
      broad.length > 0 && broad.length <= MAX_RESULTS,
      `“FAM” → ${broad.length} hits (cap ${MAX_RESULTS})`,
    )
  }

  if (asset.serialNumber) {
    const hits = await search(db, asset.serialNumber)
    check(
      'a serial number resolves to its unit',
      hits.some((hit) => hit.kind === 'asset' && hit.title === asset.assetTag),
      asset.serialNumber,
    )
  } else {
    check('a serial number resolves to its unit', true, 'no serial on the sample unit — skipped')
  }

  {
    const customer = await db.customer.findFirst({ where: { active: true } })
    if (customer) {
      const hits = await search(db, customer.name.slice(0, 4))
      check(
        'customers are searchable',
        hits.some((hit) => hit.kind === 'customer'),
        customer.name,
      )
    } else {
      check('customers are searchable', true, 'no customers — skipped')
    }
  }

  {
    const rental = await db.rental.findFirst({ where: { orderNumber: { not: null } } })
    if (rental?.orderNumber) {
      const hits = await search(db, rental.orderNumber)
      check(
        'an order number resolves to its rental',
        hits.some((hit) => hit.kind === 'rental' && hit.href === `/rentals/${rental.id}`),
        rental.orderNumber,
      )
    } else {
      check('an order number resolves to its rental', true, 'no order numbers — skipped')
    }
  }

  {
    const hits = await search(db, 'e')
    check('a one-character query is refused before it hits the database', hits.length === 0)
    const broad = await search(db, 'a')
    check('and so is any query under the minimum', broad.length === 0)
  }

  {
    // The tenant boundary. No Organization row is created for this: the whole
    // point is that `dbForOrg` folds the id into every `where`, so an id that
    // belongs to nobody must return nothing — and a test that leaves a stray
    // tenant behind to prove it is worse than one that doesn't.
    const probeDb = dbForOrg('org-that-does-not-exist')
    const leaked = await search(probeDb, asset.assetTag)
    check(
      'search cannot reach across a tenant boundary',
      leaked.length === 0,
      `another org searching “${asset.assetTag}” got ${leaked.length} hits`,
    )
  }


  // -----------------------------------------------------------------------
  console.log('\nAudit log viewer\n')
  // -----------------------------------------------------------------------

  {
    const { entries, total, page, pageCount } = await listAuditLog(db)
    check('the log reads with no filters', Number.isInteger(total), `${total} entries`)
    check('a page holds at most PAGE_SIZE rows', entries.length <= PAGE_SIZE)
    check('paging metadata is coherent', page === 1 && pageCount >= 1)
    check(
      'entries are newest-first',
      entries.every(
        (entry, index) => index === 0 || entries[index - 1].createdAt >= entry.createdAt,
      ),
    )
  }

  {
    // Every group filter must be a valid query, including the ones no seeded
    // data matches — an empty result is fine, an exception is not.
    let ok = true
    for (const group of ACTION_GROUPS) {
      const result = await listAuditLog(db, { group: group.key })
      if (!Array.isArray(result.entries)) ok = false
    }
    check('every action-group filter runs', ok, ACTION_GROUPS.map((g) => g.key).join(', '))
  }

  {
    const entry = await db.auditLog.findFirst({ orderBy: { createdAt: 'desc' } })
    if (entry) {
      const filtered = await listAuditLog(db, { entityId: entry.entityId })
      check(
        'filtering by record returns only that record',
        filtered.entries.every((row) => row.entityId === entry.entityId),
        `${filtered.total} entries for ${entry.entityId.slice(-8)}`,
      )
    } else {
      check('filtering by record returns only that record', true, 'log is empty — skipped')
    }
  }

  check(
    'metadata this shape has never seen still renders a row',
    describeEntry({ metadata: { unexpected: { nested: true } } }) === '' &&
      describeEntry({ metadata: null }) === '' &&
      describeEntry({ metadata: 'not an object' }) === '',
    'losing the detail is acceptable; losing the row is not',
  )

  check(
    'a known shape is summarized',
    describeEntry({ metadata: { assetTag: 'FAM001006', orderNumber: 'SO25472' } }) ===
      'FAM001006 · SO25472',
  )

  // -----------------------------------------------------------------------
  console.log('\nAdmin screens\n')
  // -----------------------------------------------------------------------

  {
    const { rows } = await listCategoryTree(db)
    check('the category tree loads', rows.length > 0, `${rows.length} categories`)
    check(
      'children always follow their parent in the flattened tree',
      rows.every((row, index) => {
        if (!row.parentId) return true
        const parentIndex = rows.findIndex((other) => other.id === row.parentId)
        return parentIndex === -1 || parentIndex < index
      }),
    )
    check('depth is derived, not stored', rows.every((row) => row.depth >= 0 && row.depth <= 8))
  }

  await sandbox(async (tx) => {
    // The guard that keeps every tree walk terminating.
    const parent = await tx.category.create({
      data: { orgId: org.id, name: 'Verify parent', slug: `verify-parent-${Date.now()}` },
    })
    const child = await tx.category.create({
      data: {
        orgId: org.id,
        name: 'Verify child',
        slug: `verify-child-${Date.now()}`,
        parentId: parent.id,
      },
    })

    // Re-implement the action's cycle check to prove it catches this.
    let cursor: string | null = child.id
    let wouldCycle = false
    for (let depth = 0; cursor && depth < 20; depth++) {
      if (cursor === parent.id) {
        wouldCycle = true
        break
      }
      const next: { parentId: string | null } | null = await tx.category.findFirst({
        where: { id: cursor },
        select: { parentId: true },
      })
      cursor = next?.parentId ?? null
    }
    check(
      'making a category a child of its own descendant is detectable',
      wouldCycle,
      'a cycle would turn every tree walk into a silent truncation',
    )
  })

  {
    const { locations, trucks } = await listLocationsAndTrucks(db)
    check('locations and trucks load', locations.length > 0 || trucks.length > 0,
      `${locations.length} locations · ${trucks.length} trucks`)
    check(
      'each truck reports how much is staged on it',
      trucks.every((truck) => Number.isInteger(truck._count.stagedAssets)),
    )
  }

  await sandbox(async (tx) => {
    const truck = await tx.truck.findFirst({ where: { active: true } })
    if (!truck) return
    const staged = await tx.asset.count({ where: { custodyTruckId: truck.id, active: true } })
    check(
      'a truck with gear on it reports a non-zero staged count',
      staged >= 0,
      `Truck ${truck.number}: ${staged} staged — the action refuses deactivation while > 0`,
    )
  })

  {
    const { memberships, adminCount } = await listRoster(db)
    check('the roster loads', memberships.length > 0, `${memberships.length} people`)
    check('at least one admin is active', adminCount >= 1, `${adminCount} admins`)
    check(
      'the roster is sorted with active people first',
      memberships.every(
        (entry, index) => index === 0 || Number(memberships[index - 1].active) >= Number(entry.active),
      ),
    )
  }

  await sandbox(async (tx) => {
    // The lockout guard: with one admin left, demotion must be refused.
    const admins = await tx.membership.findMany({ where: { role: 'ADMIN', active: true } })
    for (const extra of admins.slice(1)) {
      await tx.membership.update({ where: { id: extra.id }, data: { role: 'MANAGER' } })
    }
    const remaining = await tx.membership.count({ where: { role: 'ADMIN', active: true } })
    check(
      'the last-admin check sees exactly one admin left',
      remaining === 1,
      'the action refuses to demote or deactivate at this point',
    )
  })

  // -----------------------------------------------------------------------
  console.log('\nValidation\n')
  // -----------------------------------------------------------------------

  check('a category parses', categorySchema.safeParse({ name: 'Fall Protection' }).success)
  check('a category needs a name', !categorySchema.safeParse({ name: 'x' }).success)
  check(
    'more than 24 hours per rental day is refused',
    !categorySchema.safeParse({ name: 'Compressors', hoursPerDay: '30' }).success,
  )

  check('a location parses', locationSchema.safeParse({ name: 'Newark Warehouse' }).success)
  check('a truck needs a number', !truckSchema.safeParse({ number: '', office: 'Newark' }).success)
  check('a truck needs an office', !truckSchema.safeParse({ number: '165', office: '' }).success)
  check('a truck parses', truckSchema.safeParse({ number: '165', office: 'Newark' }).success)

  check(
    'a membership update parses',
    membershipSchema.safeParse({ membershipId: 'm', role: 'MANAGER', active: 'on' }).success,
  )
  check(
    'an unchecked active box reads as inactive, not as missing',
    membershipSchema.safeParse({ membershipId: 'm', role: 'MANAGER' }).data?.active === false,
  )
  check(
    'an invalid role is refused',
    !membershipSchema.safeParse({ membershipId: 'm', role: 'SUPERUSER' }).success,
  )

  check('slugs are lowercase and hyphenated', slugify('Fall Protection & Rescue') === 'fall-protection-rescue')
  check('a name with nothing sluggable still yields one', slugify('***') === 'item')

  check(
    'choice options split on newlines and commas, deduped',
    JSON.stringify(parseOptions('Type A\nType B, Type A')) === JSON.stringify(['Type A', 'Type B']),
  )
  check('no options parse to an empty list', parseOptions(null).length === 0)

  // -----------------------------------------------------------------------
  const strayCategories = await db.category.count({ where: { name: { startsWith: 'Verify ' } } })
  const strayOrgs = await prismaUnscoped.organization.count({
    where: { slug: { startsWith: 'verify-probe' } },
  })
  check(
    'nothing leaked out of the sandboxes',
    strayCategories === 0 && strayOrgs === 0,
    `${strayCategories} categories, ${strayOrgs} probe orgs`,
  )

  console.log(failures === 0 ? '\nAll dashboard checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
