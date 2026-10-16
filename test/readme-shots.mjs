// README screenshots of the console: overview, Explore data on one table, and the architecture diagram,
// written to screenshots/. Before each shot, names that identify a deployment (emails, workspace and app
// hosts, ids, other origins) are replaced with placeholders, and the Explore tree shows only the path to
// the table. Look at the images before committing them anyway.
// usage: node test/readme-shots.mjs <gatewayUrl> <profile> <catalog.schema.table> [label=Replacement ...]
//   e.g. node test/readme-shots.mjs https://lakegate-123.aws.databricksapps.com prod main.ais.hex_r5 prod=Production
import { execFileSync } from 'child_process'
import { launch } from './browser.mjs'
const [gateway, profile, table, ...pairs] = process.argv.slice(2)
if (!table) { console.error('usage: node test/readme-shots.mjs <gatewayUrl> <profile> <catalog.schema.table> [label=Replacement ...]'); process.exit(1) }
const origin = new URL(gateway).origin
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
const shots = new URL('../screenshots/', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))
const [catalog, schema, name] = table.split('.')
// Whole-word replacements given on the command line (workspace labels, a personal catalog name)
const words = pairs.map(p => p.split('='))

const browser = await launch()
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
await page.setRequestInterception(true)
page.on('request', req => new URL(req.url()).origin === origin ? req.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } }) : req.continue())
const errors = []
page.on('pageerror', e => errors.push(e.message))

async function redact () {
  await page.evaluate(words => {
    const rules = [
      [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'you@example.com'],
      [/lakegate-\d{10,}/g, 'lakegate-1234567890123456'],
      [/\b[\w-]+\.cloud\.databricks\.(com|us)\b/g, 'your-workspace.cloud.databricks.com'],
      [/\bec2-[\d-]+\.[\w.-]+\.amazonaws\.com\b/g, 'portal.example.com'],
      [/\b\d{16}\b/g, '1234567890123456'],
      ...words.map(([from, to]) => [new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), to])
    ]
    const clean = s => rules.reduce((t, [re, to]) => t.replace(re, to), s)
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) { const v = clean(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v }
    for (const el of document.querySelectorAll('input, textarea')) el.value = clean(el.value)
    for (const el of document.querySelectorAll('[title]')) el.title = clean(el.title)
  }, words)
}

// Overview and the architecture diagram
await page.goto(`${gateway}/#overview`, { waitUntil: 'networkidle2', timeout: 120000 })
await sleep(1500)
await redact()
await page.screenshot({ path: `${shots}lakegate-overview.png`, fullPage: true })
const arch = await page.$('svg[aria-labelledby="arch-title arch-desc"]')
if (arch) await arch.screenshot({ path: `${shots}architecture.png` })

// Explore data, opened to the table (the console reopens the last table it showed)
await page.evaluate((t, c, s, n) => localStorage.setItem('lakegate.explore.lastTable', JSON.stringify({ table: t, catalog: c, schema: s, name: n, idField: '', geometry: '' })), table, catalog, schema, name)
await page.goto(`${gateway}/#explore`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.reload({ waitUntil: 'networkidle2', timeout: 120000 }) // a hash-only change doesn't reload the app
await page.waitForSelector('.node.table.active', { timeout: 180000 }).catch(() => {})
await page.waitForSelector('.map-preview-status', { timeout: 60000 }).catch(() => {})
await page.waitForFunction(() => !document.querySelector('.map-preview-status'), { timeout: 300000 }).catch(() => {})
await page.waitForNetworkIdle({ idleTime: 3000, timeout: 300000 }).catch(() => {}) // layer tiles done
// Only the path to the table: other catalogs and schemas stay out of the picture
await page.evaluate((c, s) => {
  const hideSiblings = (selector, keep) => {
    for (const b of document.querySelectorAll(selector)) {
      if (b.querySelector('.node-name')?.textContent !== keep) b.parentElement.style.display = 'none'
    }
  }
  hideSiblings('.node.catalog', c)
  hideSiblings('.node.schema', s)
  window.scrollTo(0, 0)
}, catalog, schema)
await redact()
await page.screenshot({ path: `${shots}lakegate-explore.png` })

console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(' | ')}` : 'no page errors', '| architecture:', !!arch)
await browser.close()
