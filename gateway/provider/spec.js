/*
  spec.js

  Per-table layer spec for the generic gateway. The upstream provider reads one geometry column / object
  id from config for every table; here each table is inspected once per caller and the result is scoped
  to the request with AsyncLocalStorage, so model.js can keep its query builders.

  Detection goes by type and content, never by column name: a GEOMETRY/GEOGRAPHY column by its type,
  WKT/WKB/GeoJSON in STRING/BINARY columns by sampling values with try_to_geometry, the object id from
  the table's primary key. Anything else (lon/lat columns, a specific id column) is an author's override.
*/

const { AsyncLocalStorage } = require('async_hooks')

const store = new AsyncLocalStorage()
const cache = new Map() // table -> { spec, at }
const TTL_MS = parseInt(process.env.SPEC_TTL_MS) || 600000

// Derived ids stay below 2^53 so ArcGIS JS holds them exactly. Collisions become likely past ~10^7 rows
// (birthday bound); such tables are better served with a real integer id (primary key or override).
const SYNTHETIC_ID_MODULUS = '9007199254740881'
const INT_TYPES = /^(tinyint|smallint|int|integer|bigint)$/
// A text/binary column is taken as geometry when this share of sampled non-null values parse
const PARSE_RATE = 0.95
const SAMPLE_ROWS = parseInt(process.env.SPEC_SAMPLE_ROWS) || 200

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

// Only plain identifiers are used as geometry or id columns (see detect)
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

