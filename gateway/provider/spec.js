/*
  spec.js

  Per-table layer spec for the generic gateway. The upstream provider reads one
  geometry column / object id from config for every table; here each table is
  inspected once (DESCRIBE + one sample row) and the result is scoped to the
  request with AsyncLocalStorage, so model.js can keep its query builders.
*/

const { AsyncLocalStorage } = require('async_hooks')

const store = new AsyncLocalStorage()
const cache = new Map() // table -> { spec, at }
const TTL_MS = parseInt(process.env.SPEC_TTL_MS) || 600000

const ID_NAMES = ['objectid', 'oid', 'fid', 'bigid', 'id', 'object_id']
// String ids (Overture uses `id STRING`, GERS ids, UUIDs): an integer object id is derived from them
const STRING_ID_NAMES = ['id', 'gers_id', 'uuid', 'guid', 'globalid', 'feature_id', 'fid', 'objectid']
// Below 2^53 so ArcGIS JS holds it exactly. Collisions become likely past ~10^7 rows (birthday bound),
// so very large string-id tables are better served by a view with a real integer id.
const SYNTHETIC_ID_MODULUS = '9007199254740881'
const INT_TYPES = /^(tinyint|smallint|int|integer|bigint)$/
const WKT_NAMES = ['geometry_wkt', 'geom_wkt', 'wkt', 'shape_wkt', 'geometry', 'geom', 'shape']
const WKB_NAMES = ['geometry_wkb', 'geom_wkb', 'wkb', 'geometry', 'geom', 'shape']
const LAT_NAMES = ['latitude', 'lat', 'y']
const LON_NAMES = ['longitude', 'lon', 'lng', 'long', 'x']

const ESRI_TYPE = {
  point: 'esriGeometryPoint',
  multipoint: 'esriGeometryMultipoint',
  linestring: 'esriGeometryPolyline',
  multilinestring: 'esriGeometryPolyline',
  polygon: 'esriGeometryPolygon',
  multipolygon: 'esriGeometryPolygon'
}

// Columns of a DESCRIBE result, stopping at the metadata sections
function describeColumns (rows) {
  const cols = []
  for (const row of rows) {
    if (!row.col_name || row.col_name.startsWith('#')) break
    cols.push({ name: row.col_name, lname: row.col_name.toLowerCase(), type: String(row.data_type).toLowerCase() })
  }
  return cols
}

