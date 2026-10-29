/*
  model.js

  This file is required. It must export a class with at least one public function called `getData`

  Documentation: http://koopjs.github.io/docs/usage/provider
*/

const { v4: uuidv4 } = require('uuid')
const config = require('../config/default.json')
const logger = require('./logger')
const connectionManager = require('./connection')
const layerSpec = require('./spec')
const { toWkt } = require('../edits')
const { validateWhereClause, validateColumnName, validateColumnList } = require('./validation')

// Environment variables take precedence over config/default.json
const DEFAULT_OBJECT_ID = process.env.OBJECT_ID_COLUMN || config.objectId || 'objectid'
const DEFAULT_GEOMETRY_COLUMN = process.env.GEOMETRY_COLUMN || config.geometryColumn || 'geometry_wkt'
const DEFAULT_GEOMETRY_FORMAT = (process.env.GEOMETRY_FORMAT || config.geometryFormat || 'wkt').toLowerCase()
const DEFAULT_SR = parseInt(process.env.SPATIAL_REFERENCE) || config.spatialReference || 4326
const maxRows = parseInt(process.env.MAX_ROWS) || parseInt(config.maxRows) || 10000
const queryTimeoutSeconds = parseInt(process.env.QUERY_TIMEOUT_SECONDS) || 30
const cacheTTLMs = parseInt(process.env.CACHE_TTL_MS) || 300000
const CACHE_MAX_ENTRIES = 100
// Big tables draw only when zoomed in (advertised as the layer's minScale, which every ArcGIS client honors)
const BIG_TABLE_FEATURES = parseInt(process.env.BIG_TABLE_FEATURES) || 250000
const BIG_TABLE_MIN_SCALE = parseInt(process.env.BIG_TABLE_MIN_SCALE) || 1155582 // about zoom level 9
// Repeated tile/page requests: per-user cache of the SQL rows (re-translated on each hit)
const QUERY_CACHE_TTL_MS = parseInt(process.env.QUERY_CACHE_TTL_MS) || 300000
const QUERY_CACHE_MAX_ROWS = parseInt(process.env.QUERY_CACHE_MAX_ROWS) || 400000
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 100
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000

logger.info(`Defaults: objectId=${DEFAULT_OBJECT_ID}, geometryColumn=${DEFAULT_GEOMETRY_COLUMN}, geometryFormat=${DEFAULT_GEOMETRY_FORMAT}, maxRows=${maxRows}`)

// Per-request table spec (see spec.js); the upstream config is the fallback
const DEFAULT_SPEC = { objectId: DEFAULT_OBJECT_ID, geometryColumn: DEFAULT_GEOMETRY_COLUMN, geometryFormat: DEFAULT_GEOMETRY_FORMAT, spatialReference: DEFAULT_SR }
const S = () => layerSpec.current(DEFAULT_SPEC)

// Ring buffer of recently executed queries, exposed as Model.recentQueries
// for diagnostics and demo UIs (e.g. a query inspector panel)
const RECENT_QUERIES_MAX = 50
const recentQueries = []

function recordQuery (entry) {
  recentQueries.push(entry)
  if (recentQueries.length > RECENT_QUERIES_MAX) recentQueries.shift()
}

// Which protocol a statement serves (esri FeatureServer, ogc API – Features, console), as a trailing comment
// Databricks keeps in query history (filter system.query.history on statement_text LIKE '%geolakelayers:ogc%').
// Trailing, so routing that reads the start of a statement still sees SELECT/DESCRIBE; added below the query
// cache, so Esri and OGC pages of the same table still share cached rows.
function taggedSession (session, protocol, detail) {
  const clean = String(detail || '').replace(/[^A-Za-z0-9_.=-]/g, '')
  const tag = ` /* geolakelayers:${protocol}${clean ? ' ' + clean : ''} */`
  return {
    protocol,
    executeStatement: (sql, opts) => session.executeStatement(sql + tag, opts),
    close: () => session.close()
  }
}

// Execute a statement, fetch all rows, and record it in the query log
// (params: named SQL parameters, only sent when there are some)
async function executeAndRecord (session, sql, kind, taskId, params) {
  const started = Date.now()
  const options = { queryTimeout: queryTimeoutSeconds }
  if (params && Object.keys(params).length) options.namedParameters = params
  const op = await session.executeStatement(sql, options)
  let rows
  try {
    rows = await op.fetchAll()
  } finally {
    // Closed even when the fetch fails, so the warehouse doesn't keep the operation open
    await op.close().catch(err => logger.warn(`${taskId}> Closing operation failed: ${err.message}`))
  }
  recordQuery({
    at: new Date(started).toISOString(),
    taskId,
    kind,
    protocol: session.protocol || null,
    sql,
    durationMs: Date.now() - started,
    rows: rows.length
  })
  return rows
}

// Simple sliding-window rate limiter (per IP)
const rateLimitStore = {}
// Clients tracked at once: past this, the longest-tracked is dropped, so spraying made-up addresses can't fill memory
const RATE_LIMIT_MAX_CLIENTS = 10000
let rateLimitClients = 0

function checkRateLimit (ip) {
  const now = Date.now()
  if (!rateLimitStore[ip]) {
    if (rateLimitClients >= RATE_LIMIT_MAX_CLIENTS) {
      delete rateLimitStore[Object.keys(rateLimitStore)[0]]
      rateLimitClients--
    }
    rateLimitStore[ip] = []
    rateLimitClients++
  }
  // Remove expired timestamps
  rateLimitStore[ip] = rateLimitStore[ip].filter(t => now - t < rateLimitWindowMs)
  if (rateLimitStore[ip].length >= rateLimitMax) {
    return false
  }
  rateLimitStore[ip].push(now)
  return true
}

// Clean up stale IPs every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const ip of Object.keys(rateLimitStore)) {
    rateLimitStore[ip] = rateLimitStore[ip].filter(t => now - t < rateLimitWindowMs)
    if (rateLimitStore[ip].length === 0) delete rateLimitStore[ip]
  }
}, 300000).unref()

// Cache for field metadata: { ['<who>|<table>']: { data, timestamp } }, shared so forgetTable can reach it
const fieldsCache = {}

function Model (koop) {
  this.fieldsCache = fieldsCache
}

