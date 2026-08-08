/**
 * Category taxonomy cleanup.
 *
 * Three separate problems were showing up as one symptom — nonsense groupings
 * in the utilization report:
 *
 *  1. **Two taxonomies at once.** Some categories are properly nested
 *     (`Confined Space` → `Access`) and others are flat rows whose *name*
 *     contains a separator (`Fall Protection > Harnesses`, with no parent). The
 *     report groups by category, so the same family renders as two unrelated
 *     buckets and "Fall Protection" appears not to contain its own children.
 *  2. **Misfiled items.** `Fall Protection > Harnesses` held nine things that
 *     are not harnesses: gas monitors, blowers, lifelines and a tripod.
 *  3. **Class follows category**, so a meter filed under Harnesses was being
 *     classified by a path that says nothing about gas detection.
 *
 * Everything here is idempotent and `--dry-run`-able. Assets are re-filed by
 * *model*, matched against the list below, so nothing moves that was not named.
 *
 *   npx tsx scripts/fix-category-taxonomy.ts --dry-run
 *   npx tsx scripts/fix-category-taxonomy.ts
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { classifyAssetType } from '../src/lib/validators/assets'

const dryRun = process.argv.includes('--dry-run')

/**
 * The flat `Parent > Child` rows to turn into real children.
 *
 * Every one of them, now — the whole tree in one pass. A flat row whose *name*
 * contains the separator groups separately from the parent it names, which is
 * why "Fall Protection" appeared not to contain its own children and why the
 * report showed one family as several buckets.
 *
 * Parents are created where they do not exist (`Rope Rescue`, `Rescue`,
 * `Medical`). One row needs a judgement rather than a rename and gets it
 * below.
 */
const NEST_UNDER_FALL_PROTECTION = ['Harnesses', 'Anchors', 'Lanyards', 'SRL/PFL']

/**
 * Flat rows whose parent is not where the name says.
 *
 * `SCBA > Cylinders` is the only one: a spare cylinder is respiratory kit, and
 * `Respiratory > SCBA` already exists holding the sets themselves. It becomes a
 * *sibling* of SCBA rather than a child of it, because the category picker
 * renders exactly two levels — a third would be invisible in the form that has
 * to select it.
 */
const REHOME: Record<string, { parent: string; name: string }> = {
  'SCBA > Cylinders': { parent: 'Respiratory', name: 'SCBA Cylinders' },
}

