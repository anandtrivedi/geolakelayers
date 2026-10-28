// Renders geolakelayers-dataflow.svg to a 1920-wide PNG with DM Sans (from the gateway's @fontsource packages).
//   node docs/architecture/export.mjs
import fs from 'fs'
import path from 'path'
import { launch } from '../../test/browser.mjs'
const here = path.dirname(new URL(import.meta.url).pathname)
const fonts = path.join(here, '../../gateway/node_modules/@fontsource/dm-sans/files')
const face = w => `@font-face { font-family: 'DM Sans'; font-weight: ${w}; src: url(data:font/woff2;base64,${fs.readFileSync(path.join(fonts, `dm-sans-latin-${w}-normal.woff2`)).toString('base64')}) format('woff2'); }`
const svg = fs.readFileSync(path.join(here, 'geolakelayers-dataflow.svg'), 'utf8')
const [w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/).slice(1).map(Number)
const browser = await launch()
const page = await browser.newPage()
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 })
await page.setContent(`<html><head><style>${face(400)}${face(700)} body { margin: 0 }</style></head><body>${svg}</body></html>`)
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: path.join(here, 'geolakelayers-dataflow.png'), clip: { x: 0, y: 0, width: w, height: h } })
await browser.close()
console.log('wrote geolakelayers-dataflow.png')
