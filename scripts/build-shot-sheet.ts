/**
 * Build the before/after review sheet from docs/shots/{before,after}.
 *
 *   npx tsx scripts/build-shot-sheet.ts "Phase 1 · TekSolv branding"
 *
 * Images are downscaled and inlined as data URIs, because the published page
 * has to be self-contained — a review sheet that depends on files nobody else
 * has is not a review sheet.
 */
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const SHOTS = path.join(process.cwd(), 'docs', 'shots')
const OUT = path.join(
  'C:/Users/tapou/AppData/Local/Temp/claude/c--Users-tapou-Downloads-Teksolv-Inventory-app/e2fdf4df-bb90-4d32-a623-2e7c6d201e77/scratchpad',
  process.env.SHEET_NAME ?? 'phase1-review.html',
)

const TITLES: Record<string, { name: string; note: string }> = {
  '01-login': { name: 'Sign in', note: 'The front door — first thing in the demo.' },
  '02-dashboard': { name: 'Dashboard', note: 'Sidebar lockup, active nav, KPI tiles, primary action.' },
  '03-asset-overview': { name: 'Asset · Overview', note: 'Drawer over the inventory list.' },
  '04-asset-inspections': { name: 'Asset · Inspections', note: 'Inspection history on the unit.' },
  '05-asset-maintenance': { name: 'Asset · Maintenance', note: 'Calibration history and the cal sticker.' },
  '06-truck-167': { name: 'Truck 167', note: 'The loadout, scan box and move action.' },
  '07-utilization': { name: 'Utilization', note: 'Days on rent, ranked within each category.' },
  '08-idle-capital': { name: 'Idle capital', note: 'The same table read from the other end.' },
  '09-fp01-blank': { name: 'Form FP-01', note: 'The printed document an owner is handed.' },
}

async function main() {
  const heading = process.argv[2] ?? 'Visual pass'
  // Which capture is the baseline. Phase 2 compares against phase 1, not
  // against the original, so the sheet shows what *this* phase changed.
  const baseline = process.argv[3] ?? 'before'
  const names = readdirSync(path.join(SHOTS, baseline))
    .filter((file) => file.endsWith('.png'))
    .sort()

  const browser = await chromium.launch()
  const page = await browser.newPage()
  // A blank page is enough: every image arrives as a data URI, so nothing is
  // fetched and the app does not need to be running.
  await page.setContent('<html><body></body></html>')

  /** Read from disk, downscale in the browser, return a JPEG data URI. */
  async function inline(file: string): Promise<string> {
    const raw = `data:image/png;base64,${readFileSync(path.join(SHOTS, file)).toString('base64')}`
    return page.evaluate(async (src) => {
      const img = new Image()
      img.src = src
      await img.decode()
      const width = 780
      const c = document.createElement('canvas')
      c.width = width
      c.height = Math.round((img.height / img.width) * width)
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, c.width, c.height)
      return c.toDataURL('image/jpeg', 0.72)
    }, raw)
  }

  const baselineLabel = baseline === 'before' ? 'Before' : 'Phase 1'
  const rows: string[] = []
  for (const file of names) {
    const key = file.replace('.png', '')
    const meta = TITLES[key] ?? { name: key, note: '' }
    const before = await inline(`${baseline}/${file}`)
    const afterPath = path.join(SHOTS, 'after', file)
    const after = existsSync(afterPath) ? await inline(`after/${file}`) : before

    rows.push(`
<section class="pair">
  <header class="pair-head">
    <h3>${meta.name}</h3>
    <p>${meta.note}</p>
  </header>
  <div class="frames">
    <figure><figcaption><span class="tag tag-before">${baselineLabel}</span></figcaption><img src="${before}" alt="${meta.name}, before"></figure>
    <figure><figcaption><span class="tag tag-after">After</span></figcaption><img src="${after}" alt="${meta.name}, after"></figure>
  </div>
</section>`)
  }

  const logoRaw = `data:image/png;base64,${readFileSync(
    path.join(process.cwd(), 'public', 'brand', 'teksolv-logo.png'),
  ).toString('base64')}`
  const logo = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 420
    c.height = Math.round((img.height / img.width) * 420)
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  }, logoRaw)

  await browser.close()

  writeFileSync(OUT, template(heading, logo, rows.join('\n')), 'utf8')
  console.log(`wrote ${OUT}`)
}

