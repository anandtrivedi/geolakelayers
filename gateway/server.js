/*
  server.js — Databricks feature gateway for ArcGIS Experience Builder

  One process serves:
    /databricks/rest/services/<catalog.schema.table>/FeatureServer/0   any UC table as an ArcGIS layer (Koop)
    /api/catalog        tables the caller can see that the gateway can serve (geometry + integer id)
    /api/whoami         who the Databricks front door says is calling
    /api/spec/<table>   geometry/id the gateway resolved for a table
    /api/catalogs       catalogs the caller can see (widget settings)
    /api/warehouses     allow-listed warehouses the caller can use (widget settings)
    /auth/handoff       popup page that hands the signed-in user's token to an allowed origin
    /                   static test page

  Every request has already been authenticated by the Databricks Apps front door. A request may name a
  warehouse (X-Databricks-Warehouse); only ALLOWED_WAREHOUSES (plus the bound one) are accepted. Queries run as the
  calling user (forwarded token, app user_api_scopes ["sql"]); set USE_OBO=false to run as the app.
  CORS is limited to ALLOWED_ORIGINS (comma-separated) instead of Koop's default "*".
*/

const path = require('path')
const express = require('express')
const crypto = require('crypto')
const cors = require('cors')
const Koop = require('@koopjs/koop-core')

const provider = require('./provider')
const connectionManager = require('./provider/connection')
const layerSpec = require('./provider/spec')

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
// Comma-separated setting; '-' means none (Databricks Apps refuses empty env values)
const list = v => (v || '').split(',').map(s => s.trim()).filter(s => s && s !== '-')
// Catalogs to list: empty means every catalog the signed-in user can see, minus the excluded ones
const catalogs = list(process.env.CATALOGS)
const excludeCatalogs = list(process.env.EXCLUDE_CATALOGS === undefined ? 'system,samples,hive_metastore,__databricks_internal' : process.env.EXCLUDE_CATALOGS)
const catalogScope = catalogs.length ? catalogs.join(', ') : 'all catalogs you can see'

const koop = new Koop({ logLevel: process.env.LOG_LEVEL || 'info', disableCors: true })
const app = koop.server

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST'],
  allowedHeaders: ['authorization', 'content-type', 'x-databricks-warehouse'],
  maxAge: 600
}))

// Warehouses apps may use. The widget picks one per request (X-Databricks-Warehouse); anything not on
// this list is refused, so a page can't move queries onto a bigger warehouse. Default: the bound one.
const defaultWarehouse = process.env.DATABRICKS_WAREHOUSE_ID || ''
const allowedWarehouses = list(process.env.ALLOWED_WAREHOUSES).concat(defaultWarehouse ? [defaultWarehouse] : [])
  .filter((v, i, a) => a.indexOf(v) === i)

app.use((req, res, next) => {
  const requested = String(req.headers['x-databricks-warehouse'] || '').trim()
  if (!requested) return next()
  if (!/^[a-f0-9]{8,32}$/i.test(requested) || !allowedWarehouses.includes(requested)) {
    return res.status(403).json({ error: { code: 403, message: `Warehouse ${requested.slice(0, 32)} is not allowed on this gateway` } })
  }
  req.warehouseId = requested
  next()
})

koop.register(provider)

