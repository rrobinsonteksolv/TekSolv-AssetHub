/**
 * Proves the hard rules from BUILD_SPEC §3 are enforced by the *database*,
 * not merely by application code — the whole point of the GIST constraint and
 * the custody CHECKs. Run against a seeded dev database:
 *
 *   npx tsx scripts/verify-invariants.ts
 *
 * Every case creates its own throwaway data and rolls it back.
 */
import 'dotenv/config'
import { prismaUnscoped } from '../src/lib/prisma'
import { dbForOrg } from '../src/lib/tenant-db'
import { openSingleLineOrder } from '../src/lib/rental-orders'

/**
 * A rental fixture, with the order every rental now belongs to.
 *
 * Built through `openSingleLineOrder`, the same helper the app uses, so a
 * fixture cannot drift from the product — a suite that creates rentals its own
 * way ends up proving something the app has stopped doing.
 */
async function lineWithOrder<T>(
  client: Parameters<typeof openSingleLineOrder>[0] & {
    rental: { create(args: { data: Record<string, unknown> }): Promise<T> }
  },
  data: Record<string, unknown>,
): Promise<T> {
  const orderId = await openSingleLineOrder(client, {
    orgId: data.orgId as string,
    kind: (data.kind as 'CUSTOMER' | 'INTERNAL' | undefined) ?? 'CUSTOMER',
    customerId: (data.customerId as string | null | undefined) ?? null,
    jobId: (data.jobId as string | null | undefined) ?? null,
    orderNumber: (data.orderNumber as string | null | undefined) ?? null,
    contactName: (data.contactName as string | null | undefined) ?? null,
    destination: (data.destination as string | null | undefined) ?? null,
    recordedById: data.recordedById as string,
    checkedOutById: (data.checkedOutById as string | null | undefined) ?? null,
    checkoutDate: (data.checkoutDate as Date | undefined) ?? new Date(),
    expectedReturnDate: data.expectedReturnDate as Date,
    closedAt: (data.actualReturnDate as Date | null | undefined) ?? null,
  })
  return client.rental.create({ data: { ...data, orderId } })
}

