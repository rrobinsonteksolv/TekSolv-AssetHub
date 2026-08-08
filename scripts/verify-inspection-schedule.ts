/**
 * Inspection frequency, next-due, and the schedule it arms.
 *
 * The scenario the feature was asked for, run through the browser end to end:
 *
 *   • complete a harness inspection at Annual frequency
 *       → the FP-01 prints "Annual" and a next-due one year out
 *       → the unit shows an inspection schedule due then, in the same
 *         maintenance queue as calibration
 *       → and the real digest cron alerts on it as it approaches
 *   • complete another inspection
 *       → the *same* schedule moves forward. Not a second one.
 *   • fail an inspection
 *       → no next-due date, and the schedule is left where it is. A harness
 *         that failed is not squared away for a year.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-inspection-schedule.ts
 */
import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { pickTemplatesForAsset } from '../src/lib/inspections'
import { FP01_HARNESS } from '../src/lib/inspection-forms'
import {
  localISO,
  nextDueInput,
  DEFAULT_FREQUENCY_DAYS,
  frequencyLabel,
} from '../src/lib/inspection-frequency'
import { resolveSchedule } from '../src/lib/maintenance'
import { usDate } from '../src/lib/dates'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const DAY = 86_400_000

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

/**
 * A date as the *app* sees it — local, not UTC.
 *
 * `toISOString()` here was a latent bug that only appeared once the UTC day had
 * rolled over while it was still yesterday locally: the app computes due dates
 * in local time on purpose (see `nextDueInput` — "an inspector picking Annual on
 * the evening of the 4th should see next year's 4th"), so a UTC formatter in the
 * test compares two different calendars and reports a one-day drift that is not
 * there. Running the suite in the evening was enough to trip it.
 */
const on = (date: Date | null | undefined) => (date ? localISO(date) : null)

/**
 * The due date the runner will show, computed by the runner's own helper.
 *
 * Not `Date.now() + days * 86_400_000`: that is milliseconds, and a window
 * crossing a daylight-saving change is an hour shorter or longer than the
 * calendar says. Ninety days from 8 August 2026 crosses 1 November, so just
 * after midnight the millisecond version lands on the 5th while the app —
 * which adds *calendar days*, deliberately — says the 6th. The app is right;
 * reusing its helper is what stops the test inventing a second answer.
 */
const dueIn = (days: number) => nextDueInput(localISO(new Date()), days)

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
}

