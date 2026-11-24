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

// The caption card every page shows: title, a line about where the data came from, a legend, and the identify hint
export function caption ({ title, sub, legend = [], client, hint = 'Click a feature for its attributes.' }) {
  const el = document.getElementById('caption')
  el.innerHTML = `<h1>${title}</h1><p>${sub}</p>` +
    (legend.length ? `<ul>${legend.map(([color, label]) => `<li><i style="background:${color}"></i>${label}</li>`).join('')}</ul>` : '') +
    (hint ? `<p class="gll-hint">${hint}</p>` : '') +
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

// Links shown on every page: back to the console's OGC tab and to the other demos, and the basemap switch
// (it reloads the page with ?basemap=, which the demo links carry along)
export function nav () {
  const el = document.createElement('nav')
  el.id = 'demo-nav'
  const keep = new URLSearchParams()
  if (service !== 'ais-demo') keep.set('service', service)
  if (basemapKey !== 'open') keep.set('basemap', basemapKey)
  const q = keep.toString() ? `?${keep}` : ''
  const swap = Object.entries(BASEMAPS).map(([key, b]) => {
    const u = new URL(location.href)
    if (key === 'open') u.searchParams.delete('basemap'); else u.searchParams.set('basemap', key)
    return key === basemapKey ? `<b aria-current="true">${b.label}</b>` : `<a href="${u.pathname}${u.search}">${b.label}</a>`
  }).join('')
  el.innerHTML = `<span class="basemap" title="Basemap tiles: open and keyless, or Esri's">Basemap ${swap}</span><a href="./${q}">All demos</a><a href="/#ogc">Open in console</a>`
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

// ---- Basemaps: open and keyless by default, Esri's with ?basemap=esri ----
// Tiles load in the viewer's browser, never through the gateway, and none of these needs a key or an account.
//   open  dark     OpenFreeMap "Dark": OpenStreetMap data in the OpenMapTiles schema, vector tiles with a MapLibre
//                  style. No key, no registration, commercial use allowed; MapLibre shows the required attribution.
//         imagery  USGS National Map imagery: public domain, U.S. only.
//   esri  dark     Esri Dark Gray Canvas; imagery: Esri World Imagery. No key needed for display; keep the attribution.
const ESRI_DARK = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
export const BASEMAPS = {
  open: {
    label: 'Open',
    dark: { style: 'https://tiles.openfreemap.org/styles/dark' },
    imagery: {
      tiles: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>',
      maxZoom: 16
    }
  },
  esri: {
    label: 'Esri',
    dark: { tiles: ESRI_DARK, attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors', maxZoom: 16 },
    imagery: {
      tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      maxZoom: 19
    }
  }
}
export const basemapKey = params.get('basemap') === 'esri' ? 'esri' : 'open'
export const basemap = BASEMAPS[basemapKey]

// A MapLibre style for the dark basemap: the open one is a hosted style URL, the Esri one a raster source
export function maplibreDarkStyle () {
  const b = basemap.dark
  return b.style || { version: 8, sources: { dark: { type: 'raster', tileSize: 256, attribution: b.attribution, tiles: [b.tiles], maxzoom: b.maxZoom } }, layers: [{ id: 'dark', type: 'raster', source: 'dark' }] }
}

// The id of the first symbol (label) layer, so data can go under the basemap's place names; undefined: on top
export const firstLabelLayer = map => map.getStyle().layers.find(l => l.type === 'symbol')?.id

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

// ---- Identify: click a feature, see its attributes ----
// Every page shows the same card: a title line per collection, then the feature's fields as the OGC API
// returned them, and a link to that one feature's JSON (/items/<id>), which is the OGC API – Features request
// a script or QGIS would make for it.
const HIDDEN = new Set(['objectid', 'bigid', 'h3_cell', 'h3_r7', 'h3_r9', 'geometry'])
const LABELS = {
  mmsi: 'MMSI', imo: 'IMO', sog: 'Speed (kn)', cog: 'Course (°)', heading: 'Heading (°)', avg_sog: 'Avg speed (kn)',
  max_sog: 'Max speed (kn)', ping_count: 'AIS pings', vessel_count: 'Vessels', point_count: 'Positions',
  h3_cell_hex: 'H3 cell', h3_r7_hex: 'H3 r7', h3_r9_hex: 'H3 r9', base_datetime: 'Reported', event_date: 'Day',
  start_time: 'First position', end_time: 'Last position', vessel_name: 'Vessel', call_sign: 'Call sign',
  vessel_type: 'Vessel type', transceiver_class: 'Transceiver', length: 'Length (m)', width: 'Width (m)',
  draft: 'Draft (m)', status: 'Nav status', cargo: 'Cargo code', lat: 'Latitude', lon: 'Longitude'
}
// AIS navigational status codes (ITU-R M.1371)
const NAV_STATUS = ['Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught',
  'Moored', 'Aground', 'Engaged in fishing', 'Under way sailing']
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const IDS = new Set(['mmsi', 'imo', 'cargo', 'h3_cell_hex', 'h3_r7_hex', 'h3_r9_hex']) // identifiers: no digit grouping
function fmt (key, v) {
  if (v == null || v === '') return '—'
  if (IDS.has(key)) return String(v)
  if (key === 'lat' || key === 'lon') return Number(v).toFixed(5)
  if (key === 'status' && NAV_STATUS[v] != null) return `${v} · ${NAV_STATUS[v]}`
  if (key === 'vessel_type') return `${v} · ${vesselGroup(v)[0]}`
  if (key === 'event_date') return new Date(v).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })
  if (typeof v === 'string' && ISO.test(v)) return new Date(v).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' UTC'
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (typeof v === 'object') return '—'
  return String(v)
}
const label = key => LABELS[key] || key.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())

// What the title line says, per collection
const TITLES = {
  hex_r7: p => [`H3 cell ${p.h3_cell_hex || ''}`.trim(), `${fmt('ping_count', p.ping_count)} AIS pings from ${fmt('vessel_count', p.vessel_count)} vessel${p.vessel_count === 1 ? '' : 's'}`],
  tracks: p => [p.vessel_name || `MMSI ${p.mmsi}`, `${vesselGroup(p.vessel_type)[0]} · MMSI ${p.mmsi} · ${fmt('point_count', p.point_count)} positions`],
  points: p => [p.vessel_name || `MMSI ${p.mmsi}`, `${vesselGroup(p.vessel_type)[0]} · MMSI ${p.mmsi} · ${fmt('sog', p.sog)} kn`]
}
export function popupHtml (collection, props) {
  const [title, sub] = (TITLES[collection] || (() => [collection, '']))(props)
  const rows = Object.entries(props).filter(([k, v]) => !HIDDEN.has(k) && (v === null || typeof v !== 'object'))
    .map(([k, v]) => `<tr><th>${esc(label(k))}</th><td>${esc(fmt(k, v))}</td></tr>`).join('')
  const id = props.objectid
  const link = id != null ? `<a href="${serviceUrl}/collections/${encodeURIComponent(collection)}/items/${encodeURIComponent(id)}?f=json" target="_blank" rel="noopener">Feature JSON ↗</a> · ` : ''
  return `<div class="gll-popup"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}<table>${rows}</table>` +
    `<p class="src">${link}<code>${esc(collection)}</code> · queried as you</p></div>`
}
