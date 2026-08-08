/**
 * Generate `AUTH_SECRET` and write it into `.env`.
 *
 * This exists because the obvious instruction is wrong. `npx auth secret` used
 * to be the NextAuth CLI; the bare `auth` package on npm now resolves to
 * better-auth's CLI, which prints `BETTER_AUTH_SECRET=…`, writes nothing, and
 * leaves you with an empty `AUTH_SECRET` and an app whose login page renders
 * fine but never signs anyone in. Following that instruction literally is a
 * dead end, so this replaces it.
 *
 *   npm run auth:secret
 *
 * Idempotent and non-destructive: an existing non-empty secret is never
 * overwritten, because rotating it silently would invalidate every live
 * session with no explanation.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ENV = path.join(process.cwd(), '.env')
const EXAMPLE = path.join(process.cwd(), '.env.example')

function main() {
  if (!existsSync(ENV)) {
    if (!existsSync(EXAMPLE)) {
      console.error('  ✖ No .env and no .env.example to copy from.')
      process.exit(1)
    }
    copyFileSync(EXAMPLE, ENV)
    console.log('  · Created .env from .env.example')
  }

  const raw = readFileSync(ENV, 'utf8')
  // A UTF-8 BOM would end up inside the first key name; strip it and write the
  // file back without one.
  const contents = raw.replace(/^﻿/, '')

  const existing = /^AUTH_SECRET\s*=\s*["']?([^"'\r\n]*)["']?\s*$/m.exec(contents)
  if (existing?.[1] && existing[1].trim() !== '') {
    console.log('  · AUTH_SECRET is already set — leaving it alone.')
    console.log('    Delete the line and re-run if you really want to rotate it')
    console.log('    (every signed-in session will be invalidated).')
    return
  }

  const secret = randomBytes(32).toString('base64')
  const line = `AUTH_SECRET="${secret}"`

  const next = existing
    ? contents.replace(/^AUTH_SECRET\s*=.*$/m, line)
    : `${contents.replace(/\s*$/, '')}\n\n${line}\n`

  writeFileSync(ENV, next, 'utf8')
  console.log('  ✔ AUTH_SECRET written to .env')
  console.log('    You can start the app now:  npm run dev')
}

main()
