// Screenshots of the LakeGate console. The CLI token is attached only to requests for the gateway's
// own origin (never to Esri's CDN or anything else).
// usage: node test/console-shots.mjs <gatewayUrl> <profile> <outPrefix>
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
const require = createRequire(import.meta.url)
const puppeteer = require(`${process.env.HOME}/Documents/gitprojects/trident-ais/.uitest/node_modules/puppeteer-core`)
const [gateway, profile = 'prod', prefix = 'console'] = process.argv.slice(2)
const origin = new URL(gateway).origin
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
const out = new URL('../testimages/', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: `/tmp/console-${Date.now()}`, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.setRequestInterception(true)
page.on('request', req => {
  if (new URL(req.url()).origin === origin) req.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } })
  else req.continue()
})
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.goto(`${gateway}/#overview`, { waitUntil: 'networkidle2', timeout: 120000 })
await sleep(1500)
await page.screenshot({ path: `${out}${prefix}-overview.png`, fullPage: true })
await page.click('button.tab:nth-child(2)')
await page.waitForSelector('.node.catalog', { timeout: 60000 })
const opened = await page.$$eval('.node.catalog', (els, c) => { const el = els.find(e => e.textContent.includes(c)); if (el) el.click(); return !!el }, process.env.CATALOG || 'main')
if (opened) {
  await page.waitForSelector('.node.table', { timeout: 120000 }).catch(() => {})
  await page.$$eval('.node.schema', (els, sc) => { const el = els.find(e => e.textContent.includes(sc)) || els[0]; el?.click() }, process.env.SCHEMA || 'maritime')
  await page.waitForSelector('.node.table', { timeout: 30000 })
  await page.$$eval('.node.table', (els, t) => { const el = els.find(e => e.textContent.includes(t)) || els[0]; el?.click() }, process.env.TABLE || 'gold_anomaly_loitering')
  await page.waitForFunction(() => !document.querySelector('.map-preview-status'), { timeout: 120000 }).catch(() => {})
  await sleep(2500)
}
await page.screenshot({ path: `${out}${prefix}-explore.png` })
await page.click('button.tab:nth-child(3)')
await sleep(800)
await page.screenshot({ path: `${out}${prefix}-workspaces.png` })
console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(' | ')}` : 'no page errors')
await browser.close()
