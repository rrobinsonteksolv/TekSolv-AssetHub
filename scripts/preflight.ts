/**
 * Startup preflight — runs automatically before `npm run dev` via `predev`.
 *
 * This exists because of one specific, genuinely nasty failure: with an empty
 * `AUTH_SECRET`, NextAuth does not crash. The login page renders HTTP 200 and
 * looks completely normal, sign-in just silently never works, and the only
 * clue — `MissingSecret` — is buried in the server log among hundreds of
 * compile lines. Someone cloning this repo would reasonably conclude the app
 * is broken.
 *
 * So: fail loudly, before the server starts, with the command that fixes it.
 *
 * Deliberately not wired into `build`. A CI pipeline builds without a database
 * and sometimes without secrets, and a preflight that blocks that would be a
 * worse problem than the one it solves.
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const problems: string[] = []
const notes: string[] = []

function fail(title: string, ...lines: string[]) {
  problems.push([`  ✖ ${title}`, ...lines.map((line) => `    ${line}`)].join('\n'))
}

async function main() {
  // --- .env exists and carries the two things nothing works without --------
  if (!process.env.DATABASE_URL) {
    fail(
      'DATABASE_URL is not set.',
      'Copy the template and keep its defaults:',
      '',
      '    cp .env.example .env',
    )
  }

  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.trim() === '') {
    fail(
      'AUTH_SECRET is empty.',
      'Sign-in will fail silently without it — the login page still renders,',
      'it just never logs anyone in. Generate one and put it in .env:',
      '',
      '    npx auth secret        # or: openssl rand -base64 32',
    )
  }

  // --- the database is actually up and migrated ---------------------------
  if (process.env.DATABASE_URL) {
    const prisma = new PrismaClient()
    try {
      await prisma.$queryRaw`SELECT 1`

      try {
        const orgs = await prisma.organization.count()
        if (orgs === 0) {
          notes.push(
            [
              '  ! The database is empty.',
              '    Load the TekSolv fleet so there is something to click through:',
              '',
              '        npm run db:seed',
            ].join('\n'),
          )
        }
      } catch {
        // Connected, but the tables are not there yet.
        fail(
          'The database has no schema yet.',
          'Apply the migrations:',
          '',
          '    npm run db:deploy',
        )
      }
    } catch {
      fail(
        'Cannot reach the database.',
        `Tried: ${process.env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`,
        'Start the bundled Postgres container:',
        '',
        '    npm run db:up',
      )
    } finally {
      await prisma.$disconnect()
    }
  }

  if (problems.length > 0) {
    console.error(`\nAssetHub can't start yet:\n\n${problems.join('\n\n')}\n`)
    process.exit(1)
  }

  if (notes.length > 0) {
    console.warn(`\n${notes.join('\n\n')}\n`)
  }
}

main().catch((error) => {
  // A preflight that crashes must not be what stops you working.
  console.error('\n  ! Preflight check could not run:', (error as Error).message, '\n')
})