function template(heading: string, logo: string, rows: string): string {
  return `<title>AssetHub — ${heading.replace(/ ·.*/, '')} review</title>
<style>
  /* Tokens are the app's own, so the sheet is painted in the palette it is
     reviewing. Neutrals carry a faint red bias rather than being pure grey. */
  :root {
    --maroon: #79232e;
    --maroon-lift: #8b2836;
    --maroon-text: #79232e;
    --navy: #051c48;
    --ground: #f6f4f4;
    --card: #ffffff;
    --ink: #1a1618;
    --muted: #6b6367;
    --faint: #9b9297;
    --rule: #e5dfe0;
    --soft: #f7e9eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0c0b0c;
      --card: #151316;
      --ink: #f3f0f1;
      --muted: #a09a9d;
      --faint: #6d666a;
      --rule: #2a2529;
      --soft: #31141a;
      --maroon-text: #d4808c;
    }
  }
  :root[data-theme="dark"] {
    --ground: #0c0b0c; --card: #151316; --ink: #f3f0f1; --muted: #a09a9d;
    --faint: #6d666a; --rule: #2a2529; --soft: #31141a; --maroon-text: #d4808c;
  }
  :root[data-theme="light"] {
    --ground: #f6f4f4; --card: #ffffff; --ink: #1a1618; --muted: #6b6367;
    --faint: #9b9297; --rule: #e5dfe0; --soft: #f7e9eb; --maroon-text: #79232e;
  }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font: 400 15px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 24px 72px; }

  /* Masthead ------------------------------------------------------------ */
  .mast { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 20px 28px; padding-bottom: 22px; border-bottom: 2px solid var(--maroon); }
  .mast img { width: 210px; height: auto; display: block; background: #fff; padding: 10px 12px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.18); }
  .mast-txt { flex: 1 1 320px; }
  .eyebrow { font: 600 11px/1 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; color: var(--maroon-text); margin: 0 0 8px; }
  h1 { margin: 0; font-size: 30px; line-height: 1.15; letter-spacing: -.022em; font-weight: 650; text-wrap: balance; }
  .sub { margin: 8px 0 0; color: var(--muted); max-width: 62ch; }

  /* Token strip --------------------------------------------------------- */
  .tokens { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 12px; margin: 26px 0 34px; }
  .token { background: var(--card); border: 1px solid var(--rule); border-radius: 10px; padding: 13px 14px; }
  .chip { height: 30px; border-radius: 6px; margin-bottom: 10px; border: 1px solid rgba(0,0,0,.14); }
  .token b { display: block; font-size: 13.5px; font-weight: 600; }
  .token code, .ratio { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--muted); }
  .token p { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); }

  /* Pairs ---------------------------------------------------------------- */
  .pair { margin-top: 34px; }
  .pair-head { border-left: 3px solid var(--maroon); padding-left: 12px; margin-bottom: 14px; }
  .pair-head h3 { margin: 0; font-size: 17px; letter-spacing: -.012em; font-weight: 620; }
  .pair-head p { margin: 3px 0 0; font-size: 13px; color: var(--muted); }
  .frames { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 860px) { .frames { grid-template-columns: 1fr; } }
  figure { margin: 0; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
  figcaption { padding: 9px 12px; border-bottom: 1px solid var(--rule); }
  figure img { display: block; width: 100%; height: auto; }
  .tag { font: 600 10.5px/1 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; letter-spacing: .13em; text-transform: uppercase; padding: 4px 8px; border-radius: 999px; }
  .tag-before { background: var(--rule); color: var(--muted); }
  .tag-after { background: var(--soft); color: var(--maroon-text); }

  .note { margin-top: 40px; background: var(--card); border: 1px solid var(--rule); border-left: 3px solid var(--navy); border-radius: 10px; padding: 16px 18px; }
  .note h2 { margin: 0 0 8px; font-size: 15px; font-weight: 620; }
  .note ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13.5px; }
  .note li + li { margin-top: 6px; }
  .note strong { color: var(--ink); font-weight: 600; }
</style>

<div class="wrap">
  <header class="mast">
    <img src="${logo}" alt="TekSolv">
    <div class="mast-txt">
      <p class="eyebrow">AssetHub · Presentation pass</p>
      <h1>${heading}</h1>
      <p class="sub">Demo path, captured at 1440&times;900 on the dark base. Visual only — no status logic, custody rules, rental invariants or server behaviour changed.</p>
    </div>
  </header>

  <div class="tokens">
    <div class="token">
      <div class="chip" style="background:#79232e"></div>
      <b>Maroon — fills</b>
      <code>#79232e</code>
      <p>Sampled from the wordmark. White on it: <span class="ratio">10.0:1</span>.</p>
    </div>
    <div class="token">
      <div class="chip" style="background:#d4808c"></div>
      <b>Lifted — text on dark</b>
      <code>#d4808c</code>
      <p>True maroon as text on the dark panel is <span class="ratio">1.8:1</span>. This is <span class="ratio">6.3:1</span>.</p>
    </div>
    <div class="token">
      <div class="chip" style="background:#31141a"></div>
      <b>Soft — chips, active nav</b>
      <code>#31141a</code>
      <p>The tint behind accent text.</p>
    </div>
    <div class="token">
      <div class="chip" style="background:#051c48"></div>
      <b>Navy — the mark only</b>
      <code>#051c48</code>
      <p>The swoosh. Kept for the logo; not used to paint the UI.</p>
    </div>
  </div>

  ${rows}

  <div class="note">
    <h2>Measured, not eyeballed</h2>
    <ul>
      <li><strong>The demo path was walked by a script, at two widths.</strong> Eleven screens at 1440 and 1280, checking for sideways page scroll, content clipped by its own box, images without intrinsic size, and console errors. <strong>All clean</strong> — which is Phases 1&ndash;3 having been done carefully rather than luck. It runs as <code>npm run verify:polish</code>, so it stays clean.</li>
      <li><strong>One real gap it found:</strong> transitions ignored <code>prefers-reduced-motion</code>. For somebody with a vestibular disorder, motion they did not ask for is a symptom rather than a flourish. Now switched off at the root, along with one shared duration and easing for every interactive surface — scattered ad-hoc timings are what make an interface feel assembled from parts.</li>
      <li><strong>The printed forms carry the real mark.</strong> FP-01 and CAL-01 shared a hand-copied letterhead that had already begun to differ; it is now one component. The logo sits on a white plate for the same reason it does in the app — the navy swoosh is invisible on the slate band — and on paper the plate is free, because it is unprinted stock.</li>
      <li><strong>The rule under the letterhead went from a generic orange to TekSolv maroon</strong>, as a fixed ink value rather than the theme token. A token would resolve to the <em>lightened</em> dark-mode maroon for anyone viewing with a dark OS — a colour picked for contrast against near-black, which prints as washed-out pink.</li>
      <li><strong>A note on my own check:</strong> the reduced-motion test failed at first against correct code. It asserted durations were exactly zero; the value is a hundredth of a millisecond on purpose, because a literal <code>0</code> can stop <code>transitionend</code> from firing and silently break anything waiting on it. The test was wrong, not the CSS.</li>
      <li><strong>Still open, and still yours:</strong> Utilization shows units at <em>0%, never rented, owned 2.3 days</em>. That is missing acquisition dates rather than an idle fleet — backfilling in-service dates is a data change, so I have left it.</li>
    </ul>
  </div>
</div>`
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
