/*
  params.js — parse and check OGC API – Features query parameters. Anything malformed or unknown is a 400
  (the standard requires rejecting unknown parameters), so a typo never silently returns the whole table.
*/

const { CRS84, EPSG3857, SUPPORTED, toWgs84 } = require('./crs')

class OgcError extends Error {
  constructor (status, code, description) {
    super(description)
    this.status = status
    this.code = code
  }
}
const bad = description => new OgcError(400, 'InvalidParameterValue', description)

const ITEM_PARAMS = ['bbox', 'bbox-crs', 'crs', 'limit', 'offset', 'cursor', 'datetime', 'f']
const MAX_PROPERTY_FILTERS = 10

function one (query, name) {
  const v = query[name]
  if (Array.isArray(v)) throw bad(`${name} given more than once`)
  return v === undefined ? undefined : String(v)
}

function parseFormat (query) {
  const f = one(query, 'f')
  if (f !== undefined && !['json', 'geojson'].includes(f.toLowerCase())) throw bad(`f=${f} is not supported (json)`)
}

function parseCrs (value, name) {
  if (value === undefined || value === '') return CRS84
  const v = value.replace(/^\[|\]$/g, '')
  const known = { 'EPSG:3857': EPSG3857, 'EPSG:4326': null, 'OGC:CRS84': CRS84, CRS84 }
  const uri = SUPPORTED.includes(v) ? v : known[v]
  if (!uri) throw bad(`${name} ${value} is not supported; use ${SUPPORTED.join(' or ')}`)
  return uri
}

// bbox: 4 numbers (or 6 with z, which is ignored). Returned as one or two boxes in CRS84: a box whose
// west edge is east of its east edge crosses the antimeridian and is split in two.
function parseBbox (value, bboxCrs) {
  if (value === undefined) return []
  const n = value.split(',').map(s => s.trim()).map(s => s === '' ? NaN : Number(s))
  if (!(n.length === 4 || n.length === 6) || n.some(x => !Number.isFinite(x))) throw bad('bbox must be 4 (or 6) numbers: minx,miny,maxx,maxy')
  let [x0, y0, x1, y1] = n.length === 6 ? [n[0], n[1], n[3], n[4]] : n
  if (bboxCrs === EPSG3857) {
    ;[x0, y0] = toWgs84([x0, y0])
    ;[x1, y1] = toWgs84([x1, y1])
  } else if (x0 < -180 || x0 > 180 || x1 < -180 || x1 > 180 || y0 < -90 || y0 > 90 || y1 < -90 || y1 > 90) {
    throw bad('bbox is outside -180,-90,180,90')
  }
  if (y0 > y1) throw bad('bbox miny is greater than maxy')
  if (x0 > x1) return [[x0, y0, 180, y1], [-180, y0, x1, y1]]
  return [[x0, y0, x1, y1]]
}

function parseInteger (value, name, min) {
  if (value === undefined || value === '') return undefined
  if (!/^-?\d+$/.test(value)) throw bad(`${name} must be an integer`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min) throw bad(`${name} must be ${min} or more`)
  return n
}

// Limit: values above the maximum are lowered to it (the standard says so); below 1 is an error
function parseLimit (value, { defaultLimit, maxLimit }) {
  const n = parseInteger(value, 'limit', 1)
  return n === undefined ? defaultLimit : Math.min(n, maxLimit)
}

// RFC 3339 date-time or full date; returns epoch ms of its start and (for a date) its end
function parseInstant (s, name) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`)
    if (Number.isNaN(t)) throw bad(`${name} ${s} is not a date`)
    return { start: t, end: t + 86400000 - 1 }
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(s)) throw bad(`${name} ${s} is not an RFC 3339 date-time`)
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw bad(`${name} ${s} is not a date-time`)
  return { start: t, end: t }
}

// datetime: instant, start/end, ../end, start/.. (open ends may also be empty)
function parseDatetime (value) {
  if (value === undefined) return undefined
  const parts = value.split('/')
  if (parts.length === 1) {
    const { start, end } = parseInstant(parts[0], 'datetime')
    return { startMs: start, endMs: end }
  }
  if (parts.length !== 2) throw bad('datetime must be an instant or an interval start/end')
  const open = p => p === '' || p === '..'
  if (open(parts[0]) && open(parts[1])) throw bad('datetime interval needs at least one end')
  const startMs = open(parts[0]) ? null : parseInstant(parts[0], 'datetime').start
  const endMs = open(parts[1]) ? null : parseInstant(parts[1], 'datetime').end
  if (startMs !== null && endMs !== null && startMs > endMs) throw bad('datetime start is after its end')
  return { startMs, endMs }
}

/**
 * Parse an items request. queryables: [{ name, sqlType }] the collection allows as ?name=value filters.
 * Returns { bbox, crs, limit, offset, cursor, datetime, filters: [{ clause, column }], params }.
 */
function parseItemsQuery (query, { queryables = [], hasTime = false, defaultLimit = 100, maxLimit = 4000 } = {}) {
  const allowed = new Set([...ITEM_PARAMS, ...queryables.map(q => q.name)])
  for (const k of Object.keys(query)) if (!allowed.has(k)) throw bad(`Unknown parameter ${k}`)
  parseFormat(query)
  const crs = parseCrs(one(query, 'crs'), 'crs')
  const bbox = parseBbox(one(query, 'bbox'), parseCrs(one(query, 'bbox-crs'), 'bbox-crs'))
  const limit = parseLimit(one(query, 'limit'), { defaultLimit, maxLimit })
  const offset = parseInteger(one(query, 'offset'), 'offset', 0) || 0
  const cursor = parseInteger(one(query, 'cursor'), 'cursor', Number.MIN_SAFE_INTEGER)
  const datetimeValue = one(query, 'datetime')
  if (datetimeValue !== undefined && !hasTime) throw bad('This collection has no time field, so datetime is not supported')
  const datetime = parseDatetime(datetimeValue)

  const filters = []
  const params = {}
  for (const q of queryables) {
    const v = one(query, q.name)
    if (v === undefined) continue
    if (filters.length >= MAX_PROPERTY_FILTERS) throw bad(`At most ${MAX_PROPERTY_FILTERS} property filters`)
    const p = `p${filters.length}`
    params[p] = v
    filters.push({ column: q.name, clause: `${q.name} = CAST(:${p} AS ${q.sqlType.toUpperCase()})` })
  }
  return { bbox, crs, limit, offset, cursor, datetime, filters, params }
}

// Columns usable as ?name=value filters: plain names with scalar types
const SCALAR_TYPE = /^(string|varchar\(\d+\)|char\(\d+\)|tinyint|smallint|int|integer|bigint|float|double|decimal(\(\d+(,\s*\d+)?\))?|boolean|date|timestamp|timestamp_ntz)$/i
const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/
function queryablesOf (fields, reserved = ITEM_PARAMS) {
  return fields
    .filter(f => PLAIN.test(f.name) && SCALAR_TYPE.test(String(f.sqlType || '').trim()) && !reserved.includes(f.name))
    .map(f => ({ name: f.name, sqlType: String(f.sqlType).trim() }))
}

module.exports = { OgcError, bad, ITEM_PARAMS, parseFormat, parseCrs, parseBbox, parseLimit, parseInteger, parseDatetime, parseItemsQuery, queryablesOf }
