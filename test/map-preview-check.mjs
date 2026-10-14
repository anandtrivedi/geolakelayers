// Opens Explore data on one table and reports what the map preview does (status text, view center/scale).
// usage: node test/map-preview-check.mjs <gatewayUrl> <profile> <catalog.schema.table> <outName>
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
const require = createRequire(import.meta.url)
const puppeteer = require(`${process.env.HOME}/Documents/gitprojects/trident-ais/.uitest/node_modules/puppeteer-core`)
const [gateway, profile, table, name = 'preview'] = process.argv.slice(2)
const origin = new URL(gateway).origin
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
const out = new URL('../testimages/', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', userDataDir: `/tmp/console-${Date.now()}`, args: ['--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.setRequestInterception(true)
page.on('request', req => new URL(req.url()).origin === origin ? req.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } }) : req.continue())
const logs = []
page.on('console', m => { if (['error', 'warn'].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 200)}`) })
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`))
const [catalog, schema] = table.split('.')
await page.evaluateOnNewDocument((t, c, s, n) => localStorage.setItem('lakegate.explore.lastTable', JSON.stringify({ table: t, catalog: c, schema: s, name: n, idField: '', geometry: '' })), table, catalog, schema, table.split('.')[2])
await page.goto(`${gateway}/#explore`, { waitUntil: 'networkidle2', timeout: 120000 })
const t0 = Date.now()
let last = ''
while (Date.now() - t0 < 90000) {
  const s = await page.$eval('.map-preview-status', e => e.textContent).catch(() => '')
  if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s status: ${s || '(none)'}`); last = s }
  if (!s || /zoom in|failed/i.test(s)) break
  await sleep(500)
}
await sleep(2500)
await page.$eval('.map-preview', e => e.scrollIntoView({ block: 'center' })).catch(() => {})
await sleep(500)
await page.screenshot({ path: `${out}${name}.png` })
console.log(logs.slice(0, 8).join('\n') || 'no console errors')
await browser.close()
