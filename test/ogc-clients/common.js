// Shared by the showcase pages: which gateway and service to read, the token, and paging through items.
//   page.html?gateway=https://geolakelayers-<id>.aws.databricksapps.com&service=ais-demo#token=<OAuth token>
// The token goes in the #fragment, which the browser never sends to a server. The page must be on an origin
// in the gateway's allowed_origins (http://localhost:5199 in the example targets) for the CORS preflight.
const params = new URLSearchParams(location.search)
export const gateway = (params.get('gateway') || '').replace(/\/$/, '')
export const service = params.get('service') || 'ais-demo'
export const serviceUrl = `${gateway}/ogc/${service}`
const token = () => window.GLL_TOKEN || new URLSearchParams(location.hash.slice(1)).get('token') || ''

// Every page of an OGC API – Features items response (following rel=next), as one FeatureCollection
export async function items (collection, query = '', onProgress) {
  let url = `${serviceUrl}/collections/${collection}/items?f=json&limit=4000${query ? `&${query}` : ''}`
  const features = []
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) throw new Error(`${collection}: HTTP ${res.status}`)
    const page = await res.json()
    features.push(...page.features)
    onProgress?.(features.length)
    url = (page.links || []).find(l => l.rel === 'next')?.href
  }
  return { type: 'FeatureCollection', features }
}

// The caption card every page shows: title, a line about where the data came from, and a legend
export function caption ({ title, sub, legend = [] }) {
  const el = document.getElementById('caption')
  el.innerHTML = `<h1>${title}</h1><p>${sub}</p>` +
    (legend.length ? `<ul>${legend.map(([color, label]) => `<li><i style="background:${color}"></i>${label}</li>`).join('')}</ul>` : '') +
    `<p class="src">OGC API – Features · <code>${serviceUrl.replace(/^https:\/\//, '')}</code> · queried live as the signed-in user</p>`
}

export const status = text => { document.getElementById('status').textContent = text }
export const done = () => { status(''); window.GLL_DONE = true }

// Magma-like ramp for counts (dark purple → orange → pale yellow), by quantile breaks
export const RAMP = ['#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf']
export function breaks (values, n = RAMP.length) {
  const v = values.filter(x => x != null).sort((a, b) => a - b)
  return Array.from({ length: n - 1 }, (_, i) => v[Math.floor(((i + 1) / n) * (v.length - 1))])
}
export const colorFor = (x, cuts) => RAMP[cuts.findIndex(c => x <= c) === -1 ? RAMP.length - 1 : cuts.findIndex(c => x <= c)]

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

// Esri Dark Gray Canvas (no key needed for display; keep the attribution)
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