// Public function to return data from a Databricks SQL Endpoint
// Return: GeoJSON FeatureCollection
//
// Supports standard Koop query parameters:
// - where: SQL WHERE clause
// - geometry: bbox for spatial filtering
// - outFields: comma-separated list of fields to return
// - returnGeometry: boolean to include/exclude geometry
// - resultOffset: pagination offset
// - resultRecordCount: pagination limit
// - orderByFields: SQL ORDER BY clause
//
// URL path parameters:
// req.params.id - table name (catalog.schema.table)
// req.params.layer - layer index (not used, leave as '0')
// req.params.method - method name (e.g., 'query')
Model.prototype.getData = function (req, callback) {
  const thisTask = uuidv4()
  logger.info(`${thisTask}> Received request: ${req.url}`)

  // Rate limiting. Behind a load balancer req.ip is the LB address (Express
  // 'trust proxy' is not set by Koop), so prefer the first X-Forwarded-For hop.
  // The Databricks Apps front door sets X-Forwarded-Email to the signed-in user (a client can't), whereas the
  // earlier X-Forwarded-For hops are whatever the client sent; key on the user, else the last (proxy-added) hop.
  const forwardedFor = req.headers && req.headers['x-forwarded-for']
  const forwardedEmail = req.headers && req.headers['x-forwarded-email']
  const clientIp = (typeof forwardedEmail === 'string' && forwardedEmail && `user:${forwardedEmail}`) ||
    (typeof forwardedFor === 'string' && forwardedFor.split(',').pop().trim()) ||
    req.ip || req.socket?.remoteAddress || 'unknown'
  if (!checkRateLimit(clientIp)) {
    logger.warn(`${thisTask}> Rate limit exceeded for ${clientIp}`)
    const err = new Error('Rate limit exceeded. Try again later.')
    err.code = 429
    return callback(err)
  }

  const table = req.params.id

  // Validate table name to prevent SQL injection
  if (!table || typeof table !== 'string' || !isValidTableName(table)) {
    return callback(new Error('Invalid table name provided'))
  }

  // Run as the calling user when the front door forwards their token (USE_OBO=false to run as the app).
  // Open tables are read as the app on its bound warehouse (the service principal may not use the others).
  const open = layerSpec.isOpenTable(table)
  const userToken = !open && process.env.USE_OBO !== 'false' ? req.headers && req.headers['x-forwarded-access-token'] : null
  const warehouseId = open ? undefined : req.warehouseId
  connectionManager.getSession(userToken, warehouseId)
    .then(async raw => {
      const session = taggedSession(raw, 'esri')
      try {
        // Inspect the table once (cached) and scope its spec to this request
        const who = layerSpec.whoOf(userToken)
        const spec = await layerSpec.resolveSpec(table, (sql, kind) => executeAndRecord(session, sql, kind, thisTask), who)
        if (!spec) {
          const err = new Error(`${table} has no usable geometry (GEOMETRY/GEOGRAPHY, WKT, WKB or lon/lat columns) or no integer object id`)
          err.code = 400
          return callback(err)
        }
        layerSpec.store.enterWith(spec)
        // A time-aware table filters ArcGIS time= queries on the columns its owner named
        const props = await layerProps(table, session, thisTask, who)
        if (props.time) {
          req.query.timeField = props.time[0]
          req.query.timeEndField = props.time[1]
        }
        // Check for special query types
        const returnCountOnly = req.query.returnCountOnly === 'true'
        const returnIdsOnly = req.query.returnIdsOnly === 'true'
        const returnExtentOnly = req.query.returnExtentOnly === 'true'

        let queryString
        let result

        // Koop can't filter a count, id list or extent by geometry afterwards: a spatial filter SQL can't take
        // is refused rather than answered for the whole table
        if (returnExtentOnly || returnCountOnly || returnIdsOnly) assertSqlGeometryFilter(req.query)

        if (returnExtentOnly) {
          // Return only extent (bounding box). queryExtent() in the ArcGIS JS API (map "Zoom to" actions)
          // also sets returnCountOnly and expects { count, extent }, as ArcGIS Server answers.
          queryString = buildExtentQuery(table, req.query)
          logger.info(`${thisTask}> Executing extent query: ${queryString}`)

          result = await executeAndRecord(session, queryString, 'extent', thisTask)

          const row = result[0] || {}
          const extent = row.xmin !== null && row.xmin !== undefined
            ? { xmin: row.xmin, ymin: row.ymin, xmax: row.xmax, ymax: row.ymax, spatialReference: { wkid: S().spatialReference } }
            : null
          logger.info(`${thisTask}> Extent result: ${JSON.stringify(extent)}`)
          return callback(null, returnCountOnly ? { count: Number(row.cnt) || 0, extent } : { extent })
        } else if (returnCountOnly) {
          // Return only count (of distinct values when returnDistinctValues is set, as Filter/Select paging asks)
          queryString = isTrue(req.query.returnDistinctValues) && req.query.outFields && req.query.outFields !== '*'
            ? buildDistinctCountQuery(table, req.query)
            : buildCountQuery(table, req.query)
          logger.info(`${thisTask}> Executing count query: ${queryString}`)

          result = await executeAndRecord(session, queryString, 'count', thisTask)

          const count = result[0]?.cnt || 0
          logger.info(`${thisTask}> Count result: ${count}`)

          return callback(null, { count })
        } else if (returnIdsOnly) {
          // Return only IDs
          queryString = buildIdsQuery(table, req.query)
          logger.info(`${thisTask}> Executing IDs query: ${queryString}`)

          result = await executeAndRecord(session, queryString, 'ids', thisTask)

          const objectIds = result.map(row => row[S().objectId])
          logger.info(`${thisTask}> Returned ${objectIds.length} IDs`)

          return callback(null, { objectIdFieldName: S().objectId, objectIds })
        }

        // Statistics and distinct values cover the whole table in SQL (Koop would compute them from one page).
        // Filter/Select dropdowns and charts in Experience Builder ask for these.
        const statistics = parseStatistics(req.query.outStatistics)
        if (statistics || isTrue(req.query.returnDistinctValues)) {
          // Koop can't filter these rows by geometry, so a spatial filter has to make it into the SQL
          assertSqlGeometryFilter(req.query)
          const sql = statistics ? buildStatisticsQuery(table, req.query, statistics) : buildDistinctQuery(table, req.query)
          logger.info(`${thisTask}> Executing ${statistics ? 'statistics' : 'distinct'} query: ${sql}`)
          const key = queryCacheKey(userToken, warehouseId, sql)
          let rows = queryCacheGet(key)
          if (!rows) {
            rows = await executeAndRecord(session, sql, statistics ? 'statistics' : 'distinct', thisTask)
            queryCachePut(key, rows)
          }
          rows = rows.map(scalarAttributes)
          const metadata = { idField: S().objectId, name: table, maxRecordCount: maxRows, fields: await this.getFieldMetadata(table, session, thisTask, who) }
          // Koop takes the statistics fields from the first row, so an empty result goes out as no features
          if (statistics && rows.length) return callback(null, { statistics: rows, metadata })
          return callback(null, {
            type: 'FeatureCollection',
            features: rows.map(properties => ({ type: 'Feature', geometry: null, properties })),
            metadata,
            // Filters, paging and distinct are done; Koop still converts the rows to Esri features
            filtersApplied: { where: true, geometry: true, offset: true, limit: true }
          })
        }

        // Layer info (FeatureServer/0 without /query) only needs the schema, a geometry type and an
        // extent: fetch one sample row instead of a full page, and take the extent from SQL (cached)
        // (Koop doesn't set req.params.method reliably, so look at the path: layer info ends at the layer id)
        const isLayerInfo = isLayerInfoPath(req.originalUrl || req.url)
        // Regular query
        const featureQuery = isLayerInfo ? { ...req.query, resultRecordCount: '1', resultOffset: '0' } : req.query
        const { geojson } = await runFeatureQuery(session, table, featureQuery, { userToken, warehouseId, taskId: thisTask })

        logger.info(`${thisTask}> Translated to ${geojson.features.length} features`)
        if (geojson.features.length > 0) {
          logger.info(`${thisTask}> First feature objectid: ${geojson.features[0].properties[S().objectId]}`)
        }

        // Add metadata
        geojson.metadata = {
          idField: S().objectId,
          name: table,
          maxRecordCount: maxRows
        }

        // Detect and add geometry type from first feature
        if (geojson.features.length > 0 && geojson.features[0].geometry) {
          const geomType = geojson.features[0].geometry.type
          const ESRI_TYPE_MAP = {
            Point: 'esriGeometryPoint',
            MultiPoint: 'esriGeometryMultipoint',
            LineString: 'esriGeometryPolyline',
            MultiLineString: 'esriGeometryPolyline',
            Polygon: 'esriGeometryPolygon',
            MultiPolygon: 'esriGeometryPolygon',
            GeometryCollection: 'esriGeometryPolygon'
          }
          geojson.metadata.geometryType = ESRI_TYPE_MAP[geomType]
          if (!geojson.metadata.geometryType) {
            logger.warn(`Unknown geometry type: ${geomType}, defaulting to esriGeometryPoint`)
            geojson.metadata.geometryType = 'esriGeometryPoint'
          }
          logger.info(`${thisTask}> Detected geometry type: ${geojson.metadata.geometryType}`)
        }
        if (!geojson.metadata.geometryType) geojson.metadata.geometryType = spec.geometryType

        // Add field metadata from DESCRIBE TABLE
        geojson.metadata.fields = await this.getFieldMetadata(table, session, thisTask, who)

        // Tell Koop that we've already applied these filters server-side
        // This prevents Koop from re-applying pagination on already-paginated results.
        // Only claim the geometry filter when we actually built one — for ones SQL can't take
        // (relations other than intersects, other spatial references) Koop filters in memory.
        geojson.filtersApplied = {
          offset: true, // We handle resultOffset with SQL OFFSET
          limit: true, // We handle resultRecordCount with SQL LIMIT
          where: true, // We handle WHERE clauses in SQL
          geometry: !req.query.geometry ||
            buildBboxFilter(req.query.geometry, req.query.geometryType, req.query.inSR, req.query.spatialRel) !== null
        }

        if (isLayerInfo) {
          const extent = await tableExtent(table, session, thisTask, who)
          if (extent) geojson.metadata.extent = extent
          if (props.renderer) geojson.metadata.renderer = props.renderer
          if (props.labelingInfo) geojson.metadata.labelingInfo = props.labelingInfo
          if (props.time) {
            const timeInfo = await tableTimeInfo(table, props.time, session, thisTask, who)
            if (timeInfo) geojson.metadata.timeInfo = timeInfo
          }
          // Editable layers (gateway EDITING on, real integer id, not a map-optimized copy) say so
          if (process.env.EDITING === 'true' && require('../edits').editableSpec(spec)) {
            geojson.metadata.capabilities = 'Query,Create,Update,Delete,Editing'
          }
          const total = await tableCount(table, session, thisTask, who)
          if (total > BIG_TABLE_FEATURES) {
            geojson.metadata.minScale = BIG_TABLE_MIN_SCALE
            geojson.metadata.description = `${total.toLocaleString('en-US')} features; drawn when zoomed in`
          }
        } else if (geojson.features && geojson.features.length > 0) {
          // Add extent if we have features
          const extent = calculateExtent(geojson.features)
          if (extent) {
            geojson.metadata.extent = extent
          }
        }

        callback(null, geojson)
      } catch (error) {
        logger.error(`${thisTask}> Error executing query:`, error)
        callback(error)
      } finally {
        // Clean up the session only (NOT the shared client)
        try {
          if (session) await session.close()
        } catch (cleanupError) {
          logger.error(`${thisTask}> Error during cleanup:`, cleanupError)
        }
      }
    })
    .catch((error) => {
      logger.error(`${thisTask}> Error connecting to Databricks:`, error)
      callback(error)
    })
}

