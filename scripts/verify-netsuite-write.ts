/**
 * NetSuite write-back: the doors, and that they are all locked by default.
 *
 * This is an integration that can damage somebody else's system, so the suite
 * is built around what must *not* happen rather than what must. Every check
 * either proves a guard refuses, or proves the one allowed write is the narrow
 * thing it claims to be.
 *
 * **No request ever leaves this process.** `fetch` is replaced for the duration
 * so a misconfigured environment cannot turn a test run into a real PATCH — and
 * so the send path can be exercised at all, which is the only way to know the
 * sandbox guard and the idempotency index actually work rather than merely
 * being written down.
 *
 *   npx tsx scripts/verify-netsuite-write.ts
 *
 * No dev server needed — this is the database and the write engine.
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { executeWrite, isSandboxAccount } from '../src/lib/netsuite/write'
import { planRentalWrite, rentalWriteKey, writeRentalStatus } from '../src/lib/netsuite/rental-write'
import { fieldIdProblem, isNetsuiteOwnedField, isOwnedRole } from '../src/lib/netsuite/field-ownership'
import type { NetsuiteCreds } from '../src/lib/netsuite/oauth'

const MARK = 'NSWRITE'
const SANDBOX: NetsuiteCreds = {
  accountId: '1234567_SB1',
  consumerKey: 'k',
  consumerSecret: 's',
  tokenId: 't',
  tokenSecret: 'ts',
}
const PRODUCTION: NetsuiteCreds = { ...SANDBOX, accountId: '1234567' }
const FIELD = 'custrecord_ah_rental_status'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

/** Every outbound request this run would have made. */
const sent: { url: string; method: string; body: unknown }[] = []
const realFetch = globalThis.fetch

function trapFetch(response: { ok: boolean; status: number; body: string }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
    } as Response
  }) as typeof fetch
}

