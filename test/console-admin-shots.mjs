// Screenshots of the Admin tab and the architecture diagram (written to screenshots/architecture.png).
// usage: node test/console-admin-shots.mjs <gatewayUrl> <profile>
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
const require = createRequire(import.meta.url)
const puppeteer = require(`${process.env.HOME}/Documents/gitprojects/trident-ais/.uitest/node_modules/puppeteer-core`)
const [gateway, profile = 'prod'] = process.argv.slice(2)
const origin = new URL(gateway).origin
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
const out = new URL('../testimages/', import.meta.url).pathname
const shots = new URL('../screenshots/', import.meta.url).pathname
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: `/tmp/console-${Date.now()}` })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
await page.setRequestInterception(true)
page.on('request', req => new URL(req.url()).origin === origin ? req.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } }) : req.continue())
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.goto(`${gateway}/`, { waitUntil: 'networkidle2', timeout: 120000 })
await sleep(1500)
await page.screenshot({ path: `${out}admin-overview.png`, fullPage: true })
const arch = await page.$('svg[aria-labelledby="arch-title arch-desc"]')
if (arch) await arch.screenshot({ path: `${shots}architecture.png` })
const tabs = await page.$$('button.tab')
await tabs[tabs.length - 1].click()
await page.waitForFunction(() => document.querySelectorAll('.health-dot.wait').length === 0, { timeout: 60000 }).catch(() => {})
await sleep(800)
const field = await page.$('input[aria-label="Experience Builder address"]')
if (field) await field.type('https://localhost:3001/builder/')
await sleep(300)
await page.screenshot({ path: `${out}admin-tab.png`, fullPage: true })
console.log(errors.length ? errors.join('\n') : 'no page errors', '| architecture:', !!arch)
await browser.close()