async function main() {
  const startedAt = new Date()
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)
  const template = await prismaUnscoped.inspectionTemplate.findFirstOrThrow({
    where: { orgId: org.id, slug: FP01_HARNESS.slug },
    include: { items: { orderBy: { order: 'asc' } } },
  })

  // Ask the app which unit this template is offered for rather than naming one
  // — the harnesses reach FP-01 by ancestor category match, and hard-coding a
  // tag is how these fixtures break the first time somebody uses the app.
  const candidates = await prismaUnscoped.asset.findMany({
    where: { orgId: org.id, active: true, status: 'AVAILABLE' },
    orderBy: { assetTag: 'asc' },
  })
  let found: (typeof candidates)[number] | null = null
  for (const candidate of candidates) {
    const offered = await pickTemplatesForAsset(db, candidate.id)
    if (offered.some((entry) => entry.template.id === template.id)) {
      found = candidate
      break
    }
  }
  if (!found) throw new Error('no available unit that FP-01 applies to')
  const harness = found

  const priorStatus = harness.status
  console.log(`\nInspecting ${harness.assetTag} — ${template.name}\n`)

  // Anything this run creates, so the fleet is left as it was found.
  const createdInspections: string[] = []
  let createdScheduleId: string | null = null

  // Snapshot the schedules already on this unit, *before* anything runs.
  // Adopting a supervisor's existing inspection schedule is a supported path
  // and the one this fleet actually takes — which means this script rewrites a
  // real row. Deleting it afterwards would destroy their data; the only honest
  // cleanup is to put every field back the way it was found.
  const priorSchedules = await prismaUnscoped.maintenanceSchedule.findMany({
    where: { assetId: harness.id },
  })

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  /** Run the full checklist and file it. Returns the filed inspection. */
  async function runInspection(options: { fail?: boolean } = {}) {
    await page.goto(`${BASE}/inspections/run?assetId=${harness.id}&templateId=${template.id}`, {
      waitUntil: 'networkidle',
    })

    const failItem = options.fail ? template.items[0] : null
    for (const item of template.items) {
      const value = item.id === failItem?.id ? 'FAIL' : 'PASS'
      await page.locator(`label:has(input[name="item.${item.id}.value"][value="${value}"])`).click()
    }

    const pad = page.locator('canvas').first()
    await pad.scrollIntoViewIfNeeded()
    const box = await pad.boundingBox()
    if (!box) throw new Error('signature pad has no box')
    await page.mouse.move(box.x + 20, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 30, box.y + 20, { steps: 12 })
    await page.mouse.up()

    await page.getByRole('button', { name: /File.*inspection/ }).click()
    // Filing lands on the filled FP-01 itself, not the inspection's detail
    // page — a signed report is the thing the tech wants in front of them.
    await page.waitForURL(/\/inspections\/[a-z0-9]{20,}\/form/, { timeout: 45_000 })

    const filed = await prismaUnscoped.inspection.findFirstOrThrow({
      where: { templateId: template.id, assetId: harness.id },
      orderBy: { createdAt: 'desc' },
    })
    createdInspections.push(filed.id)
    return filed
  }

  try {
    await signIn(page, 'sam@teksolv.com')

    // -----------------------------------------------------------------------
    console.log('The completion step asks the two questions\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/inspections/run?assetId=${harness.id}&templateId=${template.id}`, {
      waitUntil: 'networkidle',
    })

    check(
      'there is a frequency selector and a next-due date',
      (await page.locator('select').count()) > 0 &&
        (await page.locator('input[name="nextDueAt"]').isVisible()),
    )

    const selected = await page.locator('select').first().inputValue()
    check(
      'it defaults to Annual — competent-person inspection at least annually',
      selected === String(DEFAULT_FREQUENCY_DAYS),
      `${selected} days = ${frequencyLabel(Number(selected))}`,
    )

    const expectedDue = dueIn(DEFAULT_FREQUENCY_DAYS)
    const shownDue = await page.locator('input[name="nextDueAt"]').inputValue()
    check(
      'and auto-computes the next due date a year out',
      shownDue === expectedDue,
      `${shownDue} (expected ${expectedDue})`,
    )

    // Editable, and the interval drives it: switching to Quarterly moves the
    // date, and typing over it afterwards sticks.
    await page.locator('select').first().selectOption('90')
    await page.waitForTimeout(200)
    const quarterly = await page.locator('input[name="nextDueAt"]').inputValue()
    check(
      'changing the frequency recomputes the date',
      quarterly === dueIn(90),
      `Quarterly → ${quarterly}`,
    )

    const override = dueIn(45)
    await page.fill('input[name="nextDueAt"]', override)
    check(
      'and the date stays editable over the computed one',
      (await page.locator('input[name="nextDueAt"]').inputValue()) === override,
      override,
    )

    // Back to the scenario's Annual.
    await page.locator('select').first().selectOption(String(DEFAULT_FREQUENCY_DAYS))
    await page.waitForTimeout(200)
    check(
      'switching back re-arms the annual date',
      (await page.locator('input[name="nextDueAt"]').inputValue()) === expectedDue,
    )

    // -----------------------------------------------------------------------
    console.log('\nA passed inspection records the interval and arms a schedule\n')
    // -----------------------------------------------------------------------

    const first = await runInspection()

    check('the inspection filed as PASS', first.result === 'PASS', first.result)
    check(
      'the frequency is stored on the inspection, in days',
      first.frequencyDays === DEFAULT_FREQUENCY_DAYS,
      `${first.frequencyDays} days`,
    )
    check(
      'so is the next-due date, one year out',
      on(first.nextDueAt) === on(new Date(first.performedAt.getTime() + DEFAULT_FREQUENCY_DAYS * DAY)),
      `performed ${on(first.performedAt)} → due ${on(first.nextDueAt)}`,
    )

    const schedule = await prismaUnscoped.maintenanceSchedule.findFirstOrThrow({
      where: { assetId: harness.id, inspectionTemplateId: template.id },
    })
    const adopted = priorSchedules.some((entry) => entry.id === schedule.id)
    if (!adopted) createdScheduleId = schedule.id
    console.log(
      adopted
        ? `  (adopted the unit's existing "${schedule.label}" schedule)\n`
        : `  (created "${schedule.label}")\n`,
    )

    check(
      'it armed a maintenance schedule — not a parallel reminder system',
      schedule.type === 'INSPECTION' && schedule.basis === 'CALENDAR',
      `${schedule.label} · ${schedule.type} · ${schedule.basis}`,
    )
    check(
      'the interval is the frequency the inspector chose',
      schedule.intervalDays === DEFAULT_FREQUENCY_DAYS,
      `every ${schedule.intervalDays} days`,
    )
    check(
      'due on the date the form prints, performed on the date it was inspected',
      on(schedule.nextDue) === on(first.nextDueAt) &&
        on(schedule.lastPerformed) === on(first.performedAt),
      `last ${on(schedule.lastPerformed)} → next ${on(schedule.nextDue)}`,
    )
    check(
      'and its alert flags are clear, so the next approach warns',
      schedule.alertedAt === null && schedule.alertedState === null,
    )

    if (adopted) {
      const before = priorSchedules.find((entry) => entry.id === schedule.id)!
      check(
        'adopting an existing schedule keeps the operator’s label and notice period',
        schedule.label === before.label && schedule.leadDays === before.leadDays,
        `"${schedule.label}" · ${schedule.leadDays}d lead — theirs, not this action’s`,
      )
      check(
        'and takes it over rather than leaving a second one beside it',
        (await prismaUnscoped.maintenanceSchedule.count({
          where: { assetId: harness.id, type: 'INSPECTION', active: true },
        })) ===
          priorSchedules.filter((entry) => entry.type === 'INSPECTION' && entry.active).length,
      )
    }

    // -----------------------------------------------------------------------
    console.log('\nIt shows in the same queue and alerts like any other schedule\n')
    // -----------------------------------------------------------------------

    const queueRow = (await import('../src/lib/maintenance-queue')).listMaintenanceQueue
    const { rows } = await queueRow(db)
    const mine = rows.find((row) => row.scheduleId === schedule.id)
    check(
      'the maintenance queue lists it against the unit',
      Boolean(mine) && mine!.asset.assetTag === harness.assetTag,
      mine ? `${mine.asset.assetTag} · ${mine.schedule.label} · ${mine.schedule.detail}` : 'absent',
    )
    check(
      'reading as on-schedule today, a year from due',
      mine?.schedule.state === 'ok',
      `${mine?.schedule.state} · ${mine?.schedule.note}`,
    )

    // Wind the clock forward rather than the data: the same row, asked what it
    // is three days before it falls due.
    const nearly = new Date(schedule.nextDue!.getTime() - 3 * DAY)
    const soon = resolveSchedule(schedule, { rentals: [], now: nearly })
    check(
      'and as due-soon inside its lead window',
      soon.state === 'soon',
      `${on(nearly)} → ${soon.state} · ${soon.note}`,
    )
    const late = resolveSchedule(schedule, {
      rentals: [],
      now: new Date(schedule.nextDue!.getTime() + 2 * DAY),
    })
    check('and overdue past it', late.state === 'overdue', late.note)

    // --- the real cron, not a replica --------------------------------------
    // Move the due date into the lead window and let the actual endpoint run.
    // A replica of the sweep would pass even if the endpoint had stopped
    // calling it.
    const parked = schedule.nextDue!
    await prismaUnscoped.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { nextDue: new Date(Date.now() + 3 * DAY), alertedAt: null, alertedState: null },
    })

    const cronUrl = `${BASE}/api/cron/notifications${
      process.env.CRON_SECRET ? `?key=${encodeURIComponent(process.env.CRON_SECRET)}` : ''
    }`
    const cron = await fetch(cronUrl)
    const cronBody = (await cron.json()) as { maintenanceDue?: number }

    const alert = await prismaUnscoped.notification.findFirst({
      where: {
        orgId: org.id,
        type: 'MAINTENANCE_UPCOMING',
        title: { contains: harness.assetTag },
        createdAt: { gte: new Date(Date.now() - 120_000) },
      },
      orderBy: { createdAt: 'desc' },
    })
    check(
      'the digest cron alerts on it as it approaches',
      cron.ok && Boolean(alert),
      alert ? alert.title : `cron ${cron.status}, maintenanceDue=${cronBody.maintenanceDue}`,
    )
    check(
      'the alert names the inspection, not some other schedule on the unit',
      alert?.title?.includes(schedule.label) ?? false,
      alert?.title,
    )

    const claimed = await prismaUnscoped.maintenanceSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    })
    check(
      'and it is stamped so it does not re-announce the same stage',
      claimed.alertedState === 'soon' && claimed.alertedAt !== null,
      `alertedState=${claimed.alertedState}`,
    )

    await prismaUnscoped.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { nextDue: parked, alertedAt: null, alertedState: null },
    })

    // -----------------------------------------------------------------------
    console.log('\nThe printed form says what was decided\n')
    // -----------------------------------------------------------------------

    await page.goto(`${BASE}/inspections/${first.id}/form`, { waitUntil: 'networkidle' })
    const form = await page.locator('article').innerText()
    check(
      'the Inspection Record prints the frequency in words',
      form.includes('Annual'),
      'from Inspection.frequencyDays, not guessed from whatever schedule the unit carries',
    )
    check(
      'and the next inspection due one year out',
      form.includes(usDate(first.nextDueAt)!),
      `${usDate(first.nextDueAt)} on the form · ${on(first.nextDueAt)} in the column`,
    )

    // -----------------------------------------------------------------------
    console.log('\nThe next inspection moves the same schedule forward\n')
    // -----------------------------------------------------------------------

    const before = await prismaUnscoped.maintenanceSchedule.count({
      where: { assetId: harness.id, type: 'INSPECTION' },
    })

    // Age the schedule to a year ago so "moves forward" means something. Both
    // inspections happen today, so comparing two dates computed from today
    // would read as unchanged whether the reset worked or not — that is a test
    // that passes for the wrong reason.
    const stale = new Date(Date.now() - 10 * DAY)
    await prismaUnscoped.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: {
        lastPerformed: new Date(stale.getTime() - DEFAULT_FREQUENCY_DAYS * DAY),
        nextDue: stale,
        alertedAt: stale,
        alertedState: 'overdue',
      },
    })
    const overdue = resolveSchedule(
      await prismaUnscoped.maintenanceSchedule.findUniqueOrThrow({ where: { id: schedule.id } }),
      { rentals: [] },
    )
    check(
      'a schedule that has run out reads overdue in the queue',
      overdue.state === 'overdue',
      `due ${on(stale)} · ${overdue.note}`,
    )

    const second = await runInspection()
    const advanced = await prismaUnscoped.maintenanceSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    })
    const after = await prismaUnscoped.maintenanceSchedule.count({
      where: { assetId: harness.id, type: 'INSPECTION' },
    })

    check('it re-armed the same schedule, not a second one', after === before, `${after} schedule(s)`)
    check(
      'and the due date moved forward — an overdue unit is current again',
      on(advanced.nextDue) === on(second.nextDueAt) &&
        advanced.nextDue!.getTime() > stale.getTime() &&
        resolveSchedule(advanced, { rentals: [] }).state === 'ok',
      `${on(stale)} (overdue) → ${on(advanced.nextDue)}`,
    )
    check(
      'and the alert flags cleared again so it warns next time too',
      advanced.alertedState === null && advanced.alertedAt === null,
    )
    check(
      'the inspection is logged as service against that schedule',
      (await prismaUnscoped.maintenanceRecord.count({
        where: { scheduleId: schedule.id, type: 'INSPECTION' },
      })) >= 2,
      'so the Maintenance tab history and the inspection history agree',
    )

    // -----------------------------------------------------------------------
    console.log('\nA failed inspection is not a clean bill for a year\n')
    // -----------------------------------------------------------------------

    const parkedDue = advanced.nextDue
    const failed = await runInspection({ fail: true })

    check('the inspection filed as FAIL', failed.result === 'FAIL', failed.result)
    check(
      'no next-due date was recorded — a failed harness gets a ticket, not a date',
      failed.nextDueAt === null,
    )
    check(
      'the interval is still recorded, because that is the program not the outcome',
      failed.frequencyDays === DEFAULT_FREQUENCY_DAYS,
      `${failed.frequencyDays} days`,
    )

    const afterFail = await prismaUnscoped.maintenanceSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    })
    check(
      'and the schedule was left exactly where it was',
      on(afterFail.nextDue) === on(parkedDue) &&
        on(afterFail.lastPerformed) === on(second.performedAt),
      `still due ${on(afterFail.nextDue)}`,
    )

    check('no uncaught client errors throughout', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()

    // Put the fleet back. Only what this run created is removed — each delete
    // names the row by id or by the URL of the inspection that made it, never
    // "every attachment on this unit", which would take real documents with it.
    for (const id of createdInspections) {
      await prismaUnscoped.maintenanceTicket.deleteMany({ where: { sourceInspectionId: id } })
      await prismaUnscoped.attachment.deleteMany({ where: { url: `/inspections/${id}/form` } })
      await prismaUnscoped.inspectionResponse.deleteMany({ where: { inspectionId: id } })
      await prismaUnscoped.inspection.deleteMany({ where: { id } })
    }
    if (createdScheduleId) {
      await prismaUnscoped.maintenanceRecord.deleteMany({ where: { scheduleId: createdScheduleId } })
      await prismaUnscoped.maintenanceSchedule.deleteMany({ where: { id: createdScheduleId } })
    }

    // An adopted schedule is somebody's real row: put every field this run
    // touched back, and drop only the service records this run wrote against it.
    for (const prior of priorSchedules) {
      await prismaUnscoped.maintenanceRecord.deleteMany({
        where: { scheduleId: prior.id, performedAt: { gte: startedAt } },
      })
      await prismaUnscoped.maintenanceSchedule.update({
        where: { id: prior.id },
        data: {
          intervalDays: prior.intervalDays,
          lastPerformed: prior.lastPerformed,
          nextDue: prior.nextDue,
          inspectionTemplateId: prior.inspectionTemplateId,
          alertedAt: prior.alertedAt,
          alertedState: prior.alertedState,
          active: prior.active,
        },
      })
    }

    await prismaUnscoped.asset.update({ where: { id: harness.id }, data: { status: priorStatus } })
    console.log(
      `\n(restored ${harness.assetTag} to ${priorStatus}` +
        `${priorSchedules.length ? ` and ${priorSchedules.length} schedule(s) to how they were found` : ''})`,
    )
  }

  console.log(failures === 0 ? '\nAll inspection-schedule checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
