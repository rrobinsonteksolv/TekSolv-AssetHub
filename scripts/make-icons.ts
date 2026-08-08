/**
 * Generate the home-screen icons.
 *
 * The supplied logo is a wide wordmark on transparency, which is the wrong
 * shape and the wrong contrast for a 48px home-screen tile: squeezed into a
 * square it becomes an unreadable smear, and its two dark inks vanish against a
 * dark launcher. So the icon is built from the *distinctive* part of the mark —
 * the swoosh — reversed out of the brand maroon, which reads at any size and
 * still says TekSolv.
 *
 * Rasterized with Playwright because it is already a dependency; adding an
 * image library to draw four squares would not be worth the install.
 *
 *   npx tsx scripts/make-icons.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const MAROON = '#79232e'
const NAVY = '#051c48'

/**
 * `padded` leaves room for the circular crop Android applies to maskable
 * icons — the safe zone is the middle 80%, so an icon drawn edge to edge loses
 * its edges. The apple-touch icon is *not* padded: iOS crops nothing and rounds
 * the corners itself.
 */
function svg({ size, padded }: { size: number; padded: boolean }) {
  const inset = padded ? size * 0.14 : size * 0.06
  const box = size - inset * 2
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${MAROON}"/>
  <g transform="translate(${inset} ${inset}) scale(${box / 100})">
    <!-- The crescent, traced from the logo's swoosh: an open C that reads as
         motion. Drawn in white on the maroon field so it survives a dark
         launcher background, with a navy inner edge to keep the two-colour
         mark rather than flattening it to one. -->
    <path d="M78 6 C34 6 6 28 6 50 C6 72 34 94 78 94 C52 88 26 74 26 50 C26 26 52 12 78 6 Z"
          fill="#ffffff"/>
    <path d="M78 6 C34 6 6 28 6 50 C6 72 34 94 78 94 C52 88 26 74 26 50 C26 26 52 12 78 6 Z"
          fill="none" stroke="${NAVY}" stroke-width="2.5"/>
  </g>
</svg>`
}

const ICONS = [
  { file: 'icon-192.png', size: 192, padded: true },
  { file: 'icon-512.png', size: 512, padded: true },
  { file: 'apple-touch-icon.png', size: 180, padded: false },
  { file: 'favicon-32.png', size: 32, padded: false },
]

async function main() {
  mkdirSync('public/icons', { recursive: true })
  const browser = await chromium.launch()

  for (const icon of ICONS) {
    const page = await browser.newPage({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
    })
    await page.setContent(
      `<style>html,body{margin:0;padding:0}</style>${svg({ size: icon.size, padded: icon.padded })}`,
    )
    const shot = await page.screenshot({ omitBackground: true })
    writeFileSync(`public/icons/${icon.file}`, shot)
    await page.close()
    console.log(`  public/icons/${icon.file}  ${icon.size}x${icon.size}`)
  }

  // The manifest's own copy of the source, so a future edit regenerates rather
  // than reverse-engineers.
  writeFileSync('public/icons/icon.svg', svg({ size: 512, padded: true }).trim())
  console.log('  public/icons/icon.svg')

  await browser.close()
}

main()
