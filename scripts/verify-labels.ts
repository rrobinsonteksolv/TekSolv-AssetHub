/**
 * Zebra label printing — the ZPL, and everything around getting it to a printer.
 *
 * **What this cannot check, and nothing automated can:** that ink lands in the
 * right place on a physical label. Registration depends on how the stock is
 * seated in the GC420t, and the only way to know is to run `Test print`,
 * measure, and adjust the coordinate block in `templates.ts`. Every label
 * printer needs that pass once.
 *
 * What it *does* check is everything up to the paper, which is where the bugs
 * that are hard to see actually live:
 *
 *   1. the ZPL is well-formed, correctly escaped, and carries the right data;
 *   2. the app finds printers, remembers the choice, and prints;
 *   3. a missing Browser Print says so, with the install link.
 *
 * (2) and (3) run against a **stubbed Browser Print**: the browser's requests to
 * 127.0.0.1:9100/9101 are intercepted and answered with the same protocol
 * Zebra's utility speaks, so the whole client path is exercised — discovery,
 * default, the write, the payload, and the CORS the browser enforces on the
 * way — and the exact ZPL that would have reached the GC420t is captured.
 *
 * Intercepted rather than served from a real local socket, for two reasons that
 * both matter on a workstation set up for labelling. A machine running the
 * genuine Browser Print already owns port 9100, so a stub server cannot bind it
 * and the suite would simply stop working on exactly the desks that use this
 * feature. And interception guarantees the test can never reach a real printer:
 * driving a live utility would quietly spit four physical labels out of the
 * GC420t every run.
 *
 * Needs the dev server running:  npm run dev
 *   npx tsx scripts/verify-labels.ts
 */
import 'dotenv/config'
import { chromium, type Page, type Route } from 'playwright'
import { prismaUnscoped } from '../src/lib/prisma'
import {
  BROWSER_PRINT_DOWNLOAD,
  choosePrinter,
  isRawDevice,
  rankDevices,
  type Discovery,
  type ZebraDevice,
} from '../src/lib/labels/browser-print'
import { scanQrSvg } from '../src/lib/labels/qr-svg'
import { publicReportPath } from '../src/lib/public-report'
import { SAFE_PAD_IN } from '../src/lib/labels/label-html'
import { LABEL_2_25x1_25, fit, zplText } from '../src/lib/labels/zpl'
import { eplText } from '../src/lib/labels/epl'
import {
  initialsOf,
  renderLabel,
  renderLabelHtml,
  type CalibrationLabelData,
  type LabelOptions,
  type LabelTemplateId,
} from '../src/lib/labels/templates'

/**
 * Render explicitly as ZPL.
 *
 * The default language is EPL — that is what the bench printer speaks — so the
 * ZPL checks have to say so. Without this they would quietly start grading EPL
 * output against ZPL expectations, which is a confusing way to discover that
 * the default moved.
 */
const asZpl = (id: LabelTemplateId, data: unknown, options: LabelOptions = {}) =>
  renderLabel(id, data, { ...options, language: 'ZPL' })

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const PASSWORD = process.env.SEED_PASSWORD ?? 'assethub-dev'
const PORT = 9100

/**
 * The two dates as a *sticker* writes them: MM/DD/YYYY.
 *
 * Only the label uses this form. Reports, forms and the database stay ISO, and
 * the checks against those still expect ISO — which is the point of spelling
 * these out here rather than reusing the fixture.
 */
const US_CAL_DATE = '08/06/2026'
const US_DUE_DATE = '02/02/2027'

/** A Date as the sticker prints it, from its UTC calendar day. */
function usDate(value: Date): string {
  const [year, month, day] = value.toISOString().slice(0, 10).split('-')
  return `${month}/${day}/${year}`
}

