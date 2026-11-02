// Opens each live demo page on a deployed gateway as you (CLI OAuth token), waits for it to finish loading, then
// clicks around the map centre until an identify popup opens, and screenshots it to testimages/demo-<page>.png.
// usage: node test/demo-identify-check.mjs <gatewayUrl> <profile> [page ...]
import { execFileSync } from 'child_process'
import { launch } from './browser.mjs'
const [gateway, profile, ...only] = process.argv.slice(2)
const origin = new URL(gateway).origin
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
const out = new URL('../testimages/', import.meta.url).pathname
const pages = only.length ? only : ['maplibre', 'qgis', 'openlayers', 'leaflet']
const POPUP = '.maplibregl-popup .gll-popup, .leaflet-popup .gll-popup, #ol-popup:not([hidden]) .gll-popup'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await launch()
let failed = 0
for (const name of pages) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', req => new URL(req.url()).origin === origin ? req.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } }) : req.continue())
  const logs = []
  page.on('console', m => { if (['error', 'warn'].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 160)}`) })
  page.on('pageerror', e => logs.push(`pageerror: ${e.message}`))
  const t0 = Date.now()
  await page.goto(`${gateway}/demos/${name}.html`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => window.GLL_DONE, { timeout: 300000 }).catch(() => logs.push('timed out waiting for GLL_DONE'))
  const err = await page.evaluate(() => window.GLL_ERROR || '')
  const loadS = ((Date.now() - t0) / 1000).toFixed(1)
  await sleep(1500)
  // probe a grid around the centre until a popup shows up
  let hit = null
  outer: for (const r of [0, 40, 80, 120, 160, 200, 260, 320]) {
    for (const [dx, dy] of r === 0 ? [[0, 0]] : [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const x = 720 + dx, y = 450 + dy
      await page.mouse.click(x, y); await sleep(350)
      if (await page.$(POPUP)) { hit = [x, y]; break outer }
    }
  }
  const text = hit ? await page.$eval(POPUP, e => e.innerText.replace(/\s+/g, ' ').slice(0, 220)) : ''
  const link = hit ? await page.$eval(POPUP + ' a', a => a.href).catch(() => '') : ''
  await page.screenshot({ path: `${out}demo-${name}.png` })
  const ok = !err && hit && !logs.some(l => l.startsWith('pageerror'))
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: loaded in ${loadS}s${err ? ` ERROR: ${err}` : ''}${hit ? ` popup at ${hit.join(',')}: "${text}"` : ' no popup found'}${link ? ` link ${link.replace(origin, '')}` : ''}${logs.length ? `\n      ${logs.slice(0, 4).join('\n      ')}` : ''}`)
  await page.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