// Validate table name format (catalog.schema.table or schema.table)
function isValidTableName (tableName) {
  // Allow alphanumeric, underscores, and dots for three-level namespace
  return /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){1,2}$/.test(tableName)
}

// Build geometry expression based on format (WKT, WKB, GeoJSON, or native GEOMETRY)
function buildGeometryExpression () {
  switch (S().geometryFormat) {
    case 'wkb':
      // Well-Known Binary format - use ST_GeomFromWKB.
      // The SRID argument is required so ST_Intersects against the
      // bbox geometry (SRID 4326) doesn't fail on an SRID mismatch.
      return `ST_GeomFromWKB(${S().geometryColumn}, ${S().spatialReference})`

    case 'geojson':
      // GeoJSON string format - use ST_GeomFromGeoJSON
      return `ST_GeomFromGeoJSON(${S().geometryColumn})`

    case 'geometry':
      // Native Databricks GEOMETRY type - use directly
      return S().geometryColumn

    case 'expr':
      // Resolved per table in spec.js (native GEOMETRY/GEOGRAPHY, lon/lat columns)
      return S().geometryExpr

    case 'wkt':
    default:
      // Well-Known Text format (default) - use ST_GeomFromText
      return `ST_GeomFromText(${S().geometryColumn}, ${S().spatialReference})`
  }
}

// Parse resultRecordCount, clamping to [1, maxRows]. Invalid, negative, or
// oversized values fall back to maxRows so clients can't bypass the row cap.
function parseResultRecordCount (value) {
  const parsed = parseInt(value)
  if (isNaN(parsed) || parsed <= 0) return maxRows
  return Math.min(parsed, maxRows)
}

// Parse resultOffset, treating invalid or negative values as 0
function parseResultOffset (value) {
  const parsed = parseInt(value)
  if (isNaN(parsed) || parsed < 0) return 0
  return parsed
}

// Validate and push WHERE clause, throwing on injection attempts
function pushValidatedWhere (whereClauses, where) {
  if (where && where !== '1=1') {
    const result = validateWhereClause(where)
    if (!result.valid) {
      throw new Error(`Invalid WHERE clause: ${result.error}`)
    }
    whereClauses.push(`(${where})`)
  }
}

// Build the list of WHERE clauses shared by all query builders:
// user WHERE, bbox spatial filter, H3 filter, and time filter. Keeping this
// in one place ensures returnCountOnly/returnIdsOnly/returnExtentOnly apply the
// exact same filters as the feature query (ArcGIS clients rely on that parity).
function buildWhereClauses (query, extra = []) {
  const whereClauses = []

  pushValidatedWhere(whereClauses, query.where)

  if (query.geometry) {
    const bboxFilter = buildBboxFilter(query.geometry, query.geometryType, query.inSR, query.spatialRel)
    if (bboxFilter) {
      whereClauses.push(bboxFilter)
    }
  }

  if (query.h3col && query.h3res) {
    const h3Filter = buildH3Filter(query)
    if (h3Filter) {
      whereClauses.push(h3Filter)
    }
  }

  if (query.time) {
    const timeFilter = buildTimeFilter(query.time, query.timeField, query.timeEndField)
    if (timeFilter) {
      whereClauses.push(timeFilter)
    }
  }

  // Extra clauses built by the caller (OGC API filters), already safe SQL with named parameters
  for (const clause of extra) whereClauses.push(clause)

  return whereClauses
}

// Build count query (for returnCountOnly)
function buildCountQuery (table, query, extra = []) {
  const whereClauses = buildWhereClauses(query, extra)
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

  return `SELECT COUNT(*) as cnt FROM ${S().source || table} ${whereClause}`.trim()
}

// Build IDs only query (for returnIdsOnly)
function buildIdsQuery (table, query) {
  const offset = parseResultOffset(query.resultOffset)
  const limit = parseResultRecordCount(query.resultRecordCount)

  const whereClauses = buildWhereClauses(query)
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

  // Order BY for consistent pagination
  let orderByClause = ''
  if (query.orderByFields) {
    orderByClause = `ORDER BY ${sanitizeOrderBy(query.orderByFields)}`
  } else {
    orderByClause = `ORDER BY ${S().objectId}`
  }

  let sql = `SELECT ${S().objectId} FROM ${S().source || table} ${whereClause} ${orderByClause}`.trim()

  sql += ` LIMIT ${limit}`
  if (offset > 0) {
    sql += ` OFFSET ${offset}`
  }

  return sql
}

// Build extent query (for returnExtentOnly)
function buildExtentQuery (table, query) {
  const whereClauses = buildWhereClauses(query)
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

  // Use ST_Envelope to get bounding box, then extract min/max coordinates
  // This is more efficient than calculating extent on the client side
  const geomExpr = buildGeometryExpression()

  return `
    SELECT
      MIN(ST_XMin(ST_Envelope(${geomExpr}))) as xmin,
      MIN(ST_YMin(ST_Envelope(${geomExpr}))) as ymin,
      MAX(ST_XMax(ST_Envelope(${geomExpr}))) as xmax,
      MAX(ST_YMax(ST_Envelope(${geomExpr}))) as ymax,
      COUNT(*) as cnt
    FROM ${S().source || table}
    ${whereClause}
  `.trim()
}

function isTrue (value) {
  return value === true || value === 'true'
}

// outStatistics (a JSON array, or already parsed) -> [{ fn, field, alias }], or null when absent
const STATISTIC_SQL = { count: 'COUNT', sum: 'SUM', min: 'MIN', max: 'MAX', avg: 'AVG', stddev: 'STDDEV_SAMP', var: 'VAR_SAMP' }
const ALIAS = /^[a-zA-Z_][a-zA-Z0-9_]*$/
function parseStatistics (value) {
  if (value === undefined || value === null || value === '') return null
  let list = value
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { throw Object.assign(new Error('Invalid outStatistics: not JSON'), { code: 400 }) }
  }
  if (!Array.isArray(list)) list = [list]
  if (!list.length) return null
  return list.map(s => {
    const fn = STATISTIC_SQL[String(s.statisticType || '').toLowerCase()]
    if (!fn) throw Object.assign(new Error(`Unsupported statisticType: ${s.statisticType}`), { code: 400 })
    const field = s.onStatisticField
    if (!(fn === 'COUNT' && (field === '*' || field === undefined)) && !validateColumnName(field).valid) {
      throw Object.assign(new Error(`Invalid onStatisticField: ${field}`), { code: 400 })
    }
    const alias = s.outStatisticFieldName || `${String(s.statisticType).toLowerCase()}_${field === '*' || field === undefined ? 'all' : field}`
    if (!ALIAS.test(alias)) throw Object.assign(new Error(`Invalid outStatisticFieldName: ${alias}`), { code: 400 })
    return { fn, field: field === undefined ? '*' : field, alias }
  })
}

