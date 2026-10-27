/*
  edits.js — ArcGIS applyEdits for GeoLakeLayers (off unless EDITING=true)

  POST <layer>/applyEdits with adds / updates / deletes, the way the ArcGIS Maps SDK (Experience Builder's
  Edit widget, editable Table) sends them. Each edit is SQL on the Delta table, run as the editor, so Unity
  Catalog's MODIFY grant decides who can edit what.

  Editable tables: a real integer id column (a primary key or one an author picked; not a derived id) and
  not a map-optimized copy (its bounding box columns would go stale). Column names are checked against the table's own columns; values are SQL
  parameters, never part of the SQL text.
*/

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/

function webMercatorToWgs84 (x, y) {
  const lon = (x / 6378137) * (180 / Math.PI)
  const lat = (Math.atan(Math.exp(y / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI)
  return [lon, lat]
}

/** Esri JSON geometry -> WKT in EPSG:4326 (the gateway serves layers in 4326). */
function toWkt (g) {
  if (!g) return null
  const wkid = g.spatialReference?.latestWkid || g.spatialReference?.wkid || 4326
  const xy = ([x, y]) => {
    if (![x, y].every(Number.isFinite)) throw new Error('Geometry coordinates must be numbers')
    return wkid === 102100 || wkid === 3857 ? webMercatorToWgs84(x, y) : [x, y]
  }
  const ring = pts => pts.map(p => xy(p).join(' ')).join(', ')
  if (Number.isFinite(g.x) && Number.isFinite(g.y)) return `POINT (${xy([g.x, g.y]).join(' ')})`
  if (Array.isArray(g.points)) return `MULTIPOINT (${g.points.map(p => `(${xy(p).join(' ')})`).join(', ')})`
  if (Array.isArray(g.paths)) {
    return g.paths.length === 1 ? `LINESTRING (${ring(g.paths[0])})` : `MULTILINESTRING (${g.paths.map(p => `(${ring(p)})`).join(', ')})`
  }
  if (Array.isArray(g.rings)) return `POLYGON (${g.rings.map(r => `(${ring(r)})`).join(', ')})`
  throw new Error('Unsupported geometry')
}

function parseList (v) {
  if (v === undefined || v === null || v === '') return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('[')) return JSON.parse(t)
    return t.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

/** Value expression for one column, by its Databricks type; dates arrive as epoch milliseconds. */
function valueExpr (type, param) {
  const t = type.toLowerCase()
  if (t === 'timestamp' || t === 'timestamp_ntz') return `timestamp_millis(CAST(:${param} AS BIGINT))`
  if (t === 'date') return `CAST(timestamp_millis(CAST(:${param} AS BIGINT)) AS DATE)`
  return `CAST(:${param} AS ${t.toUpperCase()})`
}

/**
 * Build the SQL for one table's edits. columns: [{ name, type }] from DESCRIBE. Returns a list of
 * { kind, id?, sql, params } to run in order.
 */
function planEdits ({ table, spec, columns, adds, updates, deletes }) {
  const byName = new Map(columns.map(c => [c.name.toLowerCase(), c]))
  const id = spec.objectId
  const helpers = new Set(['_xmin', '_ymin', '_xmax', '_ymax'])
  const geomCol = spec.geometryColumn
  const lonLat = !geomCol && /^ST_Point\((\w+), (\w+), 4326\)$/.exec(spec.geometryExpr || '')

  // Geometry assignment in the table's own storage: native GEOMETRY/GEOGRAPHY, WKT, GeoJSON or WKB in a
  // text/binary column, or lon/lat columns
  const geometryAssignments = (wkt, params) => {
    if (!wkt) return []
    params.g = wkt
    if (lonLat) {
      return [[lonLat[1], 'ST_X(ST_GeomFromText(:g, 4326))'], [lonLat[2], 'ST_Y(ST_GeomFromText(:g, 4326))']]
    }
    const type = byName.get(geomCol.toLowerCase())?.type || ''
    if (type.startsWith('geometry')) return [[geomCol, 'ST_GeomFromText(:g, 4326)']]
    if (type.startsWith('geography')) return [[geomCol, 'ST_GeogFromText(:g)']]
    if (spec.geometryStorage === 'wkb' || type === 'binary') return [[geomCol, 'ST_AsBinary(ST_GeomFromText(:g, 4326))']]
    if (spec.geometryStorage === 'geojson') return [[geomCol, 'ST_AsGeoJSON(ST_GeomFromText(:g, 4326))']]
    return [[geomCol, ':g']]
  }

  // Attribute assignments: only real, plain-named, non-id, non-geometry columns
  const attributeAssignments = (attributes, params) => {
    const out = []
    let n = 0
    for (const [name, value] of Object.entries(attributes || {})) {
      const col = byName.get(name.toLowerCase())
      if (!col || !PLAIN.test(col.name) || col.name === id || col.name === geomCol || helpers.has(col.name)) continue
      // Nested and binary columns are shown as JSON text and aren't editable
      if (/^(struct|array|map|binary|geometry|geography|variant)/.test(col.type.toLowerCase())) continue
      if (lonLat && (col.name === lonLat[1] || col.name === lonLat[2])) continue
      const p = `a${n++}`
      if (value === null || value === undefined) {
        out.push([col.name, 'NULL'])
      } else {
        params[p] = typeof value === 'object' ? JSON.stringify(value) : String(value)
        out.push([col.name, valueExpr(col.type, p)])
      }
    }
    return out
  }

  const plan = []
  for (const f of adds) {
    const params = {}
    const sets = [...attributeAssignments(f.attributes, params), ...geometryAssignments(toWkt(f.geometry), params)]
    // New id: next after the current maximum, read just before the insert (fine for the light,
    // interactive editing this is for; concurrent adds to one table could collide)
    const cols = [id, ...sets.map(s => s[0])]
    const vals = ['CAST(:newid AS BIGINT)', ...sets.map(s => s[1])]
    plan.push({ kind: 'add', nextIdSql: `SELECT COALESCE(MAX(${id}), 0) + 1 AS n FROM ${table}`, sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})`, params })
  }
  for (const f of updates) {
    const oid = Number(f.attributes?.[id] ?? f.attributes?.[id.toLowerCase()])
    if (!Number.isSafeInteger(oid)) { plan.push({ kind: 'update', id: null, error: `Update without a valid ${id}` }); continue }
    const params = { oid }
    const sets = [...attributeAssignments(f.attributes, params), ...geometryAssignments(f.geometry ? toWkt(f.geometry) : null, params)]
    if (!sets.length) { plan.push({ kind: 'update', id: oid, sql: null, params }); continue }
    plan.push({ kind: 'update', id: oid, sql: `UPDATE ${table} SET ${sets.map(([c, v]) => `${c} = ${v}`).join(', ')} WHERE ${id} = :oid`, params })
  }
  for (const d of deletes) {
    const oid = Number(d)
    if (!Number.isSafeInteger(oid)) { plan.push({ kind: 'delete', id: null, error: 'Delete without a valid id' }); continue }
    plan.push({ kind: 'delete', id: oid, sql: `DELETE FROM ${table} WHERE ${id} = :oid`, params: { oid } })
  }
  return plan
}

/** Is this table editable through the gateway at all (before Unity Catalog has its say)? */
function editableSpec (spec) {
  return !!spec && !spec.objectIdExpr && !spec.bboxColumns && !!spec.objectId
}

/**
 * Run planned edits one by one and report each, the way applyEdits answers (no rollback: each statement
 * commits on its own). run(sql, params) runs as the editor; explain turns errors into { status, message }.
 * Once an edit is refused for permissions or sign-in, the rest would be too, so they aren't run.
 */
async function applyPlan (plan, run, explain) {
  const results = { addResults: [], updateResults: [], deleteResults: [] }
  let changed = false
  let refused = null
  for (const step of plan) {
    const out = { objectId: step.id ?? null, success: false }
    try {
      if (refused) throw refused
      if (step.error) throw Object.assign(new Error(step.error), { status: 400 })
      if (step.kind === 'add') {
        const next = await run(step.nextIdSql)
        out.objectId = Number(next[0]?.n)
        await run(step.sql, { ...step.params, newid: out.objectId })
      } else if (step.sql) {
        await run(step.sql, step.params)
      }
      out.success = true
      changed = true
    } catch (err) {
      const e = explain(err)
      if (e.status === 403 || e.status === 401) refused = e
      out.error = { code: e.status, description: e.message }
    }
    results[`${step.kind}Results`].push(out)
  }
  return { results, changed }
}

module.exports = { toWkt, parseList, planEdits, editableSpec, applyPlan }