app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Landing page: who the front door says you are, and what the gateway can serve for you
app.get('/', async (req, res) => {
  const user = req.headers['x-forwarded-email'] || 'unknown'
  let tables = []
  let catalogNames = null
  let error = null
  try {
    // Without a scope, list catalogs instead of scanning the whole metastore's columns
    if (requestedCatalogs(req).length) tables = await listTables(req)
    else catalogNames = (await runSql(req, 'SHOW CATALOGS', 30)).map(r => r.catalog || Object.values(r)[0]).filter(c => c && !excludeCatalogs.includes(c))
  } catch (err) {
    error = err.message
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const rows = tables.slice(0, 500).map(t => {
    const url = `/databricks/rest/services/${t.table}/FeatureServer/0`
    return `<tr><td>${esc(t.table)}</td><td>${esc(t.idField)}</td><td>${esc(t.geometry)}</td><td><a href="${esc(url)}?f=json">layer</a> · <a href="${esc(url)}/query?where=1%3D1&outFields=*&resultRecordCount=5&f=json">5 rows</a></td></tr>`
  }).join('')
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Databricks feature gateway</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1b3139}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #e5e5e5;text-align:left}th{background:#f5f5f5}code{background:#f5f5f5;padding:1px 4px}</style>
<h2>Databricks feature gateway</h2>
<p>Signed in as <b>${esc(user)}</b>. Queries run with your Unity Catalog permissions.</p>
<p>Serves Unity Catalog tables as ArcGIS FeatureServer layers for the Experience Builder <i>Databricks Data</i> widget:
<code>/databricks/rest/services/&lt;catalog.schema.table&gt;/FeatureServer/0</code></p>
<p>Browser origins allowed to call it: ${allowedOrigins.map(o => `<code>${esc(o)}</code>`).join(' ') || 'none'}</p>
${error ? `<p style="color:#b00">Catalog failed: ${esc(error)}</p>`
  : catalogNames ? `<h3>${catalogNames.length} catalogs you can see</h3><p>Pick one to list its map-ready tables:</p>
<ul>${catalogNames.map(c => `<li><a href="?catalogs=${encodeURIComponent(c)}">${esc(c)}</a></li>`).join('')}</ul>`
  : `<h3>${tables.length} tables in ${esc(requestedCatalogs(req).join(', '))}</h3>
<table><tr><th>Table</th><th>Object id</th><th>Geometry</th><th></th></tr>${rows}</table>`}`)
})

app.get('/api/whoami', (req, res) => {
  res.json({ user: req.headers['x-forwarded-email'] || null, origin: req.headers.origin || null })
})

// Forwarded user token, so queries run with the caller's Unity Catalog permissions
const obo = req => (process.env.USE_OBO !== 'false' && req.headers['x-forwarded-access-token']) || null

async function runSql (req, sql, timeout = 60) {
  const session = await connectionManager.getSession(obo(req), req.warehouseId)
  try {
    const op = await session.executeStatement(sql, { queryTimeout: timeout })
    const rows = await op.fetchAll()
    await op.close()
    return rows
  } finally {
    await session.close()
  }
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/

// Catalog scope for one request: the widget's choice (?catalogs=a,b), limited to the gateway's own
// CATALOGS cap when one is set. Names must be plain identifiers.
function requestedCatalogs (req) {
  const asked = list(req.query.catalogs).filter(c => PLAIN.test(c))
  if (!catalogs.length) return asked
  return asked.length ? asked.filter(c => catalogs.includes(c)) : catalogs
}

const ID_NAMES = "'objectid','oid','fid','bigid','id','object_id'"
const STRING_ID_NAMES = "'id','gers_id','uuid','guid','globalid','feature_id','fid','objectid'"
const WKT_NAMES = "'geometry_wkt','geom_wkt','wkt','shape_wkt','geometry','geom','shape'"
const LAT_NAMES = "'latitude','lat','y'"
const LON_NAMES = "'longitude','lon','lng','long','x'"

const catalogCache = new Map() // sha256(user token) or 'app' -> { tables, at }
const CATALOG_TTL_MS = 300000

// Tables with an integer id and some geometry source, using the same rules as spec.js
async function listTables (req) {
  const userToken = obo(req)
  const scoped = requestedCatalogs(req)
  // Asked for catalogs but none were valid/allowed: nothing to list (don't fall back to everything)
  if (req.query.catalogs && !scoped.length) return []
  const key = [userToken ? crypto.createHash('sha256').update(userToken).digest('hex') : 'app', req.warehouseId || '', scoped.join(',')].join('|')
  const hit = catalogCache.get(key)
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.tables
  for (const [k, v] of catalogCache) if (Date.now() - v.at >= CATALOG_TTL_MS) catalogCache.delete(k)
  const quote = names => names.map(c => `'${c.replace(/'/g, '')}'`).join(',')
  const scope = [
    scoped.length ? `table_catalog IN (${quote(scoped)})` : null,
    excludeCatalogs.length ? `table_catalog NOT IN (${quote(excludeCatalogs)})` : null
  ].filter(Boolean).join(' AND ') || 'TRUE'
  // Only the columns that can matter (geometry types or the known id/geometry/lat/lon names), so a
  // metastore-wide scan stays small
  const sql = `
    WITH c AS (
      SELECT table_catalog cat, table_schema sch, table_name tbl, lower(column_name) col, lower(data_type) dt
      FROM system.information_schema.columns
      WHERE ${scope} AND table_schema <> 'information_schema'
        AND table_name NOT LIKE '\\_\\_%'
        AND (lower(data_type) LIKE 'geometry%' OR lower(data_type) LIKE 'geography%'
          OR lower(column_name) IN (${ID_NAMES}, ${STRING_ID_NAMES}, ${WKT_NAMES}, ${LAT_NAMES}, ${LON_NAMES}))
    )
    SELECT cat, sch, tbl,
      max(CASE WHEN (dt LIKE 'geometry%' OR dt LIKE 'geography%') AND col RLIKE '^[a-z_][a-z0-9_]*$' THEN col END) AS native_col,
      max(CASE WHEN col IN (${WKT_NAMES}) AND dt = 'string' THEN col END) AS wkt_col,
      max(CASE WHEN col IN (${LAT_NAMES}) AND dt IN ('double','float') THEN 1 ELSE 0 END) AS has_lat,
      max(CASE WHEN col IN (${LON_NAMES}) AND dt IN ('double','float') THEN 1 ELSE 0 END) AS has_lon,
      max(CASE WHEN col IN (${ID_NAMES}) AND dt IN ('tinyint','smallint','int','bigint') THEN col END) AS id_col,
      max(CASE WHEN col IN (${STRING_ID_NAMES}) AND dt = 'string' THEN col END) AS sid_col
    FROM c GROUP BY cat, sch, tbl
    ORDER BY cat, sch, tbl`
  const rows = await runSql(req, sql)
  const tables = rows
    .filter(r => (r.id_col || r.sid_col) && (r.native_col || r.wkt_col || (r.has_lat && r.has_lon)))
    .map(r => ({
      table: `${r.cat}.${r.sch}.${r.tbl}`,
      catalog: r.cat,
      schema: r.sch,
      name: r.tbl,
      idField: r.id_col || `${r.sid_col} (hashed)`,
      geometry: r.native_col || r.wkt_col || 'lon/lat'
    }))
  catalogCache.set(key, { tables, at: Date.now() })
  return tables
}