function columnList (value, what) {
  const result = validateColumnList(Array.isArray(value) ? value.join(',') : String(value))
  if (!result.valid) throw Object.assign(new Error(`Invalid ${what}: ${result.error}`), { code: 400 })
  if (S().geometryColumn && result.fields.some(f => f.toLowerCase() === S().geometryColumn.toLowerCase())) {
    throw Object.assign(new Error(`Invalid ${what}: the geometry column can't be grouped or listed`), { code: 400 })
  }
  return result.fields
}

// Counts, ids, extents, statistics and distinct values are filtered only in SQL: reject a spatial filter we
// can't translate (a relation other than intersects, another spatial reference) instead of answering for the
// whole table
function assertSqlGeometryFilter (query) {
  if (query.geometry && buildBboxFilter(query.geometry, query.geometryType, query.inSR, query.spatialRel) === null) {
    throw Object.assign(new Error('Unsupported spatial filter: intersects, in WGS84 or Web Mercator, is supported'), { code: 400 })
  }
}

// One row of statistics or distinct values as ArcGIS attributes: BIGINT -> number, dates -> epoch ms,
// STRUCT/ARRAY/MAP -> JSON text, binary dropped
function scalarAttributes (row) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = Number(v)
    else if (v instanceof Date) out[k] = v.getTime()
    else if (v !== null && typeof v === 'object') {
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) continue
      out[k] = JSON.stringify(v, bigintToNumber)
    } else out[k] = v
  }
  return out
}

// Statistics query: SELECT <group fields>, FN(field) AS alias ... GROUP BY <group fields>, same filters as features
function buildStatisticsQuery (table, query, statistics) {
  const groupBy = query.groupByFieldsForStatistics ? columnList(query.groupByFieldsForStatistics, 'groupByFieldsForStatistics') : []
  const whereClauses = buildWhereClauses(query)
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
  const stats = statistics.map(({ fn, field, alias }) => `${fn}(${field}) AS ${alias}`)
  let sql = `SELECT ${[...groupBy, ...stats].join(', ')} FROM ${S().source || table}${whereClause ? ' ' + whereClause : ''}`
  if (groupBy.length) {
    sql += ` GROUP BY ${groupBy.join(', ')}`
    sql += ` ORDER BY ${query.orderByFields ? sanitizeOrderBy(query.orderByFields) : groupBy.join(', ')}`
    sql += ` LIMIT ${parseResultRecordCount(query.resultRecordCount)}`
    const offset = parseResultOffset(query.resultOffset)
    if (offset > 0) sql += ` OFFSET ${offset}`
  }
  return sql
}

// Distinct values of outFields (no geometry), same filters as features
function distinctSelect (table, query) {
  if (!query.outFields || query.outFields === '*') throw Object.assign(new Error('returnDistinctValues needs outFields'), { code: 400 })
  const fields = columnList(query.outFields, 'outFields')
  const whereClauses = buildWhereClauses(query)
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''
  return { fields, sql: `SELECT DISTINCT ${fields.join(', ')} FROM ${S().source || table}${whereClause ? ' ' + whereClause : ''}` }
}

// Number of distinct values (returnDistinctValues with returnCountOnly)
function buildDistinctCountQuery (table, query) {
  return `SELECT COUNT(*) AS cnt FROM (${distinctSelect(table, query).sql}) d`
}

function buildDistinctQuery (table, query) {
  const { fields, sql: select } = distinctSelect(table, query)
  let sql = select
  sql += ` ORDER BY ${query.orderByFields ? sanitizeOrderBy(query.orderByFields) : fields.join(', ')}`
  sql += ` LIMIT ${parseResultRecordCount(query.resultRecordCount)}`
  const offset = parseResultOffset(query.resultOffset)
  if (offset > 0) sql += ` OFFSET ${offset}`
  return sql
}

// Per-user query cache: key includes the user (UC permissions differ), warehouse and the exact SQL
const queryCache = new Map() // key -> { rows, at }
let queryCacheRows = 0
function queryCacheKey (userToken, warehouseId, sql, params) {
  const crypto = require('crypto')
  const p = params && Object.keys(params).length ? `\0${JSON.stringify(params)}` : ''
  return crypto.createHash('sha256').update(`${userToken || 'app'}|${warehouseId || ''}|${sql}${p}`).digest('hex')
}
function queryCacheStats () {
  return { entries: queryCache.size, rows: queryCacheRows }
}
function queryCacheGet (key) {
  const hit = queryCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > QUERY_CACHE_TTL_MS) { queryCache.delete(key); queryCacheRows -= hit.rows.length; return null }
  queryCache.delete(key); queryCache.set(key, hit) // most recently used last
  return hit.rows
}
function queryCachePut (key, rows) {
  if (rows.length > QUERY_CACHE_MAX_ROWS / 4) return
  const prev = queryCache.get(key)
  if (prev) { queryCache.delete(key); queryCacheRows -= prev.rows.length }
  queryCache.set(key, { rows, at: Date.now() })
  queryCacheRows += rows.length
  for (const [k, v] of queryCache) {
    if (queryCacheRows <= QUERY_CACHE_MAX_ROWS) break
    queryCache.delete(k); queryCacheRows -= v.rows.length
  }
}

/** Drop cached rows, counts, extents and fields for a table that was replaced. */
function forgetTable (table) {
  layerSpec.forgetTable(table)
  for (const m of [countCache, extentCache, layerPropsCache]) for (const k of m.keys()) if (k.endsWith(`|${table}`)) m.delete(k)
  for (const k of timeInfoCache.keys()) if (k.includes(`|${table}|`)) timeInfoCache.delete(k)
  for (const k of temporalCache.keys()) if (k.includes(`|${table}|`)) temporalCache.delete(k)
  for (const k of Object.keys(fieldsCache)) if (k.endsWith(`|${table}`)) delete fieldsCache[k]
  // Query-cache keys are hashes of the SQL; replacing a table is rare, so clear them all
  queryCache.clear(); queryCacheRows = 0
}

// Row count for layer info (TTL cache)
const countCache = new Map()
async function tableCount (table, session, taskId, who = 'app') {
  const key = `${who}|${table}`
  const hit = countCache.get(key)
  if (hit && Date.now() - hit.at < cacheTTLMs * 6) return hit.count
  try {
    const rows = await executeAndRecord(session, `SELECT COUNT(*) AS cnt FROM ${table}`, 'count', taskId)
    const count = Number(rows[0]?.cnt || 0)
    countCache.set(key, { count, at: Date.now() })
    return count
  } catch (error) {
    // Not cached: a transient failure shouldn't stick (and 0 would drop a big table's minScale)
    logger.warn(`${taskId}> Count failed for ${table}: ${error.message}`)
    return 0
  }
}

// Whole-table extent for layer info, computed once per table in SQL (TTL cache)
const extentCache = new Map()
async function tableExtent (table, session, taskId, who = 'app') {
  const key = `${who}|${table}`
  const hit = extentCache.get(key)
  if (hit && Date.now() - hit.at < cacheTTLMs * 6) return hit.extent
  try {
    const rows = await executeAndRecord(session, buildExtentQuery(table, {}), 'extent', taskId)
    const r = rows[0]
    const extent = r && r.xmin !== null && r.xmin !== undefined
      ? { xmin: r.xmin, ymin: r.ymin, xmax: r.xmax, ymax: r.ymax, spatialReference: { wkid: S().spatialReference } }
      : null
    extentCache.set(key, { extent, at: Date.now() })
    return extent
  } catch (error) {
    logger.warn(`${taskId}> Extent query failed for ${table}: ${error.message}`)
    return null
  }
}

// Table properties a table's owner sets for its layer: geolakelayers.renderer (an Esri renderer, JSON),
// geolakelayers.labeling (Esri labelingInfo, a JSON array) and geolakelayers.time ("start_column" or
// "start_column,end_column", which makes the layer time-aware). Bad values are ignored with a warning.
const layerPropsCache = new Map()
const MAX_STYLE_JSON = 65536
function parseLayerProps (rows, table) {
  const get = k => {
    const r = rows.find(r => (r.key ?? Object.values(r)[0]) === k)
    return r ? String(r.value ?? Object.values(r)[1] ?? '') : ''
  }
  const json = (k, ok) => {
    const v = get(k)
    if (!v) return undefined
    try {
      if (v.length > MAX_STYLE_JSON) throw new Error('too long')
      const parsed = JSON.parse(v)
      if (ok(parsed)) return parsed
      throw new Error('wrong shape')
    } catch (error) {
      logger.warn(`Ignoring ${k} on ${table}: ${error.message}`)
    }
  }
  const out = {}
  const renderer = json('geolakelayers.renderer', r => r && typeof r === 'object' && typeof r.type === 'string')
  if (renderer) out.renderer = renderer
  const labeling = json('geolakelayers.labeling', l => Array.isArray(l))
  if (labeling) out.labelingInfo = labeling
  const time = get('geolakelayers.time').split(',').map(c => c.trim()).filter(Boolean)
  if (time.length && time.length <= 2 && time.every(c => validateColumnName(c).valid)) out.time = time
  else if (time.length) logger.warn(`Ignoring geolakelayers.time on ${table}: one or two column names`)
  return out
}