/** Models that are in the wrong place, and the path each belongs in. */
const REFILE: { match: RegExp; to: string; why: string }[] = [
  { match: /gas\s*atmospheric\s*monitor/i, to: 'Gas Detection > Portable Monitors', why: 'a meter is not fall protection' },
  { match: /confined\s*space\s*blower/i, to: 'Confined Space > Ventilation', why: 'an air mover is ventilation' },
  { match: /self[-\s]?retracting\s*lifeline/i, to: 'Fall Protection > Lifelines', why: 'an SRL is a lifeline' },
  { match: /entry\s*tripod/i, to: 'Confined Space', why: 'entry and retrieval gear' },
]

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const orgId = org.id

  const all = await prismaUnscoped.category.findMany({
    where: { orgId },
    include: { parent: { select: { name: true } }, _count: { select: { assets: true } } },
  })
  const byName = new Map(all.map((row) => [row.name, row]))

  const plan: string[] = []

  // --- 1. Access merges up into Confined Space -----------------------------
  //
  // "Rename Access → Confined Space" cannot be a rename: Confined Space already
  // exists and is Access's own parent, so renaming would give
  // `Confined Space > Confined Space`. Merging the leaf up is what that
  // instruction means in the tree as it actually stands.
  const access = byName.get('Access')
  const confinedSpace = byName.get('Confined Space')
  if (access && confinedSpace && access.parentId === confinedSpace.id) {
    plan.push(`merge "Access" (${access._count.assets} assets) up into "Confined Space"`)
    if (!dryRun) {
      await prismaUnscoped.asset.updateMany({
        where: { categoryId: access.id },
        data: { categoryId: confinedSpace.id },
      })
      await prismaUnscoped.category.updateMany({
        where: { parentId: access.id },
        data: { parentId: confinedSpace.id },
      })
      await prismaUnscoped.category.delete({ where: { id: access.id } })
    }
  }

  // --- 2. Flat "Fall Protection > X" rows become real children -------------
  const fallProtection = byName.get('Fall Protection')
  if (fallProtection) {
    for (const child of NEST_UNDER_FALL_PROTECTION) {
      const flat = byName.get(`Fall Protection > ${child}`)
      if (!flat || flat.parentId) continue

      const existing = byName.get(child)
      if (existing && existing.parentId === fallProtection.id) {
        // A properly-nested one already exists — fold the flat row into it
        // rather than ending up with two categories called the same thing.
        plan.push(`fold flat "Fall Protection > ${child}" into the existing "${child}"`)
        if (!dryRun) {
          await prismaUnscoped.asset.updateMany({
            where: { categoryId: flat.id },
            data: { categoryId: existing.id },
          })
          await prismaUnscoped.category.delete({ where: { id: flat.id } })
        }
        continue
      }

      plan.push(`nest "Fall Protection > ${child}" as Fall Protection → ${child}`)
      if (!dryRun) {
        await prismaUnscoped.category.update({
          where: { id: flat.id },
          data: { name: child, slug: slugify(`fall-protection-${child}`), parentId: fallProtection.id },
        })
      }
    }
  }

  // --- 2b. Every other flat row -------------------------------------------
  const flatRows = await prismaUnscoped.category.findMany({
    where: { orgId, parentId: null, name: { contains: ' > ' } },
    select: { id: true, name: true, slug: true },
    orderBy: { name: 'asc' },
  })

  const plannedParents = new Set<string>()
  for (const row of flatRows) {
    const rehome = REHOME[row.name]
    const [namedParent, ...rest] = row.name.split(' > ')
    const parentName = rehome?.parent ?? namedParent
    const childName = rehome?.name ?? rest.join(' > ')
    if (!parentName || !childName) continue

    let parent = await prismaUnscoped.category.findFirst({
      where: { orgId, name: parentName, parentId: null },
      select: { id: true },
    })
    if (!parent && !plannedParents.has(parentName)) {
      // Tracked, because a dry run creates nothing — without this the plan
      // reports "create parent" once per child and reads like nine duplicates.
      plannedParents.add(parentName)
      plan.push(`create parent "${parentName}"`)
      if (!dryRun) {
        parent = await prismaUnscoped.category.create({
          data: { orgId, name: parentName, slug: slugify(parentName) },
          select: { id: true },
        })
      }
    }

    plan.push(
      rehome
        ? `re-home "${row.name}" as ${parentName} → ${childName}`
        : `nest "${row.name}" as ${parentName} → ${childName}`,
    )
    if (!dryRun && parent) {
      // An existing child of that name absorbs the row rather than sitting
      // beside a duplicate.
      const twin = await prismaUnscoped.category.findFirst({
        where: { orgId, name: childName, parentId: parent.id },
        select: { id: true },
      })
      if (twin) {
        await prismaUnscoped.asset.updateMany({
          where: { categoryId: row.id },
          data: { categoryId: twin.id },
        })
        await prismaUnscoped.category.delete({ where: { id: row.id } })
      } else {
        await prismaUnscoped.category.update({
          where: { id: row.id },
          data: {
            name: childName,
            slug: slugify(`${parentName}-${childName}`),
            parentId: parent.id,
          },
        })
      }
    }
  }

  // --- 3. Re-file what was never a harness ---------------------------------
  const fresh = await prismaUnscoped.category.findMany({
    where: { orgId },
    include: { parent: { select: { name: true } } },
  })
  const pathToId = new Map(
    fresh.map((row) => [row.parent ? `${row.parent.name} > ${row.name}` : row.name, row.id]),
  )

  const harnesses = fresh.find(
    (row) => row.name === 'Harnesses' || row.name === 'Fall Protection > Harnesses',
  )

  const moved: { assetTag: string; model: string; to: string }[] = []
  if (harnesses) {
    const inside = await prismaUnscoped.asset.findMany({
      where: { categoryId: harnesses.id },
      select: { id: true, assetTag: true, model: true, assetType: true },
    })

    for (const asset of inside) {
      const rule = REFILE.find((entry) => entry.match.test(asset.model ?? ''))
      if (!rule) continue
      const targetId = pathToId.get(rule.to)
      if (!targetId) {
        plan.push(`!! no category "${rule.to}" — ${asset.assetTag} left where it is`)
        continue
      }
      moved.push({ assetTag: asset.assetTag, model: asset.model ?? '', to: rule.to })
      if (!dryRun) {
        await prismaUnscoped.asset.update({
          where: { id: asset.id },
          data: { categoryId: targetId },
        })
      }
    }
  }

  // --- 4. Re-classify what moved, upwards only -----------------------------
  //
  // The classifier is an import-time default that leans RESCUE on purpose, and
  // re-running it as an *override* would demote units somebody deliberately
  // made rentable — the tripods and lifelines here are on live rental orders.
  // So it promotes to RENTAL where the new path says so and never the reverse.
  const promoted: string[] = []
  for (const entry of moved) {
    const wants = classifyAssetType(entry.to)
    if (wants !== 'RENTAL') continue
    const asset = await prismaUnscoped.asset.findFirst({
      where: { orgId, assetTag: entry.assetTag },
      select: { id: true, assetType: true },
    })
    if (!asset || asset.assetType === 'RENTAL') continue
    promoted.push(`${entry.assetTag} → RENTAL (${entry.to})`)
    if (!dryRun) {
      await prismaUnscoped.asset.update({ where: { id: asset.id }, data: { assetType: 'RENTAL' } })
    }
  }

  // --- report ---------------------------------------------------------------
  console.log('Structure:')
  for (const line of plan) console.log(`  ${line}`)
  if (plan.length === 0) console.log('  (already correct)')

  console.log(`\nRe-filed ${moved.length} asset(s) out of Harnesses:`)
  for (const entry of moved) {
    console.log(`  ${entry.assetTag.padEnd(14)} ${entry.model.slice(0, 34).padEnd(36)} → ${entry.to}`)
  }

  console.log(`\nRe-classified ${promoted.length}:`)
  for (const line of promoted) console.log(`  ${line}`)
  if (promoted.length === 0) {
    console.log('  (nothing needed promoting — promote-only, so nothing was demoted either)')
  }

  const stillFlat = (
    await prismaUnscoped.category.findMany({
      where: { orgId, name: { contains: ' > ' }, parentId: null },
      select: { name: true, _count: { select: { assets: true } } },
    })
  ).sort((a, b) => a.name.localeCompare(b.name))
  if (stillFlat.length > 0) {
    console.log(`\nStill flat, left alone — these need a taxonomy decision, not a rename:`)
    for (const row of stillFlat) {
      console.log(`  ${row.name.padEnd(34)} ${row._count.assets} assets`)
    }
  }

  if (dryRun) console.log('\n(dry run — nothing changed)')
}

main().finally(() => prismaUnscoped.$disconnect())