// Pick geometry source and object id from the column list. Returns null when the
// table has no usable geometry or no integer id (ArcGIS needs a stable OBJECTID).
// Column names end up in SQL unquoted, so only plain identifiers may be used as geometry or id columns.
// Unity Catalog allows almost anything in a backtick-quoted name; a crafted name would be SQL injection
// running with the caller's permissions.
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function detect (allCols) {
  const cols = allCols.filter(c => PLAIN_IDENTIFIER.test(c.name))
  const byName = (names, pred) => {
    for (const n of names) {
      const c = cols.find(c => c.lname === n && pred(c))
      if (c) return c
    }
    return null
  }

  let geom = null
  const nativeCol = cols.find(c => c.type.startsWith('geometry') || c.type.startsWith('geography'))
  if (nativeCol) {
    // GEOMETRY(4326) is used as-is; another SRID is reprojected; GEOMETRY(ANY)/GEOGRAPHY assumed lon/lat
    const srid = (nativeCol.type.match(/\((\d+)\)/) || [])[1]
    let expr = nativeCol.name
    if (nativeCol.type.startsWith('geography')) expr = `ST_GeomFromWKB(ST_AsBinary(${nativeCol.name}), 4326)`
    else if (!srid) expr = `ST_SetSRID(${nativeCol.name}, 4326)`
    else if (srid !== '4326') expr = `ST_Transform(${nativeCol.name}, 4326)`
    geom = { column: nativeCol.name, format: 'expr', expr, source: nativeCol.type }
  }
  if (!geom) {
    const c = byName(WKT_NAMES, c => c.type === 'string')
    if (c) geom = { column: c.name, format: 'wkt', source: 'wkt string' }
  }
  if (!geom) {
    const c = byName(WKB_NAMES, c => c.type === 'binary')
    if (c) geom = { column: c.name, format: 'wkb', source: 'wkb binary' }
  }
  if (!geom) {
    const num = c => /^(double|float|decimal)/.test(c.type)
    const lat = byName(LAT_NAMES, num)
    const lon = byName(LON_NAMES, num)
    if (lat && lon) {
      geom = { column: null, format: 'expr', expr: `ST_Point(${lon.name}, ${lat.name}, 4326)`, source: `${lon.name}/${lat.name}` }
    }
  }
  const id = byName(ID_NAMES, c => INT_TYPES.test(c.type))
  const stringId = id ? null : byName(STRING_ID_NAMES, c => c.type === 'string')
  if (!geom || (!id && !stringId)) return null
  const spec = { objectId: id ? id.name : null, geometryColumn: geom.column, geometryFormat: geom.format, geometryExpr: geom.expr, geometrySource: geom.source, spatialReference: 4326 }
  // Map-optimized tables (written by the console's "Optimize for maps") carry per-row bounding boxes;
  // filtering on them first lets Databricks skip files that can't intersect a tile
  const num = c => cols.some(x => x.lname === c && /^(double|float)/.test(x.type))
  if (['_xmin', '_ymin', '_xmax', '_ymax'].every(num)) spec.bboxColumns = true
  if (stringId) {
    // Expose the derived id under `objectid` (or `__objectid` if that name is taken) through a wrapped source
    const name = cols.some(c => c.lname === 'objectid') ? '__objectid' : 'objectid'
    spec.objectId = name
    spec.syntheticIdFrom = stringId.name
    spec.objectIdExpr = `CAST(pmod(xxhash64(${stringId.name}), ${SYNTHETIC_ID_MODULUS}) AS BIGINT)`
  }
  return spec
}

function sqlGeomExpr (spec) {
  switch (spec.geometryFormat) {
    case 'wkb': return `ST_GeomFromWKB(${spec.geometryColumn}, 4326)`
    case 'wkt': return `ST_GeomFromText(${spec.geometryColumn}, 4326)`
    default: return spec.geometryExpr
  }
}

// Inspect a table (cached). exec(sql, kind) -> rows
/** The FROM target for a table: the table itself, or a wrapper adding the derived object id. */
function sourceFor (table, spec) {
  if (!spec || !spec.objectIdExpr) return table
  return `(SELECT *, ${spec.objectIdExpr} AS ${spec.objectId} FROM ${table}) AS __src`
}

/** Cache scope for a caller: specs reveal column names, so they're cached per user, never shared. */
function whoOf (userToken) {
  return userToken ? require('crypto').createHash('sha256').update(userToken).digest('hex').slice(0, 32) : 'app'
}

/** Drop everything cached for a table (after it's replaced, e.g. by "Optimize for maps"). */
function forgetTable (table) {
  for (const k of cache.keys()) if (k.endsWith(`|${table}`)) cache.delete(k)
}

async function resolveSpec (table, exec, who = 'app') {
  const key = `${who}|${table}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.spec

  const cols = describeColumns(await exec(`DESCRIBE ${table}`, 'describe'))
  const spec = detect(cols)
  if (spec) {
    const expr = sqlGeomExpr(spec)
    const notNull = spec.geometryColumn ? `${spec.geometryColumn} IS NOT NULL` : 'TRUE'
    const rows = await exec(`SELECT lower(ST_GeometryType(${expr})) AS t FROM ${table} WHERE ${notNull} LIMIT 1`, 'geomtype')
    spec.source = sourceFor(table, spec)
    const t = rows[0] && String(rows[0].t || '').replace(/^st_/, '')
    spec.geometryType = ESRI_TYPE[t] || 'esriGeometryPoint'
  }
  cache.set(key, { spec, at: Date.now() })
  if (cache.size > 5000) cache.delete(cache.keys().next().value)
  return spec
}

// Current request's spec; falls back to the upstream config convention
function current (defaults) {
  return store.getStore() || defaults
}

module.exports = { store, resolveSpec, current, detect, describeColumns, sourceFor, whoOf, forgetTable }