async function layerProps (table, session, taskId, who = 'app') {
  const key = `${who}|${table}`
  const hit = layerPropsCache.get(key)
  if (hit && Date.now() - hit.at < cacheTTLMs) return hit.props
  let props = {}
  try {
    props = parseLayerProps(await executeAndRecord(session, `SHOW TBLPROPERTIES ${table}`, 'properties', taskId), table)
  } catch (error) {
    logger.warn(`${taskId}> Table properties unreadable for ${table}: ${error.message}`)
  }
  layerPropsCache.set(key, { props, at: Date.now() })
  return props
}

// Esri timeInfo for a time-aware layer: its fields and the range the data covers (for time sliders)
const timeInfoCache = new Map()
async function tableTimeInfo (table, [start, end], session, taskId, who = 'app') {
  const key = `${who}|${table}|${start}|${end || ''}`
  const hit = timeInfoCache.get(key)
  if (hit && Date.now() - hit.at < cacheTTLMs * 6) return hit.info
  const ms = v => v === null || v === undefined ? null : new Date(v).getTime()
  let info = null
  try {
    const rows = await executeAndRecord(session, `SELECT MIN(${start}) AS t0, MAX(${end || start}) AS t1 FROM ${table}`, 'time', taskId)
    const r = rows[0] || {}
    info = { startTimeField: start, timeExtent: [ms(r.t0), ms(r.t1)], timeReference: { timeZone: 'UTC' } }
    if (end) info.endTimeField = end
  } catch (error) {
    logger.warn(`${taskId}> Time range query failed for ${table}: ${error.message}`)
  }
  timeInfoCache.set(key, { info, at: Date.now() })
  return info
}

// Build SQL query with ST functions and filters
function buildQuery (table, query, taskId, extra = []) {
  const returnGeometry = query.returnGeometry !== 'false'
  const offset = parseResultOffset(query.resultOffset)
  const limit = parseResultRecordCount(query.resultRecordCount)

  // Build SELECT clause
  const selectFields = buildSelectClause(query.outFields, returnGeometry, simplifyTolerance(query))

  const whereClauses = buildWhereClauses(query, extra)
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

  // Build ORDER BY clause
  // IMPORTANT: Always use ORDER BY so pagination is deterministic across requests
  let orderByClause = ''
  if (query.orderByFields) {
    orderByClause = `ORDER BY ${sanitizeOrderBy(query.orderByFields)}`
  } else {
    orderByClause = `ORDER BY ${S().objectId}`
  }

  // Build complete query
  let sql = `SELECT ${selectFields} FROM ${S().source || table} ${whereClause} ${orderByClause}`.trim()

  // Add pagination
  sql += ` LIMIT ${limit}`
  if (offset > 0) {
    sql += ` OFFSET ${offset}`
  }

  return sql
}

// How far, in degrees, lines and polygons may be simplified for this request: the client's maxAllowableOffset
// (in outSR units; the ArcGIS Maps SDK sends one per zoom level) converted to the data's lon/lat. 0 = full
// detail. Points are never simplified. Sending every vertex of long tracks at world zoom is what fills memory.
function simplifyTolerance (query) {
  if (!/Polyline|Polygon/.test(S().geometryType || '')) return 0
  const offset = Number(query.maxAllowableOffset)
  if (!(offset > 0)) return 0
  let sr = query.outSR
  if (typeof sr === 'string' && sr.trim().startsWith('{')) { try { sr = JSON.parse(sr) } catch (_) { return 0 } }
  const wkid = sr ? parseInt(typeof sr === 'object' ? (sr.latestWkid || sr.wkid) : sr) : 4326
  let degrees
  if (wkid === 4326) {
    degrees = offset
  } else if (wkid === 102100 || wkid === 3857 || wkid === 900913) {
    // Mercator meters span fewer degrees of latitude away from the equator; use the view's middle latitude
    const box = query.geometry ? parseBbox(query.geometry, query.inSR) : null
    const lat = box ? Math.max(-80, Math.min(80, (box[1] + box[3]) / 2)) : 0
    degrees = offset / 111319.49 * Math.cos(lat * Math.PI / 180)
  } else {
    return 0
  }
  // Rounded so tiles at one zoom level share a query (and a cache entry)
  return degrees > 0 ? Number(Math.min(degrees, 5).toPrecision(2)) : 0
}

// Build SELECT clause with ST_AsGeoJSON for geometry
function buildSelectClause (outFields, returnGeometry, tolerance = 0) {
  let fields

  if (outFields === '*' || !outFields) {
    // Return all fields except geometry column (we'll add it as GeoJSON)
    fields = '*'
  } else {
    // Validate each field name
    const result = validateColumnList(outFields)
    if (!result.valid) {
      throw new Error(`Invalid outFields: ${result.error}`)
    }
    fields = result.fields.join(', ')
  }

  if (returnGeometry) {
    // Use ST_AsGeoJSON to convert geometry to GeoJSON in the database
    // This is much more efficient than parsing geometry on the client
    // Supports WKT, WKB, and native GEOMETRY types
    const geomExpr = buildGeometryExpression()
    // A shape smaller than the tolerance simplifies to an empty geometry, which the PBF encoder can't take;
    // keep those as they are (they cover a pixel or less anyway)
    const simplified = `ST_Simplify(${geomExpr}, ${tolerance})`
    const shape = tolerance > 0 ? `CASE WHEN ST_IsEmpty(${simplified}) THEN ${geomExpr} ELSE ${simplified} END` : geomExpr
    return `${fields}, ST_AsGeoJSON(${shape}) as __geojson__`
  }

  return fields
}

// Convert Web Mercator (EPSG:3857 / 102100) coordinates to WGS84 degrees
function webMercatorToWgs84 (x, y) {
  const R = 6378137
  const lon = (x / R) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)
  return [lon, lat]
}

// Parse the ArcGIS geometry parameter into [xmin, ymin, xmax, ymax] in the
// data's spatial reference. Supports the comma form ("xmin,ymin,xmax,ymax")
// and the JSON envelope/point forms that ArcGIS clients send
// (e.g. {"xmin":...,"spatialReference":{"wkid":102100}}). Koop core may have
// already parsed the JSON form into an object before getData is called.
// Returns null for unsupported geometry filters (e.g. polygon).
// A spatial reference as ArcGIS clients send it: 102100, "102100", {"wkid":102100}, {"latestWkid":3857} or its
// JSON text -> the wkid as a number, or null
function parseWkid (sr) {
  if (typeof sr === 'string' && sr.trim().startsWith('{')) {
    try { sr = JSON.parse(sr) } catch (error) { return null }
  }
  if (sr && typeof sr === 'object') sr = sr.latestWkid || sr.wkid
  return parseInt(sr) || null
}

function parseBbox (geometryParam, inSR) {
  let coords
  let wkid = parseWkid(inSR)
  let envelope = null

  if (geometryParam && typeof geometryParam === 'object') {
    envelope = geometryParam
  } else {
    const trimmed = String(geometryParam).trim()
    if (trimmed.startsWith('{')) {
      try {
        envelope = JSON.parse(trimmed)
      } catch (error) {
        return null
      }
    } else {
      coords = trimmed.split(',').map(Number)
    }
  }

  if (envelope) {
    const num = v => (v === null || v === undefined || v === '') ? NaN : Number(v)
    if (['xmin', 'ymin', 'xmax', 'ymax'].every(k => !isNaN(num(envelope[k])))) {
      coords = [num(envelope.xmin), num(envelope.ymin), num(envelope.xmax), num(envelope.ymax)]
    } else if (!isNaN(num(envelope.x)) && !isNaN(num(envelope.y))) {
      coords = [num(envelope.x), num(envelope.y), num(envelope.x), num(envelope.y)]
    } else {
      return null
    }
    if (envelope.spatialReference) {
      wkid = parseWkid(envelope.spatialReference) || wkid
    }
  }

  if (!coords || coords.length !== 4 || coords.some(c => typeof c !== 'number' || isNaN(c))) {
    return null
  }
  // Only WGS84 and Web Mercator are understood; other coordinates (state plane feet, UTM meters) read as
  // degrees would filter on the wrong place
  if (wkid && ![4326, 102100, 3857, 900913].includes(wkid)) return null

  if (wkid === 102100 || wkid === 3857 || wkid === 900913) {
    const [xmin, ymin] = webMercatorToWgs84(coords[0], coords[1])
    const [xmax, ymax] = webMercatorToWgs84(coords[2], coords[3])
    coords = [xmin, ymin, xmax, ymax]
  }

  return coords
}

