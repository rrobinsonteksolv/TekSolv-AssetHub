/**
 * Build the app icon from the TekSolv logo.
 *
 *   npx tsx scripts/make-favicon.ts        (needs `npm run dev`)
 *
 * The full wordmark is unreadable at 32px, so the icon is the **swoosh** — the
 * one element of the mark that survives being shrunk to a tab. Its crop is
 * measured from the artwork rather than eyeballed: the navy pixels' bounding
 * box is found first, so a future logo revision produces a correct icon instead
 * of a subtly clipped one.
 *
 * Written as a build step rather than a checked-in binary somebody hand-made,
 * so the icon and the logo cannot drift apart.
 */
import { chromium } from 'playwright'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const LOGO = `${BASE}/brand/teksolv-logo.png`

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } })
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })

  // Where the navy swoosh actually is, in image pixels.
  const box = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data

    let minX = c.width
    let minY = c.height
    let maxX = 0
    let maxY = 0
    // Where the maroon wordmark starts, so the crop can stop before it.
    let wordX = c.width

    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (data[i + 3] < 200) continue
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
        // Navy: blue clearly dominant, the whole thing dark.
        if (b > 50 && b > r + 25 && r < 90 && g < 90) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
        // Maroon: red clearly dominant.
        if (r > 80 && r > b + 40 && r > g + 40 && x < wordX) wordX = x
      }
    }
    return { minX, minY, maxX, maxY, wordX, width: c.width, height: c.height }
  }, LOGO)

  console.log(
    `swoosh x ${box.minX}–${box.maxX}, y ${box.minY}–${box.maxY} · wordmark starts x ${box.wordX}`,
  )

  // The **crescent**, composed rather than cropped.
  //
  // The arc is a wide open curve with the wordmark nested inside it, so no
  // square crop works: one big enough to hold the crescent's full height also
  // holds a clipped "TEK", and one narrow enough to exclude the wordmark slices
  // the top and bottom off the arc. Either reads as a broken image rather than
  // a mark.
  //
  // So the crescent is *clipped to its own bounds* — a box exactly as wide as
  // the arc is before the maroon starts, and as tall as the arc — and that box
  // is then centred in the tile with padding. The result is the whole crescent,
  // nothing else, at any size.
  const SIZE = 512
  const PAD = 0.11 // of the tile, per side

  const cropLeft = box.minX
  const cropRight = Math.min(box.maxX, box.wordX - 18)
  const cropTop = box.minY
  const cropBottom = box.maxY
  const cropW = cropRight - cropLeft
  const cropH = cropBottom - cropTop

  // Scale so the taller dimension fits the padded box.
  const inner = SIZE * (1 - PAD * 2)
  const scale = inner / Math.max(cropW, cropH)
  const boxW = cropW * scale
  const boxH = cropH * scale

  const canvasPage = await browser.newPage({ viewport: { width: SIZE, height: SIZE } })
  await canvasPage.setContent(`<!doctype html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body { width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
  .tile {
    width: ${SIZE}px; height: ${SIZE}px;
    /* Knockout on the brand maroon.
       At 16px a two-tone mark on white is a grey smudge, so the icon is the
       accent colour with the crescent reversed out of it — the standard
       small-size treatment, and the colour the rest of the UI now leads with.
       The clip above contains navy and nothing else (it stops 18px short of
       the first maroon pixel), so inverting it to white is exact rather than
       a filter that happens to look right. */
    background: #79232e;
    border-radius: 104px;
    overflow: hidden;
    position: relative;
  }
  /* Exactly the crescent's bounds, centred — so nothing else can enter the
     frame and nothing of the arc can fall out of it. */
  .clip {
    position: absolute;
    left: ${(SIZE - boxW) / 2}px;
    top: ${(SIZE - boxH) / 2}px;
    width: ${boxW}px;
    height: ${boxH}px;
    overflow: hidden;
  }
  img {
    position: absolute;
    width: ${box.width * scale}px;
    height: ${box.height * scale}px;
    left: ${-cropLeft * scale}px;
    top: ${-cropTop * scale}px;
    filter: brightness(0) invert(1);
  }
</style></head>
<body><div class="tile"><div class="clip"><img src="${LOGO}"></div></div></body></html>`)

  await canvasPage.waitForTimeout(500)
  const out = path.join(process.cwd(), 'src', 'app', 'icon.png')
  await canvasPage.locator('.tile').screenshot({ path: out, omitBackground: true })
  console.log(`wrote ${out}`)

  await browser.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
