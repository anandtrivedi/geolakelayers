// Shared by the live demo pages (/demos/*.html): which OGC service to read, paging through items, the caption,
// status and error messages. The pages are served by the gateway itself, so the Databricks Apps front door signs
// the viewer in and every request runs as them: no token handling here.
//   /demos/maplibre.html?service=ais-demo
const params = new URLSearchParams(location.search)
export const service = params.get('service') || 'ais-demo'
export const serviceUrl = `/ogc/${encodeURIComponent(service)}`
export const landingUrl = location.origin + serviceUrl

// Why a request failed, in words the viewer can act on
function explain (status, what) {
  if (status === 401) return 'Your Databricks sign-in has expired. Reload the page to sign in again.'
  if (status === 403) return `You don't have SELECT on the table behind ${what}. Ask its owner for access in Unity Catalog.`
  if (status === 404) return what.startsWith('the service')
    ? `This gateway has no OGC service named “${service}”. Open the console's OGC / QGIS tab to pick or publish one, then add ?service=<name> to this page's address.`
    : `${what} isn't in the “${service}” service.`
  return `${what} could not be read (HTTP ${status}).`
}

// The service must exist before any map work starts (a gateway without OGC services gets a message, not a broken map)
export async function checkService () {
  const res = await fetch(`${serviceUrl}?f=json`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(explain(res.status, `the service “${service}”`))
  return res.json()
}

// Every page of an OGC API – Features items response (following rel=next), as one FeatureCollection
export async function items (collection, query = '', onProgress) {
  let url = `${serviceUrl}/collections/${collection}/items?f=json&limit=4000${query ? `&${query}` : ''}`
  const features = []
  while (url) {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(explain(res.status, `the “${collection}” collection`))
    const page = await res.json()
    features.push(...page.features)
    onProgress?.(features.length)
    url = (page.links || []).find(l => l.rel === 'next')?.href
  }
  return { type: 'FeatureCollection', features }
}

// The caption card every page shows: title, a line about where the data came from, and a legend
export function caption ({ title, sub, legend = [], client }) {
  const el = document.getElementById('caption')
  el.innerHTML = `<h1>${title}</h1><p>${sub}</p>` +
    (legend.length ? `<ul>${legend.map(([color, label]) => `<li><i style="background:${color}"></i>${label}</li>`).join('')}</ul>` : '') +
    `<p class="src">${client} · OGC API – Features · <code>${serviceUrl}</code> · Unity Catalog, queried live as you</p>`
}

export const status = text => { const el = document.getElementById('status'); el.classList.remove('error'); el.textContent = text }
export const done = () => { status(''); window.GLL_DONE = true }
export function fail (err) {
  const el = document.getElementById('status')
  el.classList.add('error')
  el.textContent = err.message || String(err)
  window.GLL_DONE = true
  window.GLL_ERROR = el.textContent
}

// Links shown on every page: back to the console's OGC tab and to the other demos
export function nav () {
  const el = document.createElement('nav')
  el.id = 'demo-nav'
  const q = service === 'ais-demo' ? '' : `?service=${encodeURIComponent(service)}`
  el.innerHTML = `<a href="./${q}">All demos</a><a href="/#ogc">Open in console</a>`
  document.body.appendChild(el)
}

// Magma-like ramp for counts (dark purple → orange → pale yellow), by quantile breaks
export const RAMP = ['#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf']
export function breaks (values, n = RAMP.length) {
  const v = values.filter(x => x != null).sort((a, b) => a - b)
  return Array.from({ length: n - 1 }, (_, i) => v[Math.floor(((i + 1) / n) * (v.length - 1))])
}

// AIS vessel type codes grouped the way the U.S. Coast Guard's NAIS data is usually mapped
export const VESSEL_GROUPS = [
  ['Cargo', '#4fc3e8', t => t >= 70 && t <= 79],
  ['Tanker', '#ff6b4a', t => t >= 80 && t <= 89],
  ['Passenger', '#f7d154', t => t >= 60 && t <= 69],
  ['Tug / towing', '#9be36d', t => t === 31 || t === 32 || t === 52],
  ['Fishing', '#c792ea', t => t === 30],
  ['Pleasure / sailing', '#ff9ec7', t => t === 36 || t === 37],
  ['Other', '#9aa5ad', () => true]
]
export const vesselGroup = t => VESSEL_GROUPS.find(([, , test]) => test(Number(t)))

// Esri Dark Gray Canvas (no key needed for display; keep the attribution). Tiles load in the viewer's browser.
export const DARK_GRAY = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
export const DARK_GRAY_ATTRIBUTION = 'Esri, HERE, Garmin, © OpenStreetMap contributors'

// AIS tracks join consecutive pings, so a vessel that went quiet draws a straight line across land. Split each
// line where two pings are more than maxKm apart.
const km = ([x1, y1], [x2, y2]) => {
  const r = Math.PI / 180, a = Math.sin((y2 - y1) * r / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin((x2 - x1) * r / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(a))
}
export function splitJumps (fc, maxKm = 3) {
  for (const f of fc.features) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates
    const parts = []
    for (const line of lines) {
      let part = [line[0]]
      for (let i = 1; i < line.length; i++) {
        if (km(line[i - 1], line[i]) > maxKm) { if (part.length > 1) parts.push(part); part = [] }
        part.push(line[i])
      }
      if (part.length > 1) parts.push(part)
    }
    f.geometry = { type: 'MultiLineString', coordinates: parts }
  }
  return fc
}