// Polygon, polyline or multipoint filter (Select by drawing, Query buffers) -> { wkt, box } in 4326, or null.
// Intersects only; other relations are left to Koop's in-memory filter.
const MAX_FILTER_VERTICES = 20000
function parseShape (geometryParam, inSR, spatialRel) {
  if (spatialRel && spatialRel !== 'esriSpatialRelIntersects') return null
  let g = geometryParam
  if (typeof g === 'string') {
    if (!g.trim().startsWith('{')) return null
    try { g = JSON.parse(g) } catch (error) { return null }
  }
  if (!g || typeof g !== 'object' || !['rings', 'paths', 'points'].some(k => Array.isArray(g[k]))) return null
  if (!g.spatialReference && parseWkid(inSR)) g = { ...g, spatialReference: { wkid: parseWkid(inSR) } }
  const wkid = g.spatialReference && (g.spatialReference.latestWkid || g.spatialReference.wkid)
  if (wkid && ![4326, 102100, 3857, 900913].includes(Number(wkid))) return null
  const vertices = (g.rings || g.paths || [g.points]).reduce((n, part) => n + (Array.isArray(part) ? part.length : 0), 0)
  if (!vertices || vertices > MAX_FILTER_VERTICES) return null
  let wkt
  try { wkt = toWkt(Number(wkid) === 900913 ? { ...g, spatialReference: { wkid: 3857 } } : g) } catch (error) { return null }
  const nums = wkt.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi).map(Number)
  const xs = nums.filter((_, i) => i % 2 === 0)
  const ys = nums.filter((_, i) => i % 2 === 1)
  return { wkt, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
}

// Build bbox filter using ST_Intersects
function buildBboxFilter (geometryString, geometryType, inSR, spatialRel) {
  try {
    const coords = parseBbox(geometryString, inSR)

    if (!coords) {
      const shape = parseShape(geometryString, inSR, spatialRel)
      if (shape) return shapeFilter(shape)
      logger.warn('Unsupported or invalid geometry filter, skipping SQL bbox filter:', geometryString)
      return null
    }

    const [xmin, ymin, xmax, ymax] = coords

    // Create bbox polygon using ST_GeomFromText
    // Note: POLYGON requires closed ring (first point = last point)
    const wkt = `POLYGON((${xmin} ${ymin}, ${xmax} ${ymin}, ${xmax} ${ymax}, ${xmin} ${ymax}, ${xmin} ${ymin}))`

    // Use ST_Intersects for bbox filtering
    // Supports WKT, WKB, and native GEOMETRY types
    const geomExpr = buildGeometryExpression()
    const intersects = `ST_Intersects(${geomExpr}, ST_GeomFromText('${wkt}', ${S().spatialReference}))`
    if (!S().bboxColumns) return intersects
    return `(_xmax >= ${xmin} AND _xmin <= ${xmax} AND _ymax >= ${ymin} AND _ymin <= ${ymax} AND ${intersects})`
  } catch (error) {
    logger.error('Error building bbox filter:', error)
    return null
  }
}

function shapeFilter ({ wkt, box: [xmin, ymin, xmax, ymax] }) {
  const intersects = `ST_Intersects(${buildGeometryExpression()}, ST_GeomFromText('${wkt}', ${S().spatialReference}))`
  if (!S().bboxColumns) return intersects
  return `(_xmax >= ${xmin} AND _xmin <= ${xmax} AND _ymax >= ${ymin} AND _ymin <= ${ymax} AND ${intersects})`
}

// Build H3 filter (legacy support for existing queries)
function buildH3Filter (query) {
  // Accept bbox from either query.bbox or query.geometry for consistency
  const bboxString = query.bbox || query.geometry
  if (!bboxString || !query.h3col || !query.h3res) {
    return null
  }

  try {
    const coords = bboxString.split(',').map(Number)

    if (coords.length !== 4 || coords.some(isNaN)) {
      throw new Error('bbox must contain exactly 4 coordinates')
    }

    // Validate h3 resolution is a valid integer between 0-15
    const h3res = parseInt(query.h3res, 10)
    if (isNaN(h3res) || h3res < 0 || h3res > 15) {
      throw new Error('h3res must be an integer between 0 and 15')
    }

    // Validate h3col is a valid column name (alphanumeric and underscore)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(query.h3col)) {
      throw new Error('h3col must be a valid column name')
    }

    // Use h3_coverash3 function for H3-based spatial indexing
    // Supports WKT, WKB, and native GEOMETRY types
    const geomExpr = buildGeometryExpression()
    return `array_contains(h3_coverash3(${geomExpr}, ${h3res}), ${query.h3col})`
  } catch (error) {
    logger.error('Error generating H3 filter:', error)
    throw error
  }
}

// Build time filter for temporal queries
// With an end field, a feature matches when its [start, end] span overlaps the requested time
function buildTimeFilter (timeParam, timeField, endField) {
  // time given twice arrives as an array: refuse it rather than drop the filter
  if (typeof timeParam !== 'string') throw Object.assign(new Error('Invalid time parameter: one "start,end" value expected'), { code: 400 })
  // Default time field if not specified
  const field = timeField || 'created_at'

  // Validate timeField column name if user-provided
  for (const f of [timeField, endField].filter(Boolean)) {
    const result = validateColumnName(f)
    if (!result.valid) {
      throw new Error(`Invalid timeField: ${result.error}`)
    }
  }
  const end = endField ? `COALESCE(${endField}, ${field})` : field

  try {
    // Time parameter format: "startTime,endTime" in milliseconds since epoch.
    // Either end may be "null" for an open-ended range (ArcGIS convention).
    // Can also be a single timestamp.
    const parts = timeParam.split(',').map(t => t.trim())
    // Not epoch milliseconds: refuse rather than drop the filter and answer for all time
    const toTimestamp = part => {
      const d = new Date(/^-?\d+(\.\d+)?$/.test(part) ? Math.trunc(Number(part)) : NaN)
      if (isNaN(d)) throw Object.assign(new Error(`Invalid time parameter: ${timeParam}`), { code: 400 })
      return d.toISOString()
    }
    const isOpen = part => part === '' || part.toLowerCase() === 'null'
    if (parts.length > 2) throw Object.assign(new Error(`Invalid time parameter: ${timeParam}`), { code: 400 })

    if (parts.length === 1 && !isOpen(parts[0])) {
      // Single timestamp - exact match (or inside the feature's span)
      const t = `TIMESTAMP '${toTimestamp(parts[0])}'`
      return endField ? `${field} <= ${t} AND ${end} >= ${t}` : `${field} = ${t}`
    } else if (parts.length === 2) {
      const hasStart = !isOpen(parts[0])
      const hasEnd = !isOpen(parts[1])
      const t0 = hasStart && `TIMESTAMP '${toTimestamp(parts[0])}'`
      const t1 = hasEnd && `TIMESTAMP '${toTimestamp(parts[1])}'`
      if (endField && (hasStart || hasEnd)) {
        return [hasEnd && `${field} <= ${t1}`, hasStart && `${end} >= ${t0}`].filter(Boolean).join(' AND ')
      }
      if (hasStart && hasEnd) {
        return `${field} BETWEEN ${t0} AND ${t1}`
      } else if (hasStart) {
        return `${field} >= ${t0}`
      } else if (hasEnd) {
        return `${field} <= ${t1}`
      }
    }

    logger.warn('Invalid time parameter format:', timeParam)
    return null
  } catch (error) {
    if (error.code === 400) throw error
    logger.error('Error building time filter:', error)
    return null
  }
}

