/*
  server.js — Databricks feature gateway for ArcGIS Experience Builder

  One process serves:
    /databricks/rest/services/<catalog.schema.table>/FeatureServer/0   any UC table as an ArcGIS layer (Koop)
    /api/catalog        tables the caller can see that the gateway can serve (geometry + integer id)
    /api/whoami         who the Databricks front door says is calling
    /auth/handoff       popup page that hands the signed-in user's token to an allowed origin
    /                   static test page

  Every request has already been authenticated by the Databricks Apps front door. Queries run as the
  calling user (forwarded token, app user_api_scopes ["sql"]); set USE_OBO=false to run as the app.
  CORS is limited to ALLOWED_ORIGINS (comma-separated) instead of Koop's default "*".
*/

const path = require('path')
const express = require('express')
const cors = require('cors')
const Koop = require('@koopjs/koop-core')

const provider = require('./provider')
const Model = require('./provider/model')
const connectionManager = require('./provider/connection')
const layerSpec = require('./provider/spec')

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
const catalogs = (process.env.CATALOGS || 'main').split(',').map(s => s.trim()).filter(Boolean)

const koop = new Koop({ logLevel: process.env.LOG_LEVEL || 'info', disableCors: true })
const app = koop.server

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
  methods: ['GET', 'POST'],
  allowedHeaders: ['authorization', 'content-type'],
  maxAge: 600
}))

koop.register(provider)

app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.get('/api/whoami', (req, res) => {
  res.json({ user: req.headers['x-forwarded-email'] || null, origin: req.headers.origin || null })
})

// Forwarded user token, so queries run with the caller's Unity Catalog permissions
const obo = req => (process.env.USE_OBO !== 'false' && req.headers['x-forwarded-access-token']) || null

const ID_NAMES = "'objectid','oid','fid','bigid','id','object_id'"
const WKT_NAMES = "'geometry_wkt','geom_wkt','wkt','shape_wkt','geometry','geom','shape'"
const LAT_NAMES = "'latitude','lat','y'"
const LON_NAMES = "'longitude','lon','lng','long','x'"

const catalogCache = new Map() // user (or 'app') -> { tables, at }
const CATALOG_TTL_MS = 300000

// Tables with an integer id and some geometry source, using the same rules as spec.js
async function listTables (req) {
  const userToken = obo(req)
  const key = req.headers['x-forwarded-email'] || (userToken ? 'user' : 'app')
  const hit = catalogCache.get(key)
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.tables
  const inList = catalogs.map(c => `'${c.replace(/'/g, '')}'`).join(',')
  const sql = `
    WITH c AS (
      SELECT table_catalog cat, table_schema sch, table_name tbl, lower(column_name) col, lower(data_type) dt
      FROM system.information_schema.columns
      WHERE table_catalog IN (${inList}) AND table_schema <> 'information_schema'
        AND table_name NOT LIKE '\\_\\_%'
    )
    SELECT cat, sch, tbl,
      max(CASE WHEN dt LIKE 'geometry%' OR dt LIKE 'geography%' THEN col END) AS native_col,
      max(CASE WHEN col IN (${WKT_NAMES}) AND dt = 'string' THEN col END) AS wkt_col,
      max(CASE WHEN col IN (${LAT_NAMES}) AND dt IN ('double','float') THEN 1 ELSE 0 END) AS has_lat,
      max(CASE WHEN col IN (${LON_NAMES}) AND dt IN ('double','float') THEN 1 ELSE 0 END) AS has_lon,
      max(CASE WHEN col IN (${ID_NAMES}) AND dt IN ('tinyint','smallint','int','bigint') THEN col END) AS id_col
    FROM c GROUP BY cat, sch, tbl
    ORDER BY cat, sch, tbl`
  const session = await connectionManager.getSession(userToken)
  let rows
  try {
    const op = await session.executeStatement(sql, { queryTimeout: 60 })
    rows = await op.fetchAll()
    await op.close()
  } finally {
    await session.close()
  }
  const tables = rows
    .filter(r => r.id_col && (r.native_col || r.wkt_col || (r.has_lat && r.has_lon)))
    .map(r => ({
      table: `${r.cat}.${r.sch}.${r.tbl}`,
      catalog: r.cat,
      schema: r.sch,
      name: r.tbl,
      idField: r.id_col,
      geometry: r.native_col || r.wkt_col || 'lon/lat'
    }))
  catalogCache.set(key, { tables, at: Date.now() })
  return tables
}

app.get('/api/catalog', async (req, res) => {
  try {
    res.json({ catalogs, runAs: obo(req) ? 'user' : 'app', tables: await listTables(req) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Spec the gateway resolved for one table (geometry source, id, geometry type)
app.get('/api/spec/:table', async (req, res) => {
  const table = req.params.table
  if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){2}$/.test(table)) return res.status(400).json({ error: 'catalog.schema.table expected' })
  const session = await connectionManager.getSession(obo(req))
  try {
    const spec = await layerSpec.resolveSpec(table, async (sql) => {
      const op = await session.executeStatement(sql, { queryTimeout: 60 })
      const rows = await op.fetchAll()
      await op.close()
      return rows
    })
    res.json({ table, spec, url: `/databricks/rest/services/${table}/FeatureServer/0` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    await session.close()
  }
})

app.get('/api/querylog', (req, res) => {
  res.json({ queries: Model.recentQueries.slice().reverse() })
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
  const payload = JSON.stringify({ type: 'databricks-gateway-token', token, user: req.headers['x-forwarded-email'] || null })
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<p style="font:14px system-ui">Signed in to Databricks. You can close this window.</p>
<script>
  if (window.opener) { window.opener.postMessage(${payload}, ${JSON.stringify(origin)}); window.close() }
</script>`)
})

const port = process.env.DATABRICKS_APP_PORT || process.env.PORT || 8080
app.listen(port, '0.0.0.0', () => {
  console.log(`Databricks feature gateway listening on :${port}; origins=${allowedOrigins.join(' ') || '(none)'}; catalogs=${catalogs.join(',')}`)
})
