// Screenshots of the showcase pages (MapLibre GL, OpenLayers, Leaflet) against a deployed gateway, written to
// screenshots/ogc-<page>.png. Serves this folder on http://localhost:5199 (which must be in the gateway's
// allowed_origins), hands each page the CLI's OAuth token, and replaces the gateway's id before each shot.
// usage: node test/ogc-clients/shots.mjs <gatewayUrl> <profile> [page ...]
import { execFileSync } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { launch } from '../browser.mjs'
const [gateway, profile, ...only] = process.argv.slice(2)
if (!profile) { console.error('usage: node test/ogc-clients/shots.mjs <gatewayUrl> <profile> [page ...]'); process.exit(1) }
const here = path.dirname(new URL(import.meta.url).pathname)
const shots = path.resolve(here, '../../screenshots')
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
const pages = only.length ? only : ['maplibre', 'openlayers', 'leaflet']

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }
const server = http.createServer((req, res) => {
  const file = path.join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!file.startsWith(here) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(5199)

const browser = await launch()
for (const name of pages) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.evaluateOnNewDocument(t => { window.GLL_TOKEN = t }, token)
  const started = Date.now()
  await page.goto(`http://localhost:5199/${name}.html?gateway=${encodeURIComponent(gateway)}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => window.GLL_DONE, { timeout: 600000 }).catch(() => errors.push('timed out waiting for the page'))
  await page.waitForNetworkIdle({ idleTime: 2000, timeout: 120000 }).catch(() => {})
  await page.evaluate(() => {
    const clean = s => s.replace(/geolakelayers-\d{10,}/g, 'geolakelayers-1234567890123456').replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'you@example.com')
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = clean(n.nodeValue)
  })
  await page.screenshot({ path: `${shots}/ogc-${name}.png` })
  console.log(name, `${Math.round((Date.now() - started) / 1000)} s`, errors.length ? `errors: ${errors.join(' | ')}` : 'ok')
  await page.close()
}
await browser.close()
server.close()