/** Change the last character of a token, keeping its shape. */
function flipLast(token: string): string {
  const last = token.slice(-1)
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A')
}

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`)
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 }),
    page.click('button[type="submit"]'),
  ])
}

// ---------------------------------------------------------------------------
// A stand-in for the Browser Print utility
// ---------------------------------------------------------------------------

interface StubJob {
  device: { uid: string; name: string }
  data: string
}

/** Whether the workstation has Browser Print at this point in the test. */
type StubMode = 'absent' | 'present'

/**
 * Stand in for the Browser Print utility, at the browser's network layer.
 *
 * `route.abort('connectionrefused')` is precisely what a machine without the
 * utility does, and fulfilling with the CORS headers Zebra's service sets means
 * the browser's own cross-origin enforcement is part of what is being tested
 * rather than something the test works around.
 */
async function stubBrowserPrint(
  page: Page,
  devices: { uid: string; name: string; connection: string }[],
  defaultUid: string | null,
) {
  const jobs: StubJob[] = []
  const state = { mode: 'absent' as StubMode }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  }
  const describe = (device: { uid: string; name: string; connection: string }) => ({
    ...device,
    deviceType: 'printer',
    manufacturer: 'Zebra Technologies',
    provider: 'com.zebra.ds.webdriver.desktop.provider.DefaultDeviceProvider',
  })

  await page.route(/^https?:\/\/127\.0\.0\.1:(9100|9101)\//, async (route: Route) => {
    if (state.mode === 'absent') {
      await route.abort('connectionrefused')
      return
    }

    const url = new URL(route.request().url())
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    if (url.pathname === '/available') {
      await json({ printer: devices.map(describe), otherDevices: [] })
      return
    }
    if (url.pathname === '/default') {
      const device = devices.find((entry) => entry.uid === defaultUid)
      await json(device ? describe(device) : null)
      return
    }
    if (url.pathname === '/write' && route.request().method() === 'POST') {
      try {
        jobs.push(JSON.parse(route.request().postData() ?? '') as StubJob)
      } catch {
        /* recorded as nothing */
      }
      await route.fulfill({ status: 200, headers: cors, body: '' })
      return
    }
    await route.fulfill({ status: 404, headers: cors, body: '' })
  })

  return {
    jobs,
    install: () => (state.mode = 'present'),
    /** Back to a workstation the service will not connect on. */
    uninstall: () => (state.mode = 'absent'),
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { slug: 'teksolv' } })

  // --- 1. the ZPL itself --------------------------------------------------
  console.log('\nThe ZPL\n')

  const sample: CalibrationLabelData = {
    orgName: 'TekSolv',
    model: 'ALTAIR 4X',
    serial: '22478',
    assetTag: 'FAM001012',
    calDate: '2026-08-06',
    dueDate: '2027-02-02',
    techInitials: 'S.O.',
    scanUrl: 'http://localhost:3000/api/scan/FAM001012',
  }
  const zpl = asZpl('calibration', sample)

  check('a label opens with ^XA and closes with ^XZ', zpl.startsWith('^XA') && zpl.trimEnd().endsWith('^XZ'))
  check(
    'it declares the stock: 2.25" x 1.25" at 203 dpi',
    zpl.includes(`^PW${LABEL_2_25x1_25.widthDots}`) &&
      zpl.includes(`^LL${LABEL_2_25x1_25.heightDots}`),
    `^PW457 ^LL254 — ${LABEL_2_25x1_25.widthDots} x ${LABEL_2_25x1_25.heightDots} dots`,
  )
  check('UTF-8 encoding is selected', zpl.includes('^CI28'))
  check(
    'and thermal transfer, not direct thermal',
    zpl.includes('^MTT'),
    'a GC420t set to direct thermal prints a blank label, which looks like a failed print',
  )
  // Not a count of ^FD against ^FS: ^GB draws a box and closes with ^FS of its
  // own, so the totals are legitimately different. What matters is that no data
  // field is left open — an unterminated ^FD swallows the rest of the label.
  check(
    'no ^FD data field is left unterminated',
    zpl
      .split('^FD')
      .slice(1)
      .every((segment) => segment.includes('^FS')),
    `${(zpl.match(/\^FD/g) ?? []).length} data fields, ${(zpl.match(/\^FS/g) ?? []).length} terminators`,
  )

  for (const [what, value] of [
    ['model', sample.model],
    ['serial', sample.serial],
    ['asset tag', sample.assetTag],
    ['calibration date', US_CAL_DATE],
    ['due date', US_DUE_DATE],
    ['technician initials', sample.techInitials],
  ] as const) {
    check(`the ${what} is on the label`, zpl.includes(value!), value!)
  }
  // Sticker dates are MM/DD/YYYY. The negative half matters as much as the
  // positive: the ISO form must be *gone*, or a template that formats one date
  // and forgets another would pass every check above.
  check(
    'sticker dates are MM/DD/YYYY, not ISO',
    zpl.includes(US_CAL_DATE) &&
      zpl.includes(US_DUE_DATE) &&
      !zpl.includes(sample.calDate!) &&
      !zpl.includes(sample.dueDate!),
    `${US_CAL_DATE} / ${US_DUE_DATE}`,
  )
  check(
    'and the same in EPL and on the OS-driver page',
    [
      renderLabel('calibration', sample, { language: 'EPL' }),
      renderLabelHtml('calibration', sample),
    ].every(
      (rendered) =>
        rendered.includes(US_CAL_DATE) &&
        rendered.includes(US_DUE_DATE) &&
        !rendered.includes(sample.calDate!) &&
        !rendered.includes(sample.dueDate!),
    ),
    'all three renderings of one sticker, or the format depends on the printer',
  )
  check(
    'the date is sliced, not parsed — no timezone can move it a day',
    (() => {
      // The classic failure: `new Date('2027-01-01')` is midnight UTC, and
      // formatting it west of Greenwich yields 12/31/2026 — a due date printed
      // a day early onto a sticker that outlives the mistake.
      const newYear = renderLabelHtml('calibration', { ...sample, dueDate: '2027-01-01' })
      return newYear.includes('01/01/2027') && !newYear.includes('12/31/2026')
    })(),
    'a boundary date renders as itself in every timezone',
  )
  check(
    'a date that is not ISO is passed through rather than dropped',
    renderLabelHtml('calibration', { ...sample, dueDate: 'ON RECEIPT' }).includes('ON RECEIPT'),
    'an odd-looking date beats a blank where the date should be',
  )

  check(
    'the QR encodes the scan URL',
    /\^BQN,2,\d/.test(zpl) && zpl.includes(sample.scanUrl),
  )
  check(
    'DUE is the largest field after the heading',
    /\^A0N,30,30\^FH\^FDDUE /.test(zpl),
    'it is the one number read across a shop',
  )

  // --- escaping ------------------------------------------------------------
  console.log('\nEscaping\n')

  check(
    'a caret in the data cannot become a command',
    zplText('4X^R') === '4X_5ER' && !asZpl('calibration', { ...sample, model: '4X^R' }).includes('4X^R'),
    'ZPL reads ^ as the start of a format command',
  )
  check(
    'and neither can a tilde',
    zplText('A~B') === 'A_7EB',
    '~ starts a control command — worse, some of them reconfigure the printer',
  )
  check(
    'the hex indicator escapes itself',
    zplText('A_B') === 'A_5FB',
  )
  check(
    'accented text survives as UTF-8 bytes',
    zplText('Ü') === '_C3_9C',
    'rendered by ^CI28 — a raw byte here would print as a different glyph',
  )
  check(
    'every escaped field is marked ^FH so the printer decodes it',
    asZpl('calibration', { ...sample, model: '4X^R' }).includes('^FH^FD4X_5ER'),
  )
  check(
    'over-long text is cut visibly, not silently',
    fit('SUPER LONG MODEL NAME THAT RUNS OFF', 20).endsWith('…') &&
      fit('SUPER LONG MODEL NAME THAT RUNS OFF', 20).length <= 20,
    fit('SUPER LONG MODEL NAME THAT RUNS OFF', 20),
  )
  check(
    'a missing due date still prints the field',
    asZpl('calibration', { ...sample, dueDate: null }).includes('DUE '),
    'an absent date must read as "unknown", not as no label at all',
  )

  // --- the registry --------------------------------------------------------
  console.log('\nThe template registry\n')

  check(
    'the 1D variant swaps the QR for a Code 128 of the tag',
    (() => {
      const code = asZpl('calibration', sample, { symbology: 'code128' })
      return code.includes('^BCN,') && !code.includes('^BQN') && code.includes(sample.assetTag)
    })(),
    'for shops whose handhelds are laser rather than imaging',
  )
  check(
    'the same path renders the asset ID tag',
    asZpl('asset-tag', sample).includes(sample.assetTag),
  )
  check(
    'and an inspection sticker, which shouts when the unit failed',
    (() => {
      const failed = asZpl('inspection', { ...sample, result: 'FAIL' })
      const passed = asZpl('inspection', { ...sample, result: 'PASS' })
      return failed.includes('DO NOT USE') && passed.includes('INSPECTED') && !passed.includes('DO NOT USE')
    })(),
    'a failed unit must not carry a label that reads as a pass at arm’s length',
  )
  // A QR is sized by its payload, and the printer says nothing when the symbol
  // it chose runs off the edge. Deploying behind a longer hostname is exactly
  // how that happens months later, so the fit is computed rather than assumed.
  check(
    'a longer scan URL shrinks the QR instead of overflowing the label',
    (() => {
      const long = { ...sample, scanUrl: 'https://assethub.teksolv-industrial.com/api/scan/FAM001012-A' }
      const rendered = asZpl('calibration', long)
      const magnification = Number(/\^BQN,2,(\d)/.exec(rendered)?.[1])
      // 61 bytes needs version 4 (33 modules); 33 x 4 = 132 dots would run past
      // the 457-dot edge from x=330, so it must step down.
      return magnification > 0 && magnification < 4 && 33 * magnification <= 457 - 330 - 12
    })(),
    `magnification ${/\^BQN,2,(\d)/.exec(asZpl('calibration', { ...sample, scanUrl: 'https://assethub.teksolv-industrial.com/api/scan/FAM001012-A' }))?.[1]} for a 61-byte URL`,
  )
  check(
    'and a short one still prints at full size',
    /\^BQN,2,4/.test(asZpl('calibration', sample)),
    sample.scanUrl,
  )
  check(
    'the alignment label draws its own boundary to check registration',
    asZpl('alignment', {}).includes('^GB') && asZpl('alignment', {}).includes('ALIGNMENT'),
  )

  // --- EPL, the language the bench printer actually speaks -----------------
  //
  // A GC420t ships as ZPL or EPL and the two are unrelated. The failure that
  // makes this worth its own section: an EPL printer given ZPL prints nothing
  // and reports nothing, so every check above can pass while no label exists.
  console.log('\nEPL\n')

  const epl = renderLabel('calibration', sample, { language: 'EPL' })

  check(
    'an EPL job clears the buffer, sets the stock, and prints',
    epl.startsWith('N\n') && /\nP1$/.test(epl.trimEnd()),
    'without N the last label prints again underneath; without P nothing prints at all',
  )
  check(
    'it declares the same 2.25" x 1.25" stock in EPL terms',
    epl.includes(`q${LABEL_2_25x1_25.widthDots}`) &&
      new RegExp(`Q${LABEL_2_25x1_25.heightDots},\\d+`).test(epl),
    'q457 for width, Q254,<gap> for length',
  )
  check(
    'and pins the print direction',
    epl.includes('ZT'),
    'a printer left on ZB prints the whole label rotated 180 degrees',
  )
  check(
    'it carries no ZPL — the two languages do not mix',
    !epl.includes('^XA') && !epl.includes('^FD') && !epl.includes('^FO'),
  )

  for (const [what, value] of [
    ['model', sample.model],
    ['serial', sample.serial],
    ['asset tag', sample.assetTag],
    ['calibration date', US_CAL_DATE],
    ['due date', US_DUE_DATE],
    ['technician initials', sample.techInitials],
    ['brand', sample.orgName],
  ] as const) {
    check(`the ${what} is on the EPL label`, epl.includes(value!), value!)
  }
  check(
    'CALIBRATED and the date share a line',
    epl.includes(`"CALIBRATED ${US_CAL_DATE}"`),
    'EPL glyph cells are chunkier, so the date rides with the word it qualifies',
  )
  check(
    'DUE is double height, the largest thing on the label',
    /A\d+,\d+,0,4,1,2,N,"DUE /.test(epl),
    'font 4 at 2x vertical — font 5 is bigger but drops the hyphens in a date',
  )
  check(
    'the QR is a type Q barcode carrying the scan URL',
    epl.includes(',Q,m2,s') && epl.includes(sample.scanUrl),
  )
  check(
    'every text field is a well-formed A command',
    epl
      .split('\n')
      .filter((line) => line.startsWith('A'))
      .every((line) => /^A\d+,\d+,[0-3],[1-5],\d+,\d+,[NR],".*"$/.test(line)),
    `${epl.split('\n').filter((line) => line.startsWith('A')).length} text fields`,
  )
  check(
    'a quote in the data is escaped, not left to end the field early',
    eplText('2.25" stock') === '2.25\\" stock',
    'EPL delimits data with quotes; an unescaped one truncates the label there',
  )
  check('and a backslash escapes itself', eplText('A\\B') === 'A\\\\B')
  check(
    'control characters are dropped rather than escaped',
    eplText('A\nB') === 'AB',
    'a newline inside a quoted field ends the command mid-label',
  )
  check(
    'the alignment target renders in EPL too',
    (() => {
      const target = renderLabel('alignment', {}, { language: 'EPL' })
      return target.startsWith('N\n') && target.includes('LO') && target.includes('ALIGNMENT')
    })(),
    'Test print is the first thing run on an EPL printer — if it is ZPL, nothing comes out',
  )
  check(
    'every template has an EPL version, so no button can send silence',
    (['calibration', 'asset-tag', 'inspection', 'alignment'] as const).every((id) => {
      const rendered = renderLabel(id, { ...sample, result: 'PASS' }, { language: 'EPL' })
      return rendered.startsWith('N\n') && rendered.trimEnd().endsWith('P1')
    }),
  )
  check(
    'ZPL is still available for sites with ZPL printers',
    renderLabel('calibration', sample, { language: 'ZPL' }).startsWith('^XA'),
    'the EPL switch adds a language, it does not replace one',
  )
  check(
    'EPL refuses Code 128 loudly instead of guessing a symbology code',
    (() => {
      try {
        renderLabel('calibration', sample, { language: 'EPL', symbology: 'code128' })
        return false
      } catch (error) {
        return /not implemented for EPL/i.test((error as Error).message)
      }
    })(),
    'an unrecognised EPL barcode code is discarded silently — the exact bug being fixed',
  )

  // --- Printer selection ---------------------------------------------------
  //
  // The rule that changed: Browser Print's own default is no longer trusted.
  // On the bench workstation it keeps reverting to the EPL *driver* entry, so
  // treating it as a fallback sent every job through the Windows spooler
  // instead of to the printer — a confident wrong answer, which is worse than
  // no answer.
  console.log('\nPicking a printer\n')

  const rawUsb: ZebraDevice = {
    uid: '54j141200023',
    name: '54j141200023',
    deviceType: 'printer',
    connection: 'usb',
  }
  const driverEntry: ZebraDevice = {
    uid: 'ZDesigner GC420t (EPL)',
    name: 'ZDesigner GC420t (EPL)',
    deviceType: 'printer',
    connection: 'driver',
  }
  const both: Discovery = {
    devices: [driverEntry, rawUsb],
    // Exactly the situation on this workstation.
    defaultUid: driverEntry.uid,
  }

  check(
    'the raw USB endpoint is told apart from the driver queue',
    isRawDevice(rawUsb) && !isRawDevice(driverEntry),
    'connection "usb" is the printer; "driver" is Windows in front of it',
  )
  check(
    'the real printer is offered first',
    rankDevices(both.devices)[0]?.uid === rawUsb.uid,
    'so the right one is the easy one to pick',
  )
  check(
    'with nothing remembered, the raw device wins over the default',
    choosePrinter(both, null).device?.uid === rawUsb.uid,
    'Browser Print says the EPL driver is default; that is exactly what broke',
  )
  check(
    'a remembered printer is used as-is',
    choosePrinter(both, rawUsb.uid).device?.uid === rawUsb.uid,
  )
  check(
    'and a remembered printer that is unplugged is reported, never substituted',
    (() => {
      const choice = choosePrinter({ devices: [driverEntry], defaultUid: driverEntry.uid }, rawUsb.uid)
      return choice.device === null && choice.missing === rawUsb.uid
    })(),
    'silently printing to the driver entry instead is the bug being fixed',
  )
  check(
    'two driver queues and nothing remembered asks rather than guesses',
    (() => {
      const second = { ...driverEntry, uid: 'ZDesigner GC420t', name: 'ZDesigner GC420t' }
      const choice = choosePrinter(
        { devices: [driverEntry, second], defaultUid: driverEntry.uid },
        null,
      )
      return choice.device === null && choice.ambiguous
    })(),
  )
  check(
    'one printer of any kind is not a question worth a dialog',
    choosePrinter({ devices: [driverEntry], defaultUid: null }, null).device?.uid === driverEntry.uid,
  )

  // --- The OS-driver rendering ---------------------------------------------
  console.log('\nThe OS-driver fallback\n')

  const qrSvg = await scanQrSvg(sample.scanUrl)
  const html = renderLabelHtml('calibration', { ...sample, qrSvg })

  check(
    'the label is a page the size of the stock, not a Letter sheet',
    html.includes('@page { size: 2.25in 1.25in; margin: 0; }'),
    'without this the driver centres the label on a full page and feeds a foot of stock',
  )
  check(
    'the page is nominal inches, not the dot count converted back',
    !html.includes('2.2512in'),
    '457 dots at 203 dpi is 2.2512" — a form size no driver has defined',
  )
  for (const [what, value] of [
    ['model', sample.model],
    ['serial', sample.serial],
    ['asset tag', sample.assetTag],
    ['calibration date', US_CAL_DATE],
    ['due date', US_DUE_DATE],
    ['technician initials', sample.techInitials],
  ] as const) {
    check(`the ${what} is on the printed page`, html.includes(value!), value!)
  }
  check(
    'the QR is inlined as SVG, not fetched',
    html.includes('<svg') && !html.includes('<img'),
    'a print job that has to fetch an image prints the box empty',
  )
  check(
    'DUE is stretched vertically, not scaled up in both directions',
    /transform:scaleY\(1?\.?\d+\)/.test(html),
    'scaling both axes runs the date under the QR and truncates it mid-date',
  )
  check(
    'a label with no QR still renders every readable field',
    (() => {
      const bare = renderLabelHtml('calibration', { ...sample, qrSvg: null })
      return bare.includes(sample.assetTag) && !bare.includes('<svg')
    })(),
    'the code is the only part a human cannot read back',
  )
  check(
    'HTML escaping keeps data out of the markup',
    renderLabelHtml('calibration', { ...sample, model: '<script>x</script>' }).includes(
      '&lt;script&gt;',
    ),
  )
  // The size of the band is measured for real further down; here it only has
  // to exist, and to be roughly the intended 0.06".
  check(
    'a keep-out band is reserved so nothing sits on the die-cut',
    /\.label\s*\{[^}]*padding:\s*0\.0[56]\d*in/.test(html),
    `${SAFE_PAD_IN}" — a die cut wanders, and artwork at the nominal edge is artwork at the cut`,
  )
  check(
    'overflow is clipped rather than paginated',
    (html.match(/overflow: hidden/g) ?? []).length >= 2 && html.includes('page-break-inside: avoid'),
    'a second page on a roll of die-cut labels is the next label',
  )
  check(
    'the scan URL prints along the bottom as readable text',
    html.includes('localhost:3000/api/scan/FAM001012') && !html.includes('>http://'),
    'so the label still identifies the unit when the code will not scan',
  )
  check(
    'every template has an OS-driver rendering',
    (['calibration', 'asset-tag', 'inspection', 'alignment'] as const).every((id) => {
      const page = renderLabelHtml(id, { ...sample, result: 'PASS', qrSvg })
      return page.startsWith('<!doctype html>') && page.includes('@page')
    }),
    'a fallback that covers only some labels is not a fallback',
  )
  check(
    'the alignment target exists on this path too',
    renderLabelHtml('alignment', {}).includes('ALIGNMENT'),
    'the driver has its own page-size problems and needs its own measuring pass',
  )

  // --- 2 & 3. getting it to a printer -------------------------------------
  const asset = await prismaUnscoped.asset.findFirstOrThrow({
    where: { orgId: org.id, maintenanceRecords: { some: { type: 'CALIBRATION' } } },
    include: {
      maintenanceRecords: { where: { type: 'CALIBRATION' }, orderBy: { performedAt: 'desc' }, take: 1,
        include: { performedBy: { select: { name: true } } } },
      maintenanceSchedules: { where: { type: 'CALIBRATION', active: true }, take: 1 },
    },
  })

  // Real data, not the fixture: the geometry check below is about whether a
  // genuine model name and serial still fit.
  const measured = {
    ...sample,
    model: asset.model,
    serial: asset.serialNumber,
    assetTag: asset.assetTag,
    qrSvg: await scanQrSvg(`${BASE}/api/scan/${asset.assetTag}`),
    scanUrl: `${BASE}/api/scan/${asset.assetTag}`,
  }

  const browser = await chromium.launch()
  const page = await (await browser.newContext()).newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  // Installed before anything navigates, so the real Browser Print on this
  // machine is never reached — and never asked to print.
  const stub = await stubBrowserPrint(
    page,
    [
      { uid: 'gc420t-usb-001', name: 'ZDesigner GC420t', connection: 'usb' },
      { uid: 'zd421-net-002', name: 'ZDesigner ZD421', connection: 'network' },
    ],
    'zd421-net-002',
  )

  try {
    await signIn(page, 'sam@teksolv.com')

    // --- Browser Print missing --------------------------------------------
    console.log('\nWhen Browser Print is not installed\n')

    // The stub refuses connections at this point: this is a workstation where
    // the utility was never installed, which is the first thing every new
    // operator hits.
    await page.goto(`${BASE}/inventory/${asset.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    const printButton = page.getByRole('button', { name: /Print sticker/ })
    check('the maintenance tab offers a sticker to a supervisor', await printButton.isVisible())

    await printButton.click()
    const dialog = page.locator('[role="dialog"][aria-label="Label printer"]')
    // Waited for rather than slept past: the client tries both of Browser
    // Print's ports before concluding it is absent, so how long that takes is
    // an implementation detail this test should not encode.
    const appeared = await dialog
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    check('a helpful dialog opens rather than a silent failure', appeared)
    const help = await dialog.innerText()
    check(
      'it says Browser Print is not running',
      /not running|did not respond/i.test(help),
      help.split('\n')[0],
    )
    // Pinned to the exact URL, not a substring. Zebra has already moved this
    // page once — the old `/printer-software/by-product/` path 404s — and a
    // loose match would have gone on passing while the link rotted. The only
    // symptom is a dead link inside an error message, seen for the first time
    // by somebody who is already stuck.
    const downloadLink = dialog.locator(`a[href="${BROWSER_PRINT_DOWNLOAD}"]`)
    check(
      'and links to the current Zebra download page',
      (await downloadLink.count()) === 1,
      BROWSER_PRINT_DOWNLOAD,
    )
    check(
      'which opens in a new tab, so the print job in progress is not lost',
      (await downloadLink.getAttribute('target')) === '_blank',
    )
    check(
      'it warns the download is gated rather than instant',
      /request form/i.test(help) && /MFA|sign-in/i.test(help),
      'a surprise login reads as a second thing broken when you are stuck on the first',
    )
    // The fallback has to be reachable from the stuck state, not buried behind
    // a working Browser Print — this dialog is where somebody lands when the
    // service will not connect, and it is where the way out belongs.
    check(
      'the OS-driver route is offered right here, while Browser Print is down',
      await dialog.getByRole('button', { name: /Print via Windows/ }).isVisible(),
      'a workstation with a working driver can still get a sticker',
    )
    check(
      'and says which of the two downloads this PC actually needs',
      /Browser Print application/i.test(help) && /JavaScript library/i.test(help),
      'the app owns the USB connection; the JS library is a developer artifact',
    )

    // --- with Browser Print running ---------------------------------------
    console.log('\nWith Browser Print running\n')

    stub.install()
    await dialog.getByRole('button', { name: /Look again/ }).click()
    await page.waitForTimeout(1500)

    check('both printers are discovered', (await dialog.locator('button:has-text("ZDesigner")').count()) === 2)
    check(
      "Browser Print's default is labelled as such, not silently honoured",
      (await dialog.innerText()).includes('Browser Print default'),
      'named so the operator can see it is the entry that keeps reverting',
    )
    check(
      'each entry says whether it is the printer or the Windows driver in front of it',
      (await dialog.innerText()).includes('The printer itself'),
      'the distinction that decides whether a raw label survives the trip',
    )

    // Several printers and nothing remembered, so it asked — pick the GC420t.
    await dialog.getByRole('button', { name: /GC420t/ }).click()
    await dialog.getByRole('button', { name: 'Test print', exact: true }).click()
    await page.waitForTimeout(1500)

    check('Test print sends an alignment label', stub.jobs.length === 1)
    check(
      'to the printer that was chosen, not the system default',
      stub.jobs[0]?.device?.uid === 'gc420t-usb-001',
      stub.jobs[0]?.device?.name,
    )
    check(
      'and it is the alignment target, not a real sticker',
      (stub.jobs[0]?.data ?? '').includes('ALIGNMENT'),
    )

    await dialog.getByRole('button', { name: /Print via Browser Print/ }).click()
    await page.waitForTimeout(1500)

    check('Print sends the calibration sticker', stub.jobs.length === 2)
    const sent = stub.jobs[1]?.data ?? ''
    check(
      'built from the unit and its calibration schedule',
      sent.includes(asset.assetTag) &&
        (asset.serialNumber ? sent.includes(asset.serialNumber) : true) &&
        sent.includes('CALIBRATED'),
      `${asset.assetTag} · ${asset.model ?? '—'} · s/n ${asset.serialNumber ?? '—'}`,
    )
    check(
      'carrying the calibration date and the schedule’s next-due',
      sent.includes(usDate(asset.maintenanceRecords[0]!.performedAt)) &&
        (asset.maintenanceSchedules[0]?.nextDue
          ? sent.includes(usDate(asset.maintenanceSchedules[0].nextDue))
          : true),
      `due ${asset.maintenanceSchedules[0]?.nextDue?.toISOString().slice(0, 10) ?? 'none'}`,
    )
    check(
      'and the technician’s initials',
      sent.includes(initialsOf(asset.maintenanceRecords[0]!.performedBy?.name) ?? '—'),
      initialsOf(asset.maintenanceRecords[0]!.performedBy?.name) ?? 'no technician on record',
    )
    // The sticker's code opens *this calibration*, not the unit's page. A
    // safety officer scanning a monitor wants the gases, lots and due date —
    // and has no login to reach the internal page with.
    const printedToken = (
      await prismaUnscoped.maintenanceRecord.findFirstOrThrow({
        where: { assetId: asset.id, type: 'CALIBRATION', publicToken: { not: null } },
        orderBy: { performedAt: 'desc' },
      })
    ).publicToken!
    check(
      'the QR opens the public calibration report, not the unit page',
      sent.includes(publicReportPath(printedToken)) &&
        !sent.includes('/api/scan/') &&
        sent.includes(',Q,m2,s'),
      publicReportPath(printedToken),
    )
    check(
      'and the asset ID label still points at the unit lookup',
      renderLabel('asset-tag', { ...measured, reportUrl: null }, { language: 'EPL' }).includes(
        '/api/scan/',
      ),
      'two labels, two questions: which unit is this, and what does its calibration say',
    )
    // The point of the whole EPL change: what leaves the app is what the bench
    // printer can read. ZPL here is not a cosmetic difference — it is a job the
    // printer accepts and silently discards.
    check(
      'and the job is EPL, the language this printer speaks',
      sent.startsWith('N\n') && sent.includes('q457') && !sent.includes('^XA'),
      sent.split('\n').slice(0, 3).join(' / '),
    )

    // --- the choice is remembered -----------------------------------------
    console.log('\nRemembering the printer\n')

    const stored = await page.evaluate(`window.localStorage.getItem('assethub.label-printer')`)
    check('the chosen printer is stored on this workstation', stored === 'gc420t-usb-001', String(stored))

    // The language is remembered beside it, and for the same reason: it is a
    // fact about the hardware on the desk. A site with ZPL printers flips this
    // once rather than on every print.
    const storedLanguage = await page.evaluate(
      `window.localStorage.getItem('assethub.label-language')`,
    )
    check(
      'the printer language defaults to EPL without being asked',
      storedLanguage === null,
      'nothing stored yet — EPL is the default until somebody chooses otherwise',
    )

    // A full reload, so this is the stored value being read rather than state
    // that happened to survive.
    await page.goto(`${BASE}/inventory/${asset.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Print sticker/ }).click()
    await page.waitForTimeout(2000)

    check(
      'a second print asks nothing — it goes straight to that printer',
      stub.jobs.length === 3 && stub.jobs[2]?.device?.uid === 'gc420t-usb-001',
      `${stub.jobs.length} jobs, last to ${stub.jobs[2]?.device?.name ?? 'nobody'}`,
    )
    check(
      'and no dialog was needed',
      !(await page.locator('[role="dialog"][aria-label="Label printer"]').isVisible()),
    )
    check(
      'the button confirms where it went',
      (await page.locator('body').innerText()).includes('Sent to ZDesigner GC420t'),
      'it says "sent", not "printed" — Browser Print cannot tell us a label came out',
    )

    // --- from the report ----------------------------------------------------
    console.log('\nFrom the calibration report\n')

    const record = asset.maintenanceRecords[0]!
    await page.goto(`${BASE}/maintenance/records/${record.id}/form`, { waitUntil: 'networkidle' })
    const onReport = page.getByRole('button', { name: /Print calibration sticker/ })
    check('the report offers the sticker too', await onReport.isVisible())
    await onReport.click()
    await page.waitForTimeout(2000)
    check(
      'and prints the same label from there',
      stub.jobs.length === 4 && (stub.jobs[3]?.data ?? '').includes(asset.assetTag),
    )

    // --- switching a site to ZPL ------------------------------------------
    //
    // Last, so it cannot disturb the job counts above. This is the path for a
    // site whose GC420t is the ZPL variant: one toggle, remembered, and the
    // same button sends the other language from then on.
    console.log('\nSwitching the printer language\n')

    await page.goto(`${BASE}/inventory/${asset.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Print sticker/ }).click()
    await page.waitForTimeout(2500)

    // The print above went straight through, so open the dialog deliberately.
    await page.getByRole('button', { name: /Print sticker/ }).click()
    await page.waitForTimeout(2500)
    const before = stub.jobs.length

    await page.goto(`${BASE}/inventory/${asset.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    await page.evaluate(`window.localStorage.setItem('assethub.label-language', 'ZPL')`)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Print sticker/ }).click()
    await page.waitForTimeout(2500)

    const afterSwitch = stub.jobs[stub.jobs.length - 1]?.data ?? ''
    check(
      'a workstation set to ZPL sends ZPL from the same button',
      stub.jobs.length > before && afterSwitch.startsWith('^XA') && !afterSwitch.startsWith('N\n'),
      afterSwitch.split('\n')[0],
    )
    check(
      'and the label still carries the same unit',
      afterSwitch.includes(asset.assetTag),
      'the sticker is the sticker — only the language it is spoken in changed',
    )

    // --- printing without Browser Print ------------------------------------
    //
    // The whole point of the fallback: a machine where the service will not
    // connect still gets a label. Driven with the stub refusing connections,
    // and the OS dialog stubbed at the browser so nothing physical happens.
    console.log('\nPrinting through the OS driver\n')

    // Watch for the label frame the OS path creates, capture what it would
    // print, and neutralise `print()` on it.
    //
    // Two things this must guarantee: that a real print dialog never opens —
    // it would block this run forever — and that nothing reaches the genuine
    // printer attached to this machine. Both are handled by replacing the
    // frame's own `print` the moment the frame appears, before it can load.
    await page.addInitScript(`
      if (window === window.top) {
        window.__osPrints = []
        const neutralise = (frame) => {
          try { frame.contentWindow.print = () => {} } catch (error) { /* not ready */ }
        }
        const watch = () => {
          new MutationObserver((records) => {
            for (const record of records) {
              for (const node of record.addedNodes) {
                if (node.tagName !== 'IFRAME' || !node.srcdoc) continue
                window.__osPrints.push(node.srcdoc)
                neutralise(node)
                node.addEventListener('load', () => neutralise(node))
              }
            }
          }).observe(document.documentElement, { childList: true, subtree: true })
        }
        // Init scripts run before the document exists, so observing straight
        // away throws — and a throwing init script breaks every page load.
        if (document.documentElement) watch()
        else document.addEventListener('DOMContentLoaded', watch)
      }
    `)

    // Browser Print goes away again — the situation the fallback exists for,
    // and the one this workstation keeps hitting.
    stub.uninstall()
    await page.goto(`${BASE}/inventory/${asset.id}?tab=maintenance`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Print sticker/ }).click()
    const osDialog = page.locator('[role="dialog"][aria-label="Label printer"]')
    await osDialog.waitFor({ state: 'visible', timeout: 20_000 })
    const jobsBeforeOs = stub.jobs.length

    await osDialog.getByRole('button', { name: /Print via Windows/ }).click()
    await page.waitForTimeout(2500)

    const osPrints = (await page.evaluate('window.__osPrints')) as string[]
    check(
      'the OS path lays out a label-sized page and prints it',
      osPrints.some(
        (html) =>
          html.includes('@page { size: 2.25in 1.25in; margin: 0; }') &&
          html.includes(asset.assetTag),
      ),
      osPrints.length ? `${osPrints.length} print job(s)` : 'nothing printed',
    )
    check(
      'and the button says which route the job took',
      (await page.locator('body').innerText()).includes('Windows driver'),
      'so a misaligned label points at the driver, not the ZPL coordinates',
    )
    check(
      'nothing was sent to Browser Print — it is not there',
      stub.jobs.length === jobsBeforeOs,
      'the fallback is a different path, not a retry of the same one',
    )

    // --- the public certificate --------------------------------------------
    //
    // The calibration sticker's code points here, not at the unit's page: the
    // person scanning it is standing next to the monitor at a customer site,
    // usually with no login, and what they want is *this calibration*.
    //
    // Tested in a **fresh browser context with no session**, because "works
    // when logged out" is the entire feature and a signed-in tab would pass
    // whether or not the route were public.
    console.log('\nThe public calibration report\n')

    const withToken = await prismaUnscoped.maintenanceRecord.findFirstOrThrow({
      where: { assetId: asset.id, type: 'CALIBRATION', publicToken: { not: null } },
      orderBy: { performedAt: 'desc' },
    })
    const anonymous = await (await browser.newContext()).newPage()
    const anonErrors: string[] = []
    anonymous.on('pageerror', (error) => anonErrors.push(error.message))

    try {
      await anonymous.goto(`${BASE}${publicReportPath(withToken.publicToken!)}`, {
        waitUntil: 'networkidle',
      })
      check(
        'a token opens the report with no login at all',
        !anonymous.url().includes('/login') && (await anonymous.locator('article').count()) === 1,
        anonymous.url().replace(BASE, ''),
      )

      const certificate = await anonymous.locator('article').innerText()
      const upper = certificate.toUpperCase()
      check(
        'and it is the calibration: gases, lots, due date, technician',
        upper.includes('CALIBRATION REPORT') &&
          upper.includes('CALIBRATION GASES') &&
          upper.includes('CALIBRATION DUE DATE') &&
          upper.includes('TECHNICIAN') &&
          certificate.includes(asset.serialNumber ?? asset.assetTag),
        `${asset.serialNumber ?? asset.assetTag} · every block of the certificate present`,
      )
      check(
        'it is printable, because a certificate gets filed',
        await anonymous.getByRole('button', { name: 'Save as PDF' }).isVisible(),
      )
      check(
        'and says plainly that it is read-only',
        (await anonymous.locator('body').innerText()).toLowerCase().includes('read-only'),
      )

      // The blast radius. A leaked link is one certificate — not a way into
      // the fleet, and not a foothold for walking to another record.
      check(
        'nothing on the page links back into the app',
        (await anonymous.locator('a[href^="/inventory"], a[href^="/maintenance"], nav').count()) === 0,
        'no navigation, no unit page, no other report',
      )
      check(
        'and it is not offered to search engines',
        (await anonymous
          .locator('meta[name="robots"][content*="noindex"]')
          .count()) === 1,
        'these URLs travel on a label, not through an index',
      )

      // Wrong tokens are simply not found — the route never distinguishes
      // "no such token" from "not a calibration", which is what stops it
      // confirming whether a guess was close.
      for (const [what, badToken] of [
        ['a token that does not exist', 'AAAAAAAAAAAAAAAA'],
        ['a token of the wrong shape', 'nope'],
        ['a token with the last character changed', flipLast(withToken.publicToken!)],
      ] as const) {
        const response = await anonymous.goto(`${BASE}${publicReportPath(badToken)}`, {
          waitUntil: 'domcontentloaded',
        })
        check(
          `${what} gets nothing`,
          response?.status() === 404,
          `HTTP ${response?.status()}`,
        )
      }

      // The record id is not the key. Anyone can read a cuid off an internal
      // URL; only the token opens the public view.
      const byId = await anonymous.goto(`${BASE}${publicReportPath(withToken.id)}`, {
        waitUntil: 'domcontentloaded',
      })
      check(
        'the record id is not a substitute for the token',
        byId?.status() === 404,
        `HTTP ${byId?.status()} for /c/<recordId>`,
      )

      // And the internal report still needs a session, so opening the public
      // one did not quietly open everything.
      const internal = await anonymous.goto(`${BASE}/maintenance/records/${withToken.id}/form`, {
        waitUntil: 'domcontentloaded',
      })
      check(
        'the internal report is still behind the login',
        internal?.url().includes('/login') ?? false,
        'the carve-out is one route, not the maintenance section',
      )

      check('no uncaught errors on the public page', anonErrors.length === 0, anonErrors.join(' | '))
    } finally {
      await anonymous.context().close()
    }

    // --- the label actually fits, measured ---------------------------------
    //
    // The checks above read the markup; this one lays it out in a real engine
    // and measures where every element lands. That is the only way to catch
    // the failure being fixed: nothing in the source says "this QR ends 0.019"
    // from the cut", and nothing in the source says "this line is one
    // millimetre too tall, so the browser will start a second page" — which on
    // a roll of die-cut labels means printing onto the next one.
    console.log('\nWhere the OS-driver label actually lands\n')

    const geometry = await page.evaluate(
      `(() => {
        const frame = document.createElement('iframe')
        frame.style.cssText = 'position:fixed;left:-9999px;width:400px;height:300px;border:0'
        document.body.appendChild(frame)
        frame.contentDocument.open()
        frame.contentDocument.write(${JSON.stringify(renderLabelHtml('calibration', measured))})
        frame.contentDocument.close()
        const doc = frame.contentDocument
        const label = doc.querySelector('.label').getBoundingClientRect()
        const safe = doc.querySelector('.safe').getBoundingClientRect()
        const outside = []
        for (const el of doc.querySelectorAll('.safe > *')) {
          const box = el.getBoundingClientRect()
          if (
            box.right > safe.right + 0.5 ||
            box.bottom > safe.bottom + 0.5 ||
            box.left < safe.left - 0.5 ||
            box.top < safe.top - 0.5
          ) {
            outside.push((el.textContent || 'code/rule').slice(0, 24))
          }
        }
        const result = {
          labelW: +label.width.toFixed(1),
          labelH: +label.height.toFixed(1),
          padX: +(safe.left - label.left).toFixed(2),
          padY: +(safe.top - label.top).toFixed(2),
          outside,
        }
        frame.remove()
        return result
      })()`,
    ) as { labelW: number; labelH: number; padX: number; padY: number; outside: string[] }

    // 96 CSS px to the inch, so the stock is 216 x 120.
    check(
      'one label is exactly one page: 2.25" x 1.25"',
      geometry.labelW === 216 && geometry.labelH === 120,
      `${geometry.labelW} x ${geometry.labelH} px at 96 px/in`,
    )
    check(
      'with the keep-out band inside it, not outside',
      Math.abs(geometry.padX - SAFE_PAD_IN * 96) < 0.75 &&
        Math.abs(geometry.padY - SAFE_PAD_IN * 96) < 0.75,
      `${geometry.padX}px x ${geometry.padY}px inset — ${SAFE_PAD_IN}" is ${SAFE_PAD_IN * 96}px`,
    )
    check(
      'and every field inside the band, including the QR and the DUE line',
      geometry.outside.length === 0,
      geometry.outside.length ? `outside: ${geometry.outside.join(', ')}` : 'nothing touches the cut',
    )

    // --- one label is one page, proven by printing it ----------------------
    //
    // The strongest check available without paper. `page.pdf` runs the real
    // print pipeline — pagination, `@page`, the lot — so the page count and
    // media box are what a printer would be handed. A second page here *is*
    // the next label on the roll, which is the reported symptom.
    //
    // Run with an over-long model name as well, because the way this fails in
    // the field is a value nobody sized the layout for.
    for (const [what, extra] of [
      ['a normal label', {}],
      ['a label with an over-long model name', { model: 'MULTIRAE LITE PUMPED SIX GAS CONFINED SPACE MONITOR' }],
      ['a label with a long deployed hostname', {
        scanUrl: 'https://assethub.teksolv-industrial-services.example.com/api/scan/FAM001012-A',
      }],
    ] as const) {
      await page.setContent(renderLabelHtml('calibration', { ...measured, ...extra }))
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true })
      const raw = pdf.toString('latin1')
      const pages = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length
      const box = /\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(raw)
      // PDF units are points: 72 to the inch.
      const width = box ? Number(box[1]) / 72 : 0
      const height = box ? Number(box[2]) / 72 : 0

      check(
        `${what} prints as exactly one page`,
        pages === 1,
        `${pages} page(s) — more than one means it ran onto the next label`,
      )
      check(
        `and on 2.25" x 1.25" media`,
        Math.abs(width - 2.25) < 0.01 && Math.abs(height - 1.25) < 0.01,
        `${width.toFixed(3)}in x ${height.toFixed(3)}in`,
      )
    }

    check('no uncaught client errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
  }

  await probeRealBrowserPrint()

  console.log(failures === 0 ? '\nAll label checks passed.' : `\n${failures} FAILED.`)
  if (failures) process.exit(1)
}