// Sanitize ORDER BY clause by validating each field+direction pair
function sanitizeOrderBy (orderBy) {
  const parts = orderBy.split(',').map(p => p.trim()).filter(p => p)
  if (parts.length === 0) throw new Error('Invalid orderByFields parameter')

  const sanitized = parts.map(part => {
    // Match: column_name optionally followed by ASC or DESC
    const match = part.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(ASC|DESC)?$/i)
    if (!match) throw new Error(`Invalid orderByFields parameter: ${part}`)
    return match[2] ? `${match[1]} ${match[2].toUpperCase()}` : match[1]
  })

  return sanitized.join(', ')
}

// Translate results with ST_AsGeoJSON to GeoJSON
// (stringifyComplex: ArcGIS attributes must be scalars; GeoJSON clients get STRUCT/ARRAY values as JSON)
function translateWithSTFunctions (rows, query, { stringifyComplex = true } = {}) {
  const returnGeometry = query.returnGeometry !== 'false'

  return {
    type: 'FeatureCollection',
    features: rows.map(row => {
      let geometry = null

      if (returnGeometry && row.__geojson__) {
        try {
          // Parse the GeoJSON string returned by ST_AsGeoJSON
          geometry = JSON.parse(row.__geojson__)
        } catch (error) {
          logger.error('Error parsing GeoJSON from ST_AsGeoJSON:', error)
          geometry = null
        }
      }

      // Remove the __geojson__ field from properties
      const properties = { ...row }
      delete properties.__geojson__
      if (S().geometryColumn) delete properties[S().geometryColumn]
      if (S().bboxColumns) { delete properties._xmin; delete properties._ymin; delete properties._xmax; delete properties._ymax }
      // ArcGIS attributes are scalars: STRUCT/ARRAY/MAP values (e.g. Overture's names, bbox) become JSON text,
      // binary values are dropped
      for (const k of Object.keys(properties)) {
        const v = properties[k]
        if (v === null || typeof v !== 'object') continue
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) delete properties[k]
        else if (v instanceof Date) { if (stringifyComplex) properties[k] = v.getTime() } // ArcGIS dates: epoch ms
        else if (stringifyComplex) properties[k] = JSON.stringify(v, bigintToNumber)
        else properties[k] = JSON.parse(JSON.stringify(v, bigintToNumber))
      }

      return {
        type: 'Feature',
        geometry: geometry,
        properties: properties
      }
    })
  }
}

function bigintToNumber (key, x) {
  return typeof x === 'bigint' ? Number(x) : x
}

// Layer info (FeatureServer or FeatureServer/0, no /query) vs. a query
function isLayerInfoPath (url) {
  return /\/FeatureServer(\/\d+)?\/?$/.test(String(url || '').split('?')[0])
}

// One page of features: build the SQL, use the per-user cache, translate to GeoJSON. Shared by the
// Esri path (getData) and OGC API – Features (queryFeatures). Must run with the table's spec in scope.
async function runFeatureQuery (session, table, query, { userToken, warehouseId, taskId, extra = [], params = {}, stringifyComplex = true } = {}) {
  const sql = buildQuery(table, query, taskId, extra)
  logger.info(`${taskId}> Executing query: ${sql}`)
  const key = queryCacheKey(userToken, warehouseId, sql, params)
  let rows = queryCacheGet(key)
  if (rows) {
    logger.info(`${taskId}> Cache hit (${rows.length} rows)`)
  } else {
    rows = await executeAndRecord(session, sql, 'features', taskId, params)
    queryCachePut(key, rows)
  }
  logger.info(`${taskId}> Received ${rows.length} rows`)
  return { rows, geojson: translateWithSTFunctions(rows, query, { stringifyComplex }) }
}

// Calculate extent from features
function calculateExtent (features) {
  let xmin = Infinity
  let ymin = Infinity
  let xmax = -Infinity
  let ymax = -Infinity

  for (const feature of features) {
    if (!feature.geometry || !feature.geometry.coordinates) continue

    const coords = getAllCoordinates(feature.geometry)
    for (const [x, y] of coords) {
      xmin = Math.min(xmin, x)
      ymin = Math.min(ymin, y)
      xmax = Math.max(xmax, x)
      ymax = Math.max(ymax, y)
    }
  }

  if (xmin === Infinity) return null

  return {
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: {
      wkid: S().spatialReference
    }
  }
}

// Extract all coordinates from a geometry
function getAllCoordinates (geometry) {
  const coords = []

  function extractCoords (geom) {
    if (!geom) return

    if (geom.type === 'GeometryCollection') {
      if (geom.geometries) geom.geometries.forEach(g => extractCoords(g))
      return
    }

    if (!geom.coordinates) return

    switch (geom.type) {
      case 'Point':
        coords.push(geom.coordinates)
        break
      case 'LineString':
      case 'MultiPoint':
        for (const c of geom.coordinates) coords.push(c)
        break
      case 'Polygon':
      case 'MultiLineString':
        geom.coordinates.forEach(ring => { for (const c of ring) coords.push(c) })
        break
      case 'MultiPolygon':
        geom.coordinates.forEach(polygon => {
          polygon.forEach(ring => { for (const c of ring) coords.push(c) })
        })
        break
    }
  }

  extractCoords(geometry)
  return coords
}