const results: { name: string; ok: boolean; detail: string }[] = []

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`)
}

function pgCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.match(/code: "(\w+)"/)?.[1]
  const detail =
    message.match(/message: "([^"]+)"/)?.[1] ??
    message.match(/Unique constraint failed on the fields: \(([^)]+)\)/)?.[0] ??
    message.split('\n').filter(Boolean).pop() ??
    message
  return code ? `${code} — ${detail}` : detail.slice(0, 140)
}

/** Run `fn` and roll it back; report whether it was rejected. */
async function expectRejected(name: string, fn: (tx: unknown) => Promise<void>) {
  try {
    await prismaUnscoped.$transaction(async (tx) => {
      await fn(tx)
      throw new Error('__ROLLBACK_CLEAN__')
    })
    record(name, false, 'the database ACCEPTED it — invariant is not enforced')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('__ROLLBACK_CLEAN__')) {
      record(name, false, 'the database ACCEPTED it — invariant is not enforced')
    } else {
      record(name, true, `rejected: ${pgCode(error)}`)
    }
  }
}

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })
  const db = dbForOrg(org.id)

  const asset = await db.asset.findFirstOrThrow({ where: { status: 'AVAILABLE' } })
  const rented = await db.asset.findFirstOrThrow({ where: { status: 'OUT_ON_RENT' } })
  const truck = await db.truck.findFirstOrThrow({})
  const user = await prismaUnscoped.user.findFirstOrThrow({ where: { email: 'ray@teksolv.com' } })

  console.log('\nBUILD_SPEC §3.2 — reservation integrity lives in the database\n')

  await expectRejected('Two overlapping OPEN rentals for the same asset', async (tx) => {
    const client = tx as typeof prismaUnscoped
    for (const [from, to] of [
      ['2027-01-01', '2027-01-20'],
      ['2027-01-10', '2027-01-30'], // overlaps the first
    ]) {
      const rental = await lineWithOrder(client, {
          orgId: org.id,
          assetId: asset.id,
          recordedById: user.id,
          checkoutDate: new Date(`${from}T12:00:00Z`),
          expectedReturnDate: new Date(`${to}T12:00:00Z`),
          status: 'OPEN',
        })
      await client.$executeRaw`
        UPDATE "Rental"
        SET period = tstzrange(${new Date(`${from}T12:00:00Z`)}, ${new Date(`${to}T12:00:00Z`)}, '[)')
        WHERE id = ${rental.id}
      `
    }
  })

  await expectRejected('An OPEN rental committed with no reservation window', async (tx) => {
    const client = tx as typeof prismaUnscoped
    await lineWithOrder(client, {
        orgId: org.id,
        assetId: asset.id,
        recordedById: user.id,
        expectedReturnDate: new Date('2027-03-01T12:00:00Z'),
        status: 'OPEN',
      })
    // The guard is a DEFERRED constraint trigger, so it would normally fire at
    // COMMIT — which this test never reaches, because it rolls back. Forcing
    // constraints immediate fires the pending event here instead.
    await client.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
  })

  // Back-to-back windows must be allowed — '[)' bounds mean they touch, not overlap.
  try {
    await prismaUnscoped.$transaction(async (tx) => {
      for (const [from, to] of [
        ['2027-06-01', '2027-06-10'],
        ['2027-06-10', '2027-06-20'],
      ]) {
        const rental = await lineWithOrder(tx, {
            orgId: org.id,
            assetId: asset.id,
            recordedById: user.id,
            checkoutDate: new Date(`${from}T12:00:00Z`),
            expectedReturnDate: new Date(`${to}T12:00:00Z`),
            status: 'OPEN',
          })
        await tx.$executeRaw`
          UPDATE "Rental"
          SET period = tstzrange(${new Date(`${from}T12:00:00Z`)}, ${new Date(`${to}T12:00:00Z`)}, '[)')
          WHERE id = ${rental.id}
        `
      }
      throw new Error('__ROLLBACK_CLEAN__')
    })
    record('Back-to-back rental windows', false, 'transaction unexpectedly completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(
      'Back-to-back rental windows (handover day) are allowed',
      message.includes('__ROLLBACK_CLEAN__'),
      message.includes('__ROLLBACK_CLEAN__')
        ? 'accepted, as intended — [) bounds touch without overlapping'
        : `wrongly rejected: ${pgCode(error)}`,
    )
  }

  console.log('\nBUILD_SPEC §3.3 — custody is single-holder\n')

  await expectRejected('An asset held by a person AND staged on a truck', async (tx) => {
    const client = tx as typeof prismaUnscoped
    await client.asset.update({
      where: { id: asset.id },
      data: {
        custodyType: 'PERSON',
        custodyUserId: user.id,
        custodyTruckId: truck.id,
        custodyAssignedById: user.id,
        custodyAssignedAt: new Date(),
      },
    })
  })

  await expectRejected('Custody of type TRUCK with no truck named', async (tx) => {
    const client = tx as typeof prismaUnscoped
    await client.asset.update({
      where: { id: asset.id },
      data: {
        custodyType: 'TRUCK',
        custodyTruckId: null,
        custodyAssignedById: user.id,
        custodyAssignedAt: new Date(),
      },
    })
  })

  await expectRejected('A unit OUT_ON_RENT that still holds a custody assignment', async (tx) => {
    const client = tx as typeof prismaUnscoped
    await client.asset.update({
      where: { id: rented.id },
      data: {
        custodyType: 'TRUCK',
        custodyTruckId: truck.id,
        custodyAssignedById: user.id,
        custodyAssignedAt: new Date(),
      },
    })
  })

  console.log('\nBUILD_SPEC §3.1 — assetTag is real, and §8 — tenants are isolated\n')

  await expectRejected('A blank assetTag', async (tx) => {
    const client = tx as typeof prismaUnscoped
    await client.asset.create({
      data: { orgId: org.id, assetTag: '   ', categoryId: asset.categoryId },
    })
  })

  await expectRejected('A duplicate assetTag within one organization', async (tx) => {
    const client = tx as typeof prismaUnscoped
    await client.asset.create({
      data: { orgId: org.id, assetTag: asset.assetTag, categoryId: asset.categoryId },
    })
  })

  // The same tag in a *different* tenant must be fine — tags are per-org.
  try {
    await prismaUnscoped.$transaction(async (tx) => {
      const other = await tx.organization.create({
        data: { name: 'Test Tenant', slug: `test-${Date.now()}` },
      })
      const category = await tx.category.create({
        data: { orgId: other.id, name: 'Gas Detection', slug: 'gas' },
      })
      await tx.asset.create({
        data: { orgId: other.id, assetTag: asset.assetTag, categoryId: category.id },
      })
      throw new Error('__ROLLBACK_CLEAN__')
    })
    record('Same assetTag in a second tenant', false, 'transaction unexpectedly completed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(
      'The same assetTag in a second tenant is allowed',
      message.includes('__ROLLBACK_CLEAN__'),
      message.includes('__ROLLBACK_CLEAN__')
        ? 'accepted, as intended — assetTag is unique per organization'
        : `wrongly rejected: ${pgCode(error)}`,
    )
  }

  // Query scoping: a client bound to an org that owns nothing sees nothing.
  const empty = await prismaUnscoped.organization.create({
    data: { name: 'Scope Probe', slug: `scope-probe-${Date.now()}` },
  })
  try {
    const probe = dbForOrg(empty.id)
    const visibleAssets = await probe.asset.count()
    const visibleTrucks = await probe.truck.count()
    const totalAssets = await prismaUnscoped.asset.count()
    record(
      'A scoped client sees only its own tenant',
      visibleAssets === 0 && visibleTrucks === 0 && totalAssets > 0,
      `probe org sees ${visibleAssets} assets / ${visibleTrucks} trucks; ${totalAssets} assets exist overall`,
    )

    // And a create through that client cannot be smuggled into another tenant.
    const created = await probe.category.create({ data: { name: 'Probe', slug: 'probe', orgId: org.id } })
    const reread = await prismaUnscoped.category.findUniqueOrThrow({ where: { id: created.id } })
    record(
      'A scoped create cannot name someone else’s orgId',
      reread.orgId === empty.id,
      reread.orgId === empty.id
        ? 'the caller-supplied orgId was overridden by the scope'
        : `LEAK: row landed in org ${reread.orgId}`,
    )
  } finally {
    await prismaUnscoped.category.deleteMany({ where: { orgId: empty.id } })
    await prismaUnscoped.organization.delete({ where: { id: empty.id } })
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} invariants enforced.`)
  if (failed.length) {
    console.error(`\n${failed.length} FAILED:\n${failed.map((f) => `  - ${f.name}`).join('\n')}`)
    process.exit(1)
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
