/*
  server.js — Databricks feature gateway for ArcGIS Experience Builder

  One process serves:
    /databricks/rest/services/<catalog.schema.table>/FeatureServer/0   any UC table as an ArcGIS layer (Koop)
    /api/catalog        tables the caller can see that the gateway can serve (geometry + integer id)
    /api/whoami         who the Databricks front door says is calling
    /api/spec/<table>   geometry/id the gateway resolved for a table
    /api/catalogs       catalogs the caller can see (widget settings)
    /api/warehouses     allow-listed warehouses the caller can use (widget settings)
    /api/optimize       write a map-optimized copy of a table (console), job status at /api/optimize/<id>
    /auth/handoff       popup page that hands the signed-in user's token to an allowed origin
    /                   ArcGateway console (public/, built from console/)
    /api/info           gateway status and the workspace directory (console)
    /ogc/<service>/...  OGC API – Features (ogc/), services defined at /api/ogc (console)

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
const Model = require('./provider/model')
const connectionManager = require('./provider/connection')
const layerSpec = require('./provider/spec')
const { PLAIN, list, parseDirectory, requestedCatalogs: scopedCatalogs, obo, selfOrigin, consoleOnly } = require('./lib/http')

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
// Catalogs to list: empty means every catalog the signed-in user can see, minus the excluded ones
const catalogs = list(process.env.CATALOGS)
const excludeCatalogs = list(process.env.EXCLUDE_CATALOGS === undefined ? 'system,samples,hive_metastore,__databricks_internal' : process.env.EXCLUDE_CATALOGS)
const catalogScope = catalogs.length ? catalogs.join(', ') : 'all catalogs you can see'

const koop = new Koop({ logLevel: process.env.LOG_LEVEL || 'info', disableCors: true })
const app = koop.server

app.use('/api/optimize', consoleOnly('Optimize can only be started from the ArcGateway console'))
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST'],
  allowedHeaders: ['authorization', 'content-type', 'x-databricks-warehouse'],
  exposedHeaders: ['Content-Crs'],
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

// Editing: off unless EDITING=true (bundle variable `editing`). Apps turn it on per layer in the widget.
const editingEnabled = process.env.EDITING === 'true'
const edits = require('./edits')

app.post('/databricks/rest/services/:id/FeatureServer/:layer/applyEdits', async (req, res) => {
  const fail = (code, message) => res.status(code === 403 ? 403 : 200).json({ error: { code, message, details: [] } })
  if (!editingEnabled) return fail(403, 'Editing is turned off on this gateway')
  // Edits run as the caller, so only allow-listed apps (or the gateway's own pages) may send them. Browsers
  // always send Origin on cross-site POSTs, so a form post from another site is refused here. (The Apps
  // front door strips Authorization before the request reaches the app, so it can't be checked.)
  const self = `https://${req.headers['x-forwarded-host'] || req.headers.host}`
  const origin = req.headers.origin
  if (!origin || (origin !== self && !allowedOrigins.includes(origin))) return fail(403, 'Edits are accepted only from allow-listed apps')
  const table = req.params.id
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) return fail(400, 'catalog.schema.table expected')
  try {
    const who = layerSpec.whoOf(obo(req))
    const spec = await layerSpec.resolveSpec(table, sql => runSql(req, sql), who)
    if (!edits.editableSpec(spec)) return fail(400, `${table} can't be edited through the gateway (needs an integer id column; map-optimized copies are read-only)`)
    const columns = layerSpec.describeColumns(await runSql(req, `DESCRIBE ${table}`))
    const body = req.body || {}
    const plan = edits.planEdits({
      table, spec, columns,
      adds: edits.parseList(body.adds),
      updates: edits.parseList(body.updates),
      deletes: edits.parseList(body.deletes)
    })
    const results = { addResults: [], updateResults: [], deleteResults: [] }
    let changed = false
    for (const step of plan) {
      const out = { objectId: step.id ?? null, success: false }
      try {
        if (step.error) throw new Error(step.error)
        if (step.kind === 'add') {
          const next = await runSql(req, step.nextIdSql)
          out.objectId = Number(next[0]?.n)
          await runSql(req, step.sql, 120, { ...step.params, newid: out.objectId })
        } else if (step.sql) {
          await runSql(req, step.sql, 120, step.params)
        }
        out.success = true
        changed = true
      } catch (err) {
        out.error = { code: 500, description: err.message.split('\n')[0].slice(0, 300) }
      }
      results[`${step.kind}Results`].push(out)
    }
    // Make the next map refresh read the table again
    if (changed) Model.forgetTable(table)
    res.json(results)
  } catch (err) {
    fail(500, err.message.split('\n')[0].slice(0, 300))
  }
})

// OGC API – Features: named sets of tables defined in the console and kept in a Unity Catalog table
// (OGC_SERVICES_TABLE, '-' = off). Same caller token, warehouse allow-list and caches as the Esri layers.
const ogc = require('./ogc')
const ogcTable = list(process.env.OGC_SERVICES_TABLE)[0] || null
const ogcStore = ogcTable ? ogc.createStore({ table: ogcTable, run: (req, sql, params) => runSql(req, sql, 60, params), obo }) : null
const ogcDeps = {
  model: Model,
  store: ogcStore,
  obo,
  selfOrigin,
  defaultLimit: parseInt(process.env.OGC_DEFAULT_LIMIT) || 100,
  maxLimit: Math.min(parseInt(process.env.OGC_MAX_LIMIT) || Infinity, parseInt(process.env.MAX_ROWS) || 10000)
}
app.use('/ogc', ogc.ogcRouter(ogcDeps))
app.use('/api/ogc', consoleOnly('OGC services can only be changed from the ArcGateway console'), ogc.consoleApi(ogcDeps))

koop.register(provider)

app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Other ArcGateways (one per workspace), so authors can pick a workspace instead of pasting a URL.
// DIRECTORY = "name=url;name=url"
const directory = parseDirectory(process.env.DIRECTORY)
const { version } = require('./package.json')

// Everything the console needs to describe this gateway
app.get('/api/info', (req, res) => {
  const host = (process.env.DATABRICKS_HOST || process.env.DATABRICKS_SERVER_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  res.json({
    name: process.env.DATABRICKS_APP_NAME || 'arcgateway',
    version,
    user: req.headers['x-forwarded-email'] || null,
    workspaceHost: host || null,
    gatewayUrl: `https://${req.headers['x-forwarded-host'] || req.headers.host}`,
    runAs: obo(req) ? 'user' : 'app',
    defaultWarehouse: defaultWarehouse || null,
    allowedWarehouses,
    allowedOrigins,
    catalogCap: catalogs,
    excludeCatalogs,
    directory,
    editing: editingEnabled,
    ogc: { enabled: !!ogcStore, table: ogcTable }
  })
})

app.get('/api/whoami', (req, res) => {
  res.json({ user: req.headers['x-forwarded-email'] || null, origin: req.headers.origin || null })
})

async function runSql (req, sql, timeout = 60, namedParameters) {
  const session = await connectionManager.getSession(obo(req), req.warehouseId)
  try {
    const op = await session.executeStatement(sql, namedParameters ? { queryTimeout: timeout, namedParameters } : { queryTimeout: timeout })
    const rows = await op.fetchAll()
    await op.close()
    return rows
  } finally {
    await session.close()
  }
}

const requestedCatalogs = req => scopedCatalogs(req, catalogs)

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
    const spec = await layerSpec.resolveSpec(table, sql => runSql(req, sql), layerSpec.whoOf(obo(req)))
    res.json({ table, spec, url: `/databricks/rest/services/${table}/FeatureServer/0` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// "Optimize for maps": write a copy of a table with native GEOMETRY, per-row bounding-box columns and
// liquid clustering on them, so tile queries skip files instead of parsing every row. Runs as the caller
// (needs CREATE TABLE on the target schema) as a background job the console polls.
const optimizeJobs = new Map() // id -> { state, source, target, startedAt, finishedAt, rows, error }
app.post('/api/optimize', express.json(), async (req, res) => {
  // Writes a table as the caller, so only the console may ask (consoleOnly above: same-origin JSON)
  const { table, target } = req.body || {}
  const name = String((req.body || {}).name || '')
  const three = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/
  if (!three.test(table || '')) return res.status(400).json({ error: 'table must be catalog.schema.table' })
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(target || '')) return res.status(400).json({ error: 'target must be catalog.schema' })
  if (!PLAIN.test(name)) return res.status(400).json({ error: 'name must be a plain identifier' })
  let spec
  try {
    spec = await layerSpec.resolveSpec(table, sql => runSql(req, sql), layerSpec.whoOf(obo(req)))
    // Never replace a table ArcGateway didn't write: CREATE OR REPLACE on a name the author typed
    // could otherwise wipe an unrelated table
    const [cat, sch] = target.split('.')
    const existing = await runSql(req, `SHOW TABLES IN ${cat}.${sch} LIKE '${name}'`, 60)
    if (existing.length) {
      const props = await runSql(req, `SHOW TBLPROPERTIES ${target}.${name}`, 60)
      const ours = props.some(p => (p.key || Object.values(p)[0]) === 'arcgateway.optimized')
      if (!ours) return res.status(409).json({ error: `${target}.${name} already exists and was not written by ArcGateway; pick another name` })
    }
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
  if (!spec) return res.status(400).json({ error: `${table} has no usable geometry or id` })
  const geomExpr = { wkt: `ST_GeomFromText(${spec.geometryColumn}, 4326)`, wkb: `ST_GeomFromWKB(${spec.geometryColumn}, 4326)` }[spec.geometryFormat] ||
    (spec.geometryFormat === 'geometry' ? spec.geometryColumn : spec.geometryExpr)
  const out = `${target}.${name}`
  const except = spec.geometryColumn ? ` EXCEPT (${spec.geometryColumn})` : ''
  const sql = `
    CREATE OR REPLACE TABLE ${out}
    CLUSTER BY (_xmin, _ymin)
    COMMENT 'Map-optimized copy of ${table}, written by ArcGateway'
    TBLPROPERTIES ('arcgateway.optimized' = 'true', 'arcgateway.source' = '${table}')
    AS SELECT *, ST_XMin(geom) AS _xmin, ST_YMin(geom) AS _ymin, ST_XMax(geom) AS _xmax, ST_YMax(geom) AS _ymax
    FROM (SELECT *${except}, ${geomExpr} AS geom FROM ${spec.source || table}) AS src
    WHERE geom IS NOT NULL`
  const id = crypto.randomBytes(6).toString('hex')
  const job = { id, state: 'running', source: table, target: out, startedAt: Date.now() }
  optimizeJobs.set(id, { ...job, owner: layerSpec.whoOf(obo(req)), live: job })
  for (const [k, j] of optimizeJobs) if (Date.now() - j.live.startedAt > 24 * 3600 * 1000) optimizeJobs.delete(k)
  res.status(202).json(job)
  try {
    await runSql(req, sql, 3600)
    Model.forgetTable(out)
    const n = await runSql(req, `SELECT COUNT(*) AS n FROM ${out}`, 120)
    Object.assign(job, { state: 'done', finishedAt: Date.now(), rows: Number(n[0]?.n || 0) })
  } catch (err) {
    Object.assign(job, { state: 'failed', finishedAt: Date.now(), error: err.message })
  }
})

app.get('/api/optimize/:id', (req, res) => {
  const job = optimizeJobs.get(req.params.id)
  // Only the user who started a job can see it
  if (!job || job.owner !== layerSpec.whoOf(obo(req))) return res.status(404).json({ error: 'No such job' })
  res.json(job.live)
})

// Short per-user cache for the settings panel's lookups (catalog list, warehouses)
const lookupCache = new Map()
async function cached (req, name, ttlMs, fn) {
  const key = `${name}|${crypto.createHash('sha256').update(obo(req) || 'app').digest('hex')}|${req.warehouseId || ''}`
  const hit = lookupCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await fn()
  lookupCache.set(key, { value, at: Date.now() })
  if (lookupCache.size > 2000) lookupCache.delete(lookupCache.keys().next().value)
  return value
}

// Catalogs the caller can see (for the widget's settings), minus the excluded ones
app.get('/api/catalogs', async (req, res) => {
  try {
    const rows = await cached(req, 'catalogs', 5 * 60 * 1000, () => runSql(req, 'SHOW CATALOGS', 30))
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
    const d = await cached(req, 'warehouses', 60 * 1000, async () => {
      const r = await fetch(`https://${host}/api/2.0/sql/warehouses`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await r.json()
      if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`)
      return body
    })
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
  // The settings panel asks for the catalog list right after sign-in; start it now (SHOW CATALOGS is slow cold)
  cached(req, 'catalogs', 5 * 60 * 1000, () => runSql(req, 'SHOW CATALOGS', 30)).catch(() => {})
  // Escaped for an inline <script>: no '</script>' or line-separator breakouts from any field
  const payload = JSON.stringify({ type: 'databricks-gateway-token', token, user: req.headers['x-forwarded-email'] || null })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<p style="font:14px system-ui">Signed in to Databricks. You can close this window.</p>
<script>
  if (window.opener) { window.opener.postMessage(${payload}, ${JSON.stringify(origin)}); window.close() }
</script>`)
})

function start (port = process.env.DATABRICKS_APP_PORT || process.env.PORT || 8080) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Databricks feature gateway listening on :${server.address().port}; origins=${allowedOrigins.join(' ') || '(none)'}; catalogs=${catalogScope}; warehouses=${allowedWarehouses.join(',') || '(none)'}`)
  })
  // The Databricks Apps proxy keeps connections to the app open and reuses them. Node's default 5 s
  // keep-alive closes idle sockets first, so a request racing that close comes back as a 502 (seen as
  // bursts of failed map tiles). Keep sockets open longer than the proxy does.
  server.keepAliveTimeout = 65000
  server.headersTimeout = 66000
  return server
}

if (require.main === module) start()

module.exports = { app, start }

