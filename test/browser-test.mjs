// Headless run of test/index.html against the deployed gateway.
// Real: popup handoff, postMessage, SDK interceptor, browser CORS, FeatureLayer loading.
// Simulated: the popup's Databricks login — its handoff request carries the CLI token
// instead of a browser session cookie.
// usage: node test/browser-test.mjs <gatewayUrl> <profile> <catalog.schema.table> [table ...]
// Serve test/ on :5199 first (e.g. npx http-server test -p 5199).
import { execFileSync } from 'child_process';
import fs from 'fs';
import { launch } from './browser.mjs';

const [GATEWAY, profile, ...tables] = process.argv.slice(2);
if (!GATEWAY || !profile || !tables.length) { console.error('usage: node test/browser-test.mjs <gatewayUrl> <profile> <catalog.schema.table> [table ...]'); process.exit(2); }
const catalogs = [...new Set(tables.map((t) => t.split('.')[0]))].join(',');
const PAGE = `http://localhost:5199/index.html?gateway=${encodeURIComponent(GATEWAY)}&catalogs=${encodeURIComponent(catalogs)}`;
const out = new URL('../testimages/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cliToken = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token;

const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => problems.push(`failed: ${r.url().slice(0, 140)} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.url().startsWith(GATEWAY) && r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url().slice(0, 140)}`); });

// Open the popup blank first so request interception is on before it navigates to the handoff page
await page.evaluateOnNewDocument(() => {
  const open = window.open.bind(window);
  window.open = (url, name, features) => { const w = open('about:blank', name, features); setTimeout(() => { w.location.href = url; }, 800); return w; };
});
browser.on('targetcreated', async (t) => {
  if (t.type() !== 'page') return;
  const p = await t.page();
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    if (req.url().startsWith(`${GATEWAY}/auth/handoff`)) req.continue({ headers: { ...req.headers(), authorization: `Bearer ${cliToken}` } });
    else req.continue();
  });
});

await page.goto(PAGE, { waitUntil: 'networkidle2' });
await page.click('#signin');
await page.waitForFunction(() => document.querySelectorAll('#tables .t').length > 0, { timeout: 90000 });
console.log('status:', await page.$eval('#status', (e) => e.textContent));
await page.screenshot({ path: `${out}exb-gw-catalog.png` });

for (const [i, table] of tables.entries()) {
  const name = table.split('.').pop();
  await page.$eval('#filter', (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); }, name);
  const clicked = await page.$$eval('#tables .t', (els, t) => {
    const el = els.find((e) => e.textContent.includes(t.split('.').slice(1).join('.')));
    if (el) el.click();
    return !!el;
  }, table);
  if (!clicked) { console.log(`${table}: not in catalog`); continue; }
  await page.waitForFunction((n) => [...document.querySelectorAll('#added div')].slice(-1)[0]?.textContent.match(/features|failed/), { timeout: 120000 }, i);
  await sleep(4000); // let the layer draw
  const row = await page.$$eval('#added div', (els) => els.slice(-1)[0].textContent);
  const drawn = await page.evaluate(async (t) => {
    const lyr = window.view.map.layers.find((l) => l.url && l.url.includes(t));
    const lv = await window.view.whenLayerView(lyr);
    const q = await lv.queryFeatureCount();
    return q;
  }, table);
  console.log(`${row} | drawn in view: ${drawn}`);
  await page.screenshot({ path: `${out}exb-gw-${name}.png` });
}

console.log(problems.length ? `problems:\n  ${[...new Set(problems)].slice(0, 15).join('\n  ')}` : 'no console errors or failed requests');
await browser.close();
