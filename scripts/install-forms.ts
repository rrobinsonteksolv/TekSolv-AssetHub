/**
 * Install (or refresh) the built-in printed forms into every organization.
 *
 *   npm run db:forms
 *
 * Safe to run against a live database, which is the whole reason it is not
 * part of `db:seed`: the seed replaces a template's items wholesale, and that
 * is a foreign-key violation the moment an inspection has answered any of
 * them. This reconciles instead —
 *
 *   • an item that already exists (same template, same section + label) is
 *     updated in place, so historical responses keep pointing at it;
 *   • a new item is added;
 *   • an item no longer on the form is removed only if nothing has answered
 *     it, and otherwise pushed to the end and made non-critical, because a
 *     filed inspection has to keep rendering the question it answered.
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { BUILT_IN_FORMS } from '../src/lib/inspection-forms'

async function main() {
  const orgs = await prismaUnscoped.organization.findMany({ where: { active: true } })
  if (orgs.length === 0) {
    console.log('No organizations yet — run `npm run db:seed` first.')
    return
  }

  for (const org of orgs) {
    for (const form of BUILT_IN_FORMS) {
      // Bind to a category if the org has a matching one; otherwise leave the
      // template unbound, which makes it apply to any equipment rather than
      // silently apply to nothing.
      const category = await prismaUnscoped.category.findFirst({
        where: { orgId: org.id, slug: { in: form.categorySlugs } },
        select: { id: true, name: true },
      })

      const template = await prismaUnscoped.inspectionTemplate.upsert({
        where: { orgId_slug: { orgId: org.id, slug: form.slug } },
        update: {
          name: form.name,
          description: form.description,
          categoryId: category?.id ?? null,
        },
        create: {
          orgId: org.id,
          slug: form.slug,
          name: form.name,
          description: form.description,
          categoryId: category?.id ?? null,
        },
      })

      const existing = await prismaUnscoped.inspectionTemplateItem.findMany({
        where: { templateId: template.id },
      })
      const key = (section: string | null, label: string) => `${section ?? ''}||${label}`
      const byKey = new Map(existing.map((item) => [key(item.section, item.label), item]))
      const wanted = new Set(form.items.map((item) => key(item.section, item.label)))

      let added = 0
      let updated = 0

      for (const [index, item] of form.items.entries()) {
        const match = byKey.get(key(item.section, item.label))
        const data = {
          label: item.label,
          section: item.section,
          responseType: form.responseType,
          required: true,
          // Every FP-01 item is critical; the form says so explicitly.
          failCreatesTicket: item.critical ?? true,
          order: index,
        }
        if (match) {
          await prismaUnscoped.inspectionTemplateItem.update({ where: { id: match.id }, data })
          updated++
        } else {
          await prismaUnscoped.inspectionTemplateItem.create({
            data: { orgId: org.id, templateId: template.id, ...data },
          })
          added++
        }
      }

      let retired = 0
      let removed = 0
      for (const item of existing) {
        if (wanted.has(key(item.section, item.label))) continue
        const answered = await prismaUnscoped.inspectionResponse.count({
          where: { itemId: item.id },
        })
        if (answered === 0) {
          await prismaUnscoped.inspectionTemplateItem.delete({ where: { id: item.id } })
          removed++
        } else {
          await prismaUnscoped.inspectionTemplateItem.update({
            where: { id: item.id },
            data: { order: 9_000, required: false, failCreatesTicket: false },
          })
          retired++
        }
      }

      console.log(
        `${org.slug} · ${form.formCode} ${form.name}: ${added} added, ${updated} updated` +
          `${removed ? `, ${removed} removed` : ''}${retired ? `, ${retired} kept for history` : ''}` +
          ` — ${category ? `bound to ${category.name}` : 'applies to any category'}`,
      )
    }
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