async function main() {
  const org = await prismaUnscoped.organization.findFirstOrThrow({ where: { slug: 'teksolv' } })
  const asset = await prismaUnscoped.asset.findFirstOrThrow({
    where: { orgId: org.id },
    orderBy: { assetTag: 'asc' },
    select: { id: true, assetTag: true },
  })
  const user = await prismaUnscoped.user.findFirstOrThrow({
    where: { memberships: { some: { orgId: org.id } } },
    select: { id: true },
  })

  trapFetch({ ok: true, status: 200, body: '{"id":"9001"}' })

  try {
    // -----------------------------------------------------------------------
    console.log('\nField ownership is a rule, not a comment\n')
    // -----------------------------------------------------------------------

    check(
      "NetSuite's own assetstatus is refused",
      isNetsuiteOwnedField('assetstatus') && fieldIdProblem('assetstatus') !== null,
      'it drives depreciation and disposal — a checkout must never touch it',
    )
    check(
      'as are cost, depreciation and the ledger’s name for the asset',
      ['assetcost', 'assetdepreciationmethod', 'name', 'assetserialnumber'].every(
        (field) => fieldIdProblem(field) !== null,
      ),
      'AssetHub mirrors these; writing them back would let a local typo rename the book of record',
    )
    check(
      'a native field nobody thought to list is still refused',
      fieldIdProblem('somethingnativeandnew') !== null,
      'only custrecord… ids pass, so the native namespace is excluded wholesale rather than by list',
    )
    check('a custom field is allowed', fieldIdProblem(FIELD) === null, FIELD)
    check(
      'and only declared facts are writable',
      isOwnedRole('assetRentalStatus') && !isOwnedRole('assetCost' as never),
      'the role has to be one AssetHub declares itself the authority on',
    )

    // -----------------------------------------------------------------------
    console.log('\nA write needs an external id it already knows\n')
    // -----------------------------------------------------------------------

    await prismaUnscoped.netsuiteRef.deleteMany({
      where: { orgId: org.id, entityType: 'Asset', localId: asset.id },
    })

    const base = {
      orgId: org.id,
      rentalId: `${MARK}-rental`,
      assetId: asset.id,
      assetTag: asset.assetTag,
      phase: 'start' as const,
      actorUserId: user.id,
    }
    const fields = { fieldId: FIELD, onRent: 'On Rent', available: 'Available' }

    const unknown = await planRentalWrite(base, fields)
    check(
      'a unit NetSuite has never heard of produces no plan at all',
      'refusal' in unknown && unknown.refusal.includes('no NetSuite record'),
      'refusal' in unknown ? unknown.refusal : 'a plan was built',
    )
    check(
      'and there is no create path for it to fall back to',
      sent.length === 0,
      'nothing was sent — a gap in the read sync must never be closed by inventing an asset',
    )

    await prismaUnscoped.netsuiteRef.create({
      data: {
        orgId: org.id,
        entityType: 'Asset',
        localId: asset.id,
        netsuiteId: '9001',
        netsuiteType: 'customrecord_ncfar_asset',
        raw: { [FIELD]: 'Available' },
      },
    })

    const plan = await planRentalWrite(base, fields)
    check('with a known id, a plan is built', !('refusal' in plan))
    if ('refusal' in plan) throw new Error('expected a plan')

    check(
      'keyed on the local transition, not the payload',
      plan.idempotencyKey === rentalWriteKey(base.rentalId, asset.id, 'start'),
      plan.idempotencyKey,
    )

    // -----------------------------------------------------------------------
    console.log('\nDry run rehearses; it does not perform\n')
    // -----------------------------------------------------------------------

    const dry = await executeWrite({
      orgId: org.id,
      mode: 'DRY_RUN',
      creds: SANDBOX,
      allowProductionWrites: false,
      plan,
      actorUserId: user.id,
    })
    check('a dry run is recorded as planned', dry.status === 'PLANNED', dry.detail ?? '')
    check('and sends nothing', sent.length === 0, `${sent.length} requests made`)

    const dryRow = await prismaUnscoped.netsuiteWrite.findUniqueOrThrow({
      where: { id: dry.writeId! },
      select: { request: true, response: true, previous: true, attemptedById: true },
    })
    const request = dryRow.request as { method: string; url: string; body: Record<string, string> }
    check(
      'the recorded payload is the real one, built by the code that would send it',
      request.method === 'PATCH' && request.body[FIELD] === 'On Rent',
      `${request.method} … ${JSON.stringify(request.body)}`,
    )
    check(
      'a PATCH against a known id — structurally incapable of creating',
      request.url.includes('/record/v1/customrecord_ncfar_asset/9001'),
      request.url,
    )
    check('with no response, which is the point', dryRow.response === null)
    check('attributed to whoever triggered it', dryRow.attemptedById === user.id)

    // Driven through the real entry point rather than `executeWrite` directly,
    // because reading the mode off the org's config and recovering the prior
    // value are part of the path — and the prior value is the whole reason a
    // bad write is reversible.
    const hadConfig = await prismaUnscoped.netsuiteConfig.findUnique({
      where: { orgId: org.id },
      select: { id: true },
    })
    if (!hadConfig) {
      await prismaUnscoped.netsuiteConfig.create({
        data: {
          orgId: org.id,
          enabled: true,
          accountId: SANDBOX.accountId,
          consumerKey: SANDBOX.consumerKey,
          consumerSecret: SANDBOX.consumerSecret,
          tokenId: SANDBOX.tokenId,
          tokenSecret: SANDBOX.tokenSecret,
          writeMode: 'DRY_RUN',
          assetStatusField: FIELD,
          assetStatusOnRent: 'On Rent',
          assetStatusAvailable: 'Available',
        },
      })

      const viaEntry = await writeRentalStatus({ ...base, rentalId: `${MARK}-entry` })
      check(
        'the real entry point reads the org’s mode',
        viaEntry?.status === 'PLANNED' && viaEntry.mode === 'DRY_RUN',
        `${viaEntry?.status} / ${viaEntry?.mode}`,
      )
      const entryRow = await prismaUnscoped.netsuiteWrite.findUniqueOrThrow({
        where: { id: viaEntry!.writeId! },
        select: { previous: true },
      })
      check(
        'and records the prior value, so a bad write can be put back',
        JSON.stringify(entryRow.previous ?? {}).includes('Available'),
        JSON.stringify(entryRow.previous),
      )

      await prismaUnscoped.netsuiteConfig.update({
        where: { orgId: org.id },
        data: { writeMode: 'DISABLED' },
      })
      const offViaEntry = await writeRentalStatus({ ...base, rentalId: `${MARK}-off` })
      check(
        'and does nothing at all when the org has not opted in',
        offViaEntry === null,
        'no row, no refusal — an org that never touched this page leaves no trace in the log',
      )
    } else {
      console.log('  ..    skipped the entry-point checks — this org already has a NetSuite config')
    }

    // -----------------------------------------------------------------------
    console.log('\nProduction stays shut until it is opened on purpose\n')
    // -----------------------------------------------------------------------

    check('a sandbox account is recognised by its id', isSandboxAccount('1234567_SB1'))
    check('and a production one is not', !isSandboxAccount('1234567'))

    const refused = await executeWrite({
      orgId: org.id,
      mode: 'SEND',
      creds: PRODUCTION,
      allowProductionWrites: false,
      plan,
      actorUserId: user.id,
    })
    check('SEND against production is refused', refused.status === 'REFUSED', refused.detail ?? '')
    check('and nothing left the building', sent.length === 0, `${sent.length} requests made`)

    const off = await executeWrite({
      orgId: org.id,
      mode: 'DISABLED',
      creds: SANDBOX,
      allowProductionWrites: true,
      plan,
      actorUserId: user.id,
    })
    check('and off means off, whatever else is set', off.status === 'REFUSED' && sent.length === 0)

    // A correct role aimed at a NetSuite-owned field is still refused — the
    // check is on the resolved id, not only on the intent.
    const misaimed = await executeWrite({
      orgId: org.id,
      mode: 'SEND',
      creds: SANDBOX,
      allowProductionWrites: false,
      plan: { ...plan, fields: [{ role: 'assetRentalStatus', fieldId: 'assetstatus', value: 'x' }] },
      actorUserId: user.id,
    })
    check(
      'a right intention pointed at the wrong field is refused',
      misaimed.status === 'REFUSED' && sent.length === 0,
      misaimed.detail ?? '',
    )

    // -----------------------------------------------------------------------
    console.log('\nSending, once and only once\n')
    // -----------------------------------------------------------------------

    const first = await executeWrite({
      orgId: org.id,
      mode: 'SEND',
      creds: SANDBOX,
      allowProductionWrites: false,
      plan,
      actorUserId: user.id,
    })
    check('a sandbox send goes through', first.status === 'SENT', first.detail ?? '')
    check('exactly one request was made', sent.length === 1, `${sent.length}`)
    check(
      'as a PATCH carrying only the owned field',
      sent[0].method === 'PATCH' && JSON.stringify(sent[0].body) === JSON.stringify({ [FIELD]: 'On Rent' }),
      `${sent[0].method} ${JSON.stringify(sent[0].body)}`,
    )

    const again = await executeWrite({
      orgId: org.id,
      mode: 'SEND',
      creds: SANDBOX,
      allowProductionWrites: false,
      plan,
      actorUserId: user.id,
    })
    check(
      'the same transition fired twice writes once',
      again.status === 'DUPLICATE',
      again.detail ?? '',
    )
    check('and made no second request', sent.length === 1, `${sent.length} total`)

    // The database is the backstop, not the check above it.
    let indexHeld = false
    try {
      await prismaUnscoped.netsuiteWrite.create({
        data: {
          orgId: org.id,
          trigger: 'rental.start',
          entityType: 'Asset',
          localId: asset.id,
          netsuiteId: '9001',
          netsuiteType: 'customrecord_ncfar_asset',
          idempotencyKey: plan.idempotencyKey,
          mode: 'SEND',
          status: 'SENT',
          request: {},
        },
      })
    } catch (error) {
      indexHeld = (error as { code?: string }).code === 'P2002'
    }
    check(
      'and the database refuses a second SENT row even if the check were bypassed',
      indexHeld,
      'partial unique index on (orgId, idempotencyKey) where status = SENT',
    )

    // …while a failure stays retryable, which a plain unique index would break.
    const endPlan = { ...plan, idempotencyKey: `${plan.idempotencyKey}:end` }
    trapFetch({ ok: false, status: 400, body: '{"error":"nope"}' })
    const failed = await executeWrite({
      orgId: org.id,
      mode: 'SEND',
      creds: SANDBOX,
      allowProductionWrites: false,
      plan: endPlan,
      actorUserId: user.id,
    })
    check('a rejected write is recorded as failed', failed.status === 'FAILED', failed.detail ?? '')

    trapFetch({ ok: true, status: 200, body: '{"id":"9001"}' })
    const retried = await executeWrite({
      orgId: org.id,
      mode: 'SEND',
      creds: SANDBOX,
      allowProductionWrites: false,
      plan: endPlan,
      actorUserId: user.id,
    })
    check(
      'and can be retried — a failure must not consume the slot',
      retried.status === 'SENT',
      'the unique index is partial on SENT for exactly this reason',
    )

    const failedRow = await prismaUnscoped.netsuiteWrite.findFirst({
      where: { orgId: org.id, idempotencyKey: endPlan.idempotencyKey, status: 'FAILED' },
      select: { response: true },
    })
    check(
      'the rejection body is kept, so a bad write is diagnosable',
      JSON.stringify(failedRow?.response ?? {}).includes('nope'),
      JSON.stringify(failedRow?.response),
    )

    // -----------------------------------------------------------------------
    console.log('\nEverything is on the record\n')
    // -----------------------------------------------------------------------

    const log = await prismaUnscoped.netsuiteWrite.findMany({
      where: { orgId: org.id, localId: asset.id },
      select: { status: true, mode: true },
    })
    const statuses = new Set(log.map((row) => row.status))
    check(
      'planned, sent, refused, failed and duplicate all leave a row',
      ['PLANNED', 'SENT', 'REFUSED', 'FAILED', 'DUPLICATE'].every((status) =>
        statuses.has(status as never),
      ),
      [...statuses].join(', '),
    )
    check(
      'nothing was written outside the two sandbox sends',
      sent.length === 3,
      `${sent.length} requests: 1 sent, 1 rejected, 1 retried`,
    )
  } finally {
    globalThis.fetch = realFetch
    await prismaUnscoped.netsuiteWrite.deleteMany({ where: { orgId: org.id } })
    await prismaUnscoped.netsuiteConfig.deleteMany({
      where: { orgId: org.id, accountId: SANDBOX.accountId },
    })
    await prismaUnscoped.netsuiteRef.deleteMany({
      where: { orgId: org.id, netsuiteId: '9001', netsuiteType: 'customrecord_ncfar_asset' },
    })
    console.log('\n(write log and test ref cleaned up)')
    await prismaUnscoped.$disconnect()
  }

  console.log(failures === 0 ? '\nAll NetSuite write-back checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