const isNative = c => /^(geometry|geography)/.test(c.type)
const isText = c => c.type === 'string' || /^(varchar|char)\(/.test(c.type)
const isBinary = c => c.type === 'binary'
const isNumber = c => /^(double|float|decimal|tinyint|smallint|int|integer|bigint)/.test(c.type)

// GEOMETRY(4326) is used as-is; another SRID is reprojected; GEOMETRY(ANY)/GEOGRAPHY are taken as lon/lat
function nativeExpr (c) {
  const srid = (c.type.match(/\((\d+)\)/) || [])[1]
  if (c.type.startsWith('geography')) return `ST_GeomFromWKB(ST_AsBinary(${c.name}), 4326)`
  if (!srid) return `ST_SetSRID(${c.name}, 4326)`
  if (srid !== '4326') return `ST_Transform(${c.name}, 4326)`
  return c.name
}

// WKT, EWKT, GeoJSON or WKB in a STRING/BINARY column, parsed by try_to_geometry. Values without an SRID are
// taken as lon/lat (4326) unless the sample (or an override) says otherwise.
function parsedExpr (c, srid) {
  const g = `try_to_geometry(${c.name})`
  if (!srid || srid === 4326 || srid === 0) return `ST_SetSRID(${g}, 4326)`
  return `ST_Transform(ST_SetSRID(${g}, ${srid}), 4326)`
}

/**
 * Columns xxhash64 can't take directly are hashed through another form: GEOMETRY/GEOGRAPHY as WKB, MAP and
 * VARIANT (anywhere in the type) as JSON text.
 */
function hashInput (c) {
  if (isNative(c)) return `ST_AsBinary(${c.name})`
  if (/map<|variant/.test(c.type)) return `to_json(${c.name})`
  return c.name
}

/**
 * SQL that samples every STRING/BINARY column: per column i, n<i> = non-null values, g<i> = values that
 * parse as geometry, j<i> = values that look like GeoJSON, s<i> = most common SRID. Null when no candidates.
 */
function sampleSql (table, cols) {
  const cands = cols.filter(c => PLAIN_IDENTIFIER.test(c.name) && (isText(c) || isBinary(c)))
  if (!cands.length) return null
  const parts = cands.map((c, i) => [
    `count(${c.name}) AS n${i}`,
    `count(try_to_geometry(${c.name})) AS g${i}`,
    isText(c) ? `count_if(ltrim(${c.name}) LIKE '{%') AS j${i}` : `0 AS j${i}`,
    `mode(ST_SRID(try_to_geometry(${c.name}))) AS s${i}`
  ].join(', '))
  return { sql: `SELECT ${parts.join(', ')} FROM (SELECT ${cands.map(c => c.name).join(', ')} FROM ${table} LIMIT ${SAMPLE_ROWS}) AS sample`, cands }
}

/** Sample row -> [{ column, rate, n, srid, storage }] for columns that parse, best first. */
function readSample (sample, row) {
  if (!sample || !row) return []
  const out = []
  sample.cands.forEach((c, i) => {
    const n = Number(row[`n${i}`] || 0)
    const g = Number(row[`g${i}`] || 0)
    if (!n || g / n < PARSE_RATE) return
    const storage = isBinary(c) ? 'wkb' : Number(row[`j${i}`] || 0) > g / 2 ? 'geojson' : 'wkt'
    out.push({ column: c.name, rate: g / n, n, srid: Number(row[`s${i}`] || 0) || 0, storage })
  })
  return out.sort((a, b) => b.rate - a.rate || b.n - a.n)
}

/**
 * Work out a table's geometry and object id from its columns and what was learned about its content.
 *   override: { geometryColumn?, srid?, lonColumn?, latColumn?, idColumn? } set by an author in the console
 *   primaryKey: [column names] of the table's Unity Catalog primary key
 *   parsed: readSample() result for its STRING/BINARY columns
 * Nothing is inferred from column names. Returns null when there is no geometry.
 */
function detect (allCols, { override = null, primaryKey = [], parsed = [] } = {}) {
  // Column names end up in SQL unquoted, so only plain identifiers may be used as geometry or id columns.
  // Unity Catalog allows almost anything in a backtick-quoted name; a crafted name would be SQL injection
  // running with the caller's permissions.
  const cols = allCols.filter(c => PLAIN_IDENTIFIER.test(c.name))
  const col = name => name ? cols.find(c => c.lname === String(name).toLowerCase()) : null
  const o = override || {}

  let geom = null
  const natives = cols.filter(isNative)
  if (o.lonColumn || o.latColumn) {
    const lon = col(o.lonColumn)
    const lat = col(o.latColumn)
    if (lon && lat && isNumber(lon) && isNumber(lat)) {
      geom = { column: null, expr: `ST_Point(${lon.name}, ${lat.name}, 4326)`, source: `${lon.name}/${lat.name}`, storage: 'lonlat', by: 'override' }
    }
  } else if (o.geometryColumn) {
    const c = col(o.geometryColumn)
    const p = c && parsed.find(x => x.column === c.name)
    if (c && isNative(c)) geom = { column: c.name, expr: nativeExpr(c), source: c.type, storage: 'native', by: 'override' }
    else if (c && (isText(c) || isBinary(c))) {
      const srid = Number(o.srid) || p?.srid || 0
      geom = { column: c.name, expr: parsedExpr(c, srid), source: `${p?.storage || (isBinary(c) ? 'wkb' : 'wkt')} ${c.type}`, storage: p?.storage || (isBinary(c) ? 'wkb' : 'wkt'), by: 'override' }
    }
  }
  if (!geom && natives.length) {
    geom = { column: natives[0].name, expr: nativeExpr(natives[0]), source: natives[0].type, storage: 'native', by: 'type' }
  }
  if (!geom && parsed.length) {
    const p = parsed[0]
    const c = col(p.column)
    geom = { column: c.name, expr: parsedExpr(c, p.srid), source: `${p.storage} ${c.type}`, storage: p.storage, by: 'content' }
  }
  if (!geom) return null

  const spec = {
    geometryColumn: geom.column,
    geometryFormat: 'expr',
    geometryExpr: geom.expr,
    geometrySource: geom.source,
    geometryStorage: geom.storage,
    geometryDetectedBy: geom.by,
    // Other columns that could be the geometry, for the console's override picker
    geometryCandidates: [...natives.map(c => c.name), ...parsed.map(p => p.column)].filter((v, i, a) => a.indexOf(v) === i),
    spatialReference: 4326
  }

  // Map-optimized copies (written by the console's "Optimize for maps") carry per-row bounding boxes;
  // filtering on them first lets Databricks skip files that can't intersect a tile
  const dbl = n => cols.some(x => x.lname === n && /^(double|float)/.test(x.type))
  if (['_xmin', '_ymin', '_xmax', '_ymax'].every(dbl)) spec.bboxColumns = true

  // Object id: an author's choice, else a single-column integer primary key, else derived from the row
  const idCol = col(o.idColumn)
  const pk = primaryKey.length === 1 ? col(primaryKey[0]) : null
  const taken = cols.some(c => c.lname === 'objectid') ? '__objectid' : 'objectid'
  if (idCol && INT_TYPES.test(idCol.type)) {
    Object.assign(spec, { objectId: idCol.name, idSource: 'override' })
  } else if (idCol && isText(idCol)) {
    // A string key (Overture GERS ids, UUIDs): hashed to an integer
    Object.assign(spec, { objectId: taken, idSource: 'override', syntheticIdFrom: idCol.name, objectIdExpr: `CAST(pmod(xxhash64(${idCol.name}), ${SYNTHETIC_ID_MODULUS}) AS BIGINT)` })
  } else if (pk && INT_TYPES.test(pk.type)) {
    Object.assign(spec, { objectId: pk.name, idSource: 'primary key' })
  } else {
    // No declared key: a hash of the whole row. Stable while the row is unchanged, so fine for viewing,
    // but an edit would change it, so these layers are read-only.
    const inputs = cols.filter(c => !(spec.bboxColumns && /^_[xy](min|max)$/.test(c.lname))).map(hashInput)
    Object.assign(spec, { objectId: taken, idSource: 'derived', syntheticIdFrom: 'all columns', objectIdExpr: `CAST(pmod(xxhash64(${inputs.join(', ')}), ${SYNTHETIC_ID_MODULUS}) AS BIGINT)` })
  }
  return spec
}

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

// Primary key columns of a table, from its catalog's information_schema (names are plain identifiers here)
function primaryKeySql (table) {
  const [cat, sch, tbl] = table.split('.')
  return `SELECT k.column_name AS c FROM ${cat}.information_schema.table_constraints t
    JOIN ${cat}.information_schema.key_column_usage k
      ON k.constraint_catalog = t.constraint_catalog AND k.constraint_schema = t.constraint_schema AND k.constraint_name = t.constraint_name
    WHERE t.table_schema = '${sch}' AND t.table_name = '${tbl}' AND t.constraint_type = 'PRIMARY KEY'
    ORDER BY k.ordinal_position`
}

// Where authors' overrides come from (set by server.js): async (table, exec) -> override or null
let overrideSource = async () => null
function setOverrideSource (fn) { overrideSource = fn }

/**
 * Inspect a table once per caller (cached): DESCRIBE, its override, its primary key and, when it has no
 * native geometry (or an override names a text column), a sample of its STRING/BINARY columns.
 * exec(sql, kind) -> rows. Returns the spec, or null when the table has no geometry.
 */
async function resolveSpec (table, exec, who = 'app') {
  const key = `${who}|${table}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.spec

  const cols = describeColumns(await exec(`DESCRIBE ${table}`, 'describe'))
  const plain = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)
  const [override, primaryKey] = await Promise.all([
    overrideSource(table, exec).catch(() => null),
    plain ? exec(primaryKeySql(table), 'primary key').then(rows => rows.map(r => r.c)).catch(() => []) : []
  ])
  const needsSample = !cols.some(isNative) || (override && override.geometryColumn)
  let parsed = []
  if (needsSample) {
    const sample = sampleSql(table, cols)
    if (sample) parsed = readSample(sample, (await exec(sample.sql, 'sample').catch(() => []))[0])
  }
  const spec = detect(cols, { override, primaryKey, parsed })
  if (spec) {
    const notNull = spec.geometryColumn ? `${spec.geometryColumn} IS NOT NULL` : 'TRUE'
    const rows = await exec(`SELECT lower(ST_GeometryType(${spec.geometryExpr})) AS t FROM ${table} WHERE ${notNull} LIMIT 1`, 'geomtype').catch(() => [])
    spec.source = sourceFor(table, spec)
    const t = rows[0] && String(rows[0].t || '').replace(/^st_/, '')
    spec.geometryType = ESRI_TYPE[t] || 'esriGeometryPoint'
    spec.columns = cols.map(c => ({ name: c.name, type: c.type }))
  }
  cache.set(key, { spec, at: Date.now() })
  if (cache.size > 5000) cache.delete(cache.keys().next().value)
  return spec
}

// Current request's spec; falls back to the upstream config convention
function current (defaults) {
  return store.getStore() || defaults
}

module.exports = { store, resolveSpec, current, detect, describeColumns, sourceFor, whoOf, forgetTable, sampleSql, readSample, primaryKeySql, setOverrideSource, hashInput, PLAIN_IDENTIFIER, SYNTHETIC_ID_MODULUS }