// Helper: Map Databricks types to Esri field types
// Field types in Koop's vocabulary (it maps them to esriFieldType*; anything else becomes String), by the
// base type, so a STRUCT/ARRAY/MAP of numbers stays text. Koop has no BigInteger: BIGINT is a Double.
function mapDatabricksToEsriFieldType (databricksType) {
  const base = (databricksType || '').toLowerCase().split(/[<(]/)[0].trim()

  if (['tinyint', 'byte', 'smallint', 'short', 'int', 'integer'].includes(base)) return 'Integer'
  if (['bigint', 'long', 'double', 'float', 'real', 'decimal', 'numeric', 'dec'].includes(base)) return 'Double'
  if (['date', 'timestamp', 'timestamp_ntz', 'timestamp_ltz'].includes(base)) return 'Date'
  if (base === 'boolean') return 'SmallInteger'

  return 'String' // STRING, VARCHAR, STRUCT, ARRAY, MAP, VARIANT, ...
}

function fieldAlias (row) {
  const c = typeof row.comment === 'string' ? row.comment.trim() : ''
  return c && c.length <= 64 && !/[\r\n]/.test(c) ? c : row.col_name
}

// Helper: Get field metadata from DESCRIBE TABLE with TTL-based caching
Model.prototype.getFieldMetadata = async function (table, session, taskId, who = 'app') {
  const cacheKey = `${who}|${table}`
  // Check cache first (with TTL)
  const cached = this.fieldsCache[cacheKey]
  if (cached && (Date.now() - cached.timestamp < cacheTTLMs)) {
    logger.info(`${taskId}> Using cached field metadata for ${table}`)
    return cached.data
  }

  try {
    logger.info(`${taskId}> Fetching field metadata with DESCRIBE ${table}`)
    const rows = await executeAndRecord(session, `DESCRIBE ${table}`, 'describe', taskId)

    // DESCRIBE lists the real columns first; a blank row or '# Partition
    // Information' header starts the metadata sections, which repeat column
    // names — stop there to avoid duplicate field definitions.
    const columnRows = []
    for (const row of rows) {
      if (!row.col_name || row.col_name.startsWith('#')) break
      columnRows.push(row)
    }

    const derived = S().objectIdExpr
      ? [{ name: S().objectId, type: 'Integer', alias: S().objectId, sqlType: 'bigint', nullable: false, editable: false, domain: null, defaultValue: null }]
      : []
    const fields = derived.concat(columnRows
      .filter(row => row.col_name !== S().geometryColumn && !(S().bboxColumns && /^_[xy](min|max)$/.test(row.col_name)))
      .map(row => ({
        name: row.col_name,
        type: mapDatabricksToEsriFieldType(row.data_type),
        // The column's Unity Catalog comment is its display title (one line, short), else the name
        alias: fieldAlias(row),
        sqlType: row.data_type,
        nullable: true,
        editable: false,
        domain: null,
        defaultValue: null
      })))

    // Evict oldest entries if cache exceeds max size
    const keys = Object.keys(this.fieldsCache)
    if (keys.length >= CACHE_MAX_ENTRIES) {
      let oldestKey = keys[0]
      let oldestTime = this.fieldsCache[oldestKey].timestamp
      for (let i = 1; i < keys.length; i++) {
        if (this.fieldsCache[keys[i]].timestamp < oldestTime) {
          oldestKey = keys[i]
          oldestTime = this.fieldsCache[keys[i]].timestamp
        }
      }
      delete this.fieldsCache[oldestKey]
    }

    // Cache the result with timestamp
    this.fieldsCache[cacheKey] = { data: fields, timestamp: Date.now() }
    logger.info(`${taskId}> Cached ${fields.length} field definitions for ${table}`)

    return fields
  } catch (error) {
    logger.error(`${taskId}> Error fetching field metadata: ${error.message}`)
    return [] // Return empty array on error, don't fail the whole request
  }
}

// OGC API – Features: one page of a table as GeoJSON, run as the caller.
//   bbox: list of [xmin, ymin, xmax, ymax] boxes in 4326 (OR-ed; two when crossing the antimeridian)
//   propertyFilters: [{ column, type }] with values in params (names checked by the caller against DESCRIBE)
//   time: { field, startMs, endMs } (either end may be null)
//   cursor: last objectId of the previous page (keyset paging); featureId: one feature
// Returns { features, numberMatched?, lastId, spec }; throws err.code 400 for tables that can't be served.
async function queryFeatures ({ table, userToken, warehouseId, bbox = [], propertyFilters = [], params = {}, time, featureId, limit, offset = 0, cursor, count = 'none', taskId = uuidv4(), protocol = 'ogc', service }) {
  if (!isValidTableName(table)) throw Object.assign(new Error('Invalid table name'), { code: 400 })
  if (layerSpec.isOpenTable(table)) { userToken = null; warehouseId = undefined } // open tables: read as the app
  const session = taggedSession(await connectionManager.getSession(userToken, warehouseId), protocol, service && `service=${service}`)
  try {
    const who = layerSpec.whoOf(userToken)
    const spec = await layerSpec.resolveSpec(table, (sql, kind) => executeAndRecord(session, sql, kind, taskId), who)
    if (!spec) throw Object.assign(new Error(`${table} has no usable geometry or id`), { code: 400 })
    return await layerSpec.store.run(spec, async () => {
      const extra = []
      const p = { ...params }
      const boxes = bbox.map(b => buildBboxFilter(b.join(','), null, '4326')).filter(Boolean)
      if (boxes.length) extra.push(boxes.length === 1 ? boxes[0] : `(${boxes.join(' OR ')})`)
      for (const f of propertyFilters) extra.push(f.clause)
      if (time && time.field) {
        if (!validateColumnName(time.field).valid) throw Object.assign(new Error('Invalid time field'), { code: 400 })
        const clause = buildTimeFilter(`${time.startMs ?? 'null'},${time.endMs ?? 'null'}`, time.field)
        if (clause) extra.push(clause)
      }
      // numberMatched counts the filters only, not the paging clauses added below
      const filterOnly = { extra: [...extra], params: { ...p } }
      const idCol = S().objectId
      const keyset = cursor !== undefined && cursor !== null
      if (featureId !== undefined) { extra.push(`${idCol} = CAST(:fid AS BIGINT)`); p.fid = String(featureId) }
      if (keyset) { extra.push(`${idCol} > CAST(:cursor AS BIGINT)`); p.cursor = String(cursor) }
      const query = { resultRecordCount: String(limit || maxRows), resultOffset: String(keyset ? 0 : offset), outFields: '*' }
      const { geojson } = await runFeatureQuery(session, table, query, { userToken, warehouseId, taskId, extra, params: p, stringifyComplex: false })
      const features = geojson.features.map(f => ({ type: 'Feature', id: f.properties[idCol], geometry: f.geometry, properties: f.properties }))
      const out = { features, lastId: features.length ? features[features.length - 1].id : null, spec, idField: idCol }
      if (count === 'auto') {
        const n = await countMatched(table, session, taskId, who, filterOnly.extra, filterOnly.params)
        // (a failed table count comes back as 0; never report fewer matches than this page shows)
        if (n !== null && n !== undefined && n >= (keyset ? features.length : offset + features.length)) out.numberMatched = n
      }
      return out
    })
  } finally {
    try { await session.close() } catch (e) {}
  }
}

// numberMatched: the cached table count when nothing filters, else a COUNT (only for tables small enough
// that it stays quick). null = unknown.
async function countMatched (table, session, taskId, who, extra, params) {
  if (!extra.length) return tableCount(table, session, taskId, who)
  const total = await tableCount(table, session, taskId, who)
  if (total > BIG_TABLE_FEATURES) return null
  const sql = buildCountQuery(table, {}, extra)
  const key = queryCacheKey(who, '', sql, params)
  const hit = queryCacheGet(key)
  if (hit) return Number(hit[0]?.cnt || 0)
  const rows = await executeAndRecord(session, sql, 'count', taskId, params)
  queryCachePut(key, rows)
  return Number(rows[0]?.cnt || 0)
}

// OGC collection metadata for one table: spec, fields (with SQL types), extent, count and time range
const temporalCache = new Map()
async function collectionInfo ({ table, userToken, warehouseId, timeField, taskId = uuidv4(), protocol = 'ogc', service }) {
  if (!isValidTableName(table)) throw Object.assign(new Error('Invalid table name'), { code: 400 })
  if (layerSpec.isOpenTable(table)) { userToken = null; warehouseId = undefined } // open tables: read as the app
  const session = taggedSession(await connectionManager.getSession(userToken, warehouseId), protocol, service && `service=${service}`)
  try {
    const who = layerSpec.whoOf(userToken)
    const spec = await layerSpec.resolveSpec(table, (sql, kind) => executeAndRecord(session, sql, kind, taskId), who)
    if (!spec) throw Object.assign(new Error(`${table} has no usable geometry or id`), { code: 400 })
    return await layerSpec.store.run(spec, async () => {
      const fields = await Model.prototype.getFieldMetadata.call({ fieldsCache }, table, session, taskId, who)
      const extent = await tableExtent(table, session, taskId, who)
      const count = await tableCount(table, session, taskId, who)
      let temporal = null
      if (timeField && validateColumnName(timeField).valid) {
        const key = `${who}|${table}|${timeField}`
        const hit = temporalCache.get(key)
        if (hit && Date.now() - hit.at < cacheTTLMs * 6) {
          temporal = hit.value
        } else {
          try {
            const rows = await executeAndRecord(session, `SELECT MIN(${timeField}) AS t0, MAX(${timeField}) AS t1 FROM ${S().source || table}`, 'temporal', taskId)
            const iso = v => (v === null || v === undefined) ? null : new Date(v).toISOString()
            temporal = [iso(rows[0]?.t0), iso(rows[0]?.t1)]
            temporalCache.set(key, { value: temporal, at: Date.now() })
          } catch (e) {
            logger.warn(`${taskId}> Time range failed for ${table}: ${e.message}`)
          }
        }
      }
      return { spec, idField: S().objectId, fields, extent, count, temporal }
    })
  } finally {
    try { await session.close() } catch (e) {}
  }
}

module.exports = Model

// Recently executed queries (ring buffer) for diagnostics and demo UIs
Model.recentQueries = recentQueries
Model.forgetTable = forgetTable
Model.queryFeatures = queryFeatures
Model.collectionInfo = collectionInfo
Model.checkRateLimit = checkRateLimit

// Export internal functions for unit testing only
Model._internals = {
  isValidTableName,
  buildGeometryExpression,
  pushValidatedWhere,
  buildCountQuery,
  buildIdsQuery,
  buildExtentQuery,
  buildQuery,
  buildSelectClause,
  simplifyTolerance,
  buildWhereClauses,
  buildBboxFilter,
  parseBbox,
  parseShape,
  parseLayerProps,
  webMercatorToWgs84,
  parseResultRecordCount,
  parseResultOffset,
  buildH3Filter,
  buildTimeFilter,
  sanitizeOrderBy,
  translateWithSTFunctions,
  calculateExtent,
  getAllCoordinates,
  mapDatabricksToEsriFieldType,
  checkRateLimit,
  executeAndRecord,
  taggedSession,
  isLayerInfoPath,
  runFeatureQuery,
  parseStatistics,
  buildStatisticsQuery,
  buildDistinctQuery,
  buildDistinctCountQuery,
  scalarAttributes,
  queryCacheKey,
  queryCacheGet,
  queryCachePut,
  queryCacheStats,
  forgetTable,
  countMatched
}
