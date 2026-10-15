// Shared setup for the browser checks: puppeteer-core and a local Chrome.
// Install once with `npm install` in test/, or point PUPPETEER_CORE at an existing puppeteer-core folder.
// CHROME overrides the browser path; the default is the usual install location on macOS, Linux and Windows.
import { createRequire } from 'module'
import fs from 'fs'
const require = createRequire(import.meta.url)

export const puppeteer = (() => {
  try { return require(process.env.PUPPETEER_CORE || 'puppeteer-core') } catch (_) {
    throw new Error('puppeteer-core not found: run `npm install` in test/, or set PUPPETEER_CORE to its folder')
  }
})()

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
]
export const chrome = process.env.CHROME || CHROMES.find(p => fs.existsSync(p))

// WebGL through SwiftShader, so ArcGIS maps draw in headless Chrome
export const WEBGL_ARGS = ['--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

export function launch (opts = {}) {
  if (!chrome) throw new Error('Chrome not found: set CHROME to its path')
  return puppeteer.launch({ executablePath: chrome, headless: 'new', args: WEBGL_ARGS, ...opts })
}