app.get('/api/catalog', async (req, res) => {
  try {
    res.json({ catalogs: requestedCatalogs(req), excludeCatalogs, runAs: obo(req) ? 'user' : 'app', tables: await listTables(req) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Spec the gateway resolved for one table (geometry source, id, geometry type)
app.get('/api/spec/:table', async (req, res) => {
  const table = req.params.table
  if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){2}$/.test(table)) return res.status(400).json({ error: 'catalog.schema.table expected' })
  try {
    const spec = await layerSpec.resolveSpec(table, sql => runSql(req, sql))
    res.json({ table, spec, url: `/databricks/rest/services/${table}/FeatureServer/0` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Catalogs the caller can see (for the widget's settings), minus the excluded ones
app.get('/api/catalogs', async (req, res) => {
  try {
    const rows = await runSql(req, 'SHOW CATALOGS', 30)
    const names = rows.map(r => r.catalog || Object.values(r)[0]).filter(c => c && !excludeCatalogs.includes(c))
    res.json({ catalogs: catalogs.length ? names.filter(c => catalogs.includes(c)) : names })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Allowed warehouses the caller can use (for the widget's settings). Listed with the caller's own token,
// so a warehouse they have no access to doesn't appear.
app.get('/api/warehouses', async (req, res) => {
  const token = obo(req)
  const host = (process.env.DATABRICKS_HOST || process.env.DATABRICKS_SERVER_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!token || !host) return res.status(400).json({ error: 'No user token or workspace host' })
  try {
    const r = await fetch(`https://${host}/api/2.0/sql/warehouses`, { headers: { Authorization: `Bearer ${token}` } })
    const d = await r.json()
    if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`)
    const warehouses = (d.warehouses || [])
      .filter(w => allowedWarehouses.includes(w.id))
      .map(w => ({ id: w.id, name: w.name, state: w.state, size: w.cluster_size, serverless: !!w.enable_serverless_compute }))
    res.json({ default: defaultWarehouse || null, warehouses })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Popup handoff: the user signs in to the gateway in a popup (first-party, so the
// Databricks login works), and this page posts their token back to the opener.
// It only ever posts to an origin on the allow-list.
app.get('/auth/handoff', (req, res) => {
  const origin = String(req.query.origin || '')
  res.set('Cache-Control', 'no-store')
  res.set('X-Frame-Options', 'DENY')
  if (!allowedOrigins.includes(origin)) {
    return res.status(403).send('Origin not allowed. Add it to ALLOWED_ORIGINS on the gateway.')
  }
  const token = req.headers['x-forwarded-access-token']
  if (!token) {
    return res.status(500).send('No user token forwarded. Enable user authorization (user_api_scopes) on this app.')
  }
  // Escaped for an inline <script>: no '</script>' or line-separator breakouts from any field
  const payload = JSON.stringify({ type: 'databricks-gateway-token', token, user: req.headers['x-forwarded-email'] || null })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<p style="font:14px system-ui">Signed in to Databricks. You can close this window.</p>
<script>
  if (window.opener) { window.opener.postMessage(${payload}, ${JSON.stringify(origin)}); window.close() }
</script>`)
})

const port = process.env.DATABRICKS_APP_PORT || process.env.PORT || 8080
app.listen(port, '0.0.0.0', () => {
  console.log(`Databricks feature gateway listening on :${port}; origins=${allowedOrigins.join(' ') || '(none)'}; catalogs=${catalogScope}; warehouses=${allowedWarehouses.join(',') || '(none)'}`)
})