/**
 * Report what the *genuine* Browser Print on this machine can see.
 *
 * Read-only, and deliberately so: `/available` and `/default` only, never
 * `/write`. Driving the real utility would push physical labels out of a real
 * printer on every run, which is not something a verify script gets to decide.
 *
 * Informational rather than pass/fail — most machines running this suite have
 * no Zebra attached, and that is not a failure. Where one *is* attached it
 * answers the question the stub structurally cannot: does the shape this client
 * expects match what Zebra's utility actually returns.
 */
async function probeRealBrowserPrint(): Promise<void> {
  console.log('\nThe real Browser Print on this machine\n')

  try {
    const response = await fetch('http://127.0.0.1:9100/available', {
      signal: AbortSignal.timeout(2000),
    })
    const payload = (await response.json()) as { printer?: { name?: string; uid?: string; connection?: string }[] }
    const printers = payload.printer ?? []

    if (printers.length === 0) {
      console.log('  ..    running, but no Zebra is attached to this computer.')
      return
    }
    for (const printer of printers) {
      console.log(`  ..    ${printer.name} · ${printer.connection} · uid ${printer.uid}`)
    }
    console.log(
      '        Discovery works against the genuine utility. Nothing was printed —\n' +
        '        run Test print from the app to check alignment on real stock.',
    )
  } catch {
    console.log('  ..    not running here. The checks above used a stubbed one.')
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prismaUnscoped.$disconnect())
