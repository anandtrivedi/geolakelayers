/*
  services.js — OGC services: named sets of tables, kept in a Unity Catalog table (OGC_SERVICES_TABLE)

  Every read and write runs as the caller, so UC grants on that table decide who can see services
  (SELECT) and who can define them (MODIFY). Reading a service's features still needs SELECT on each table.
*/

const crypto = require('crypto')
const { PLAIN, THREE_PART } = require('../lib/http')
const { OgcError } = require('./params')
const { explain } = require('../lib/errors')

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const COLLECTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_COLLECTIONS = 50
const TTL_MS = parseInt(process.env.OGC_SERVICE_TTL_MS) || 60000

const invalid = message => new OgcError(400, 'InvalidParameterValue', message)

/** Check and normalize a service definition from the console. Throws a 400 OgcError. */
function validateService (body, name) {
  const b = body || {}
  const n = String(name ?? b.name ?? '')
  if (!NAME.test(n)) throw invalid('Service name: lowercase letters, digits, - and _, up to 63 characters, starting with a letter or digit')
  const title = String(b.title || n)
  const description = String(b.description || '')
  if (title.length > 200) throw invalid('Title is longer than 200 characters')
  if (description.length > 2000) throw invalid('Description is longer than 2000 characters')
  const list = Array.isArray(b.collections) ? b.collections : []
  if (!list.length) throw invalid('Pick at least one table')
  if (list.length > MAX_COLLECTIONS) throw invalid(`At most ${MAX_COLLECTIONS} tables per service`)
  const ids = new Set()
  const collections = list.map(c => {
    const table = String(c?.table || '')
    if (!THREE_PART.test(table)) throw invalid(`${table || '(empty)'} is not catalog.schema.table`)
    const id = String(c.id || defaultCollectionId(table, list))
    if (!COLLECTION_ID.test(id)) throw invalid(`Collection id ${id}: letters, digits, - and _, up to 64 characters`)
    if (ids.has(id)) throw invalid(`Collection id ${id} is used twice`)
    ids.add(id)
    const timeField = c.timeField ? String(c.timeField) : null
    if (timeField && !PLAIN.test(timeField)) throw invalid(`Time field ${timeField} is not a plain column name`)
    const t = String(c.title || table.split('.')[2])
    if (t.length > 200) throw invalid(`Title for ${table} is longer than 200 characters`)
    return { id, table, title: t, description: String(c.description || '').slice(0, 2000), timeField }
  })
  // Engine: the warehouse this service's reads run on ('' = the gateway's bound warehouse)
  const warehouse = b.warehouse ? String(b.warehouse) : ''
  if (warehouse && !/^[a-f0-9]{8,32}$/i.test(warehouse)) throw invalid('warehouse must be a warehouse id')
  return { name: n, title, description, collections, warehouse }
}

// Table name, or schema_table when two picked tables share a name
function defaultCollectionId (table, list) {
  const [, schema, name] = table.split('.')
  const clash = list.filter(c => String(c?.table || '').split('.')[2] === name).length > 1
  return clash ? `${schema}_${name}` : name
}

// Parse a stored row; rows that don't hold a valid definition are skipped rather than breaking the list
function fromRow (row) {
  try {
    const collections = JSON.parse(row.collections)
    const s = validateService({ title: row.title, description: row.description, collections, warehouse: row.warehouse || '' }, row.name)
    return {
      ...s,
      owner: row.owner || null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      version: Number(row.version || 1)
    }
  } catch (e) {
    return null
  }
}

const COLUMNS = 'name, title, description, collections, warehouse, owner, created_at, updated_by, updated_at, version'
const OLD_COLUMNS = COLUMNS.replace('warehouse, ', '')

function createTableSql (table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  name STRING NOT NULL, title STRING, description STRING,
  collections STRING NOT NULL COMMENT 'JSON [{id, table, title, description, timeField}]',
  warehouse STRING COMMENT 'warehouse id for reads; empty = the gateway bound warehouse',
  owner STRING, created_at TIMESTAMP, updated_by STRING, updated_at TIMESTAMP, version BIGINT
) COMMENT 'GeoLakeLayers OGC API services' TBLPROPERTIES ('geolakelayers.ogc_services' = 'true')`
}

// Tables created before the engine setting have no warehouse column
const noWarehouseColumn = err => /UNRESOLVED_COLUMN|cannot be resolved|cannot resolve/i.test(err?.message || '') && /warehouse/i.test(err?.message || '')
const notSetUp = err => /TABLE_OR_VIEW_NOT_FOUND|cannot be found|does not exist/i.test(err?.message || '')
const denied = err => /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have .* privilege|not authorized/i.test(err?.message || '')

/**
 * Store bound to one table. run(req, sql, params, warehouse) runs SQL as the caller and returns rows
 * (warehouse undefined = the gateway's default). allowed(warehouse) says whether a warehouse may be used.
 */
function createStore ({ table, run, obo, allowed = () => false }) {
  if (!THREE_PART.test(table || '')) throw new Error('OGC services table must be catalog.schema.table')
  const cache = new Map() // `${who}|list` or `${who}|${name}` -> { value, at }
  // A service's own definition is read on its engine, once some read has shown which one that is, so
  // requests to a Lakehouse//RT service don't wake the regular warehouse for the lookup. The engine id
  // isn't private (anyone who can read the row sees it), and the read still runs as the caller.
  const engines = new Map() // name -> warehouse id
  const engineOf = name => { const w = engines.get(name); return w && allowed(w) ? w : undefined }
  const learn = s => { if (s) { if (s.warehouse) engines.set(s.name, s.warehouse); else engines.delete(s.name) } return s }
  const whoOf = req => crypto.createHash('sha256').update(obo(req) || 'app').digest('hex').slice(0, 32)
  const remember = async (req, key, fn) => {
    const k = `${whoOf(req)}|${key}`
    const hit = cache.get(k)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value
    const value = await fn()
    cache.set(k, { value, at: Date.now() })
    if (cache.size > 5000) cache.delete(cache.keys().next().value)
    return value
  }
  const forget = name => {
    for (const k of cache.keys()) if (k.endsWith('|list') || k.endsWith(`|${name}`)) cache.delete(k)
  }
  // Read with the warehouse column, or without it on a table from before the engine setting
  const select = async (req, where, params, warehouse) => {
    try {
      return await run(req, `SELECT ${COLUMNS} FROM ${table}${where}`, params, warehouse)
    } catch (err) {
      if (noWarehouseColumn(err)) return run(req, `SELECT ${OLD_COLUMNS} FROM ${table}${where}`, params)
      // The engine may be unusable for this caller (no CAN USE); the default warehouse decides
      if (warehouse) return select(req, where, params)
      throw err
    }
  }
  // Writes add the column first if the table predates it (needs MODIFY, which writers have)
  const write = async (req, sql, params) => {
    try {
      return await run(req, sql, params)
    } catch (err) {
      if (!noWarehouseColumn(err)) throw err
      await run(req, `ALTER TABLE ${table} ADD COLUMNS (warehouse STRING COMMENT 'warehouse id for reads; empty = the gateway bound warehouse')`)
      return run(req, sql, params)
    }
  }
  const wrap = err => {
    if (err instanceof OgcError) return err
    if (notSetUp(err)) return Object.assign(new OgcError(404, 'NotSetUp', `The OGC services table ${table} does not exist yet`), { setup: true })
    if (denied(err)) return new OgcError(403, 'Forbidden', explain(err).message)
    return new OgcError(500, 'ServerError', (err?.message || String(err)).split('\n')[0].slice(0, 300))
  }

  return {
    table,
    async list (req) {
      try {
        return await remember(req, 'list', async () =>
          (await select(req, ' ORDER BY name')).map(fromRow).filter(Boolean).map(learn))
      } catch (err) { throw wrap(err) }
    },
    async get (req, name) {
      if (!NAME.test(String(name || ''))) return null
      try {
        return await remember(req, name, async () => {
          const rows = await select(req, ' WHERE name = :name', { name }, engineOf(name))
          return rows.length ? learn(fromRow(rows[0])) : null
        })
      } catch (err) { throw wrap(err) }
    },
    async create (req, def) {
      try {
        const exists = await run(req, `SELECT 1 AS x FROM ${table} WHERE name = :name`, { name: def.name })
        if (exists.length) throw new OgcError(409, 'Conflict', `A service named ${def.name} already exists`)
        await write(req, `INSERT INTO ${table} (${COLUMNS}) VALUES (:name, :title, :description, :collections, NULLIF(:warehouse, ''), current_user(), current_timestamp(), current_user(), current_timestamp(), 1)`,
          { name: def.name, title: def.title, description: def.description, collections: JSON.stringify(def.collections), warehouse: def.warehouse || '' })
        forget(def.name)
      } catch (err) { throw wrap(err) }
    },
    async update (req, def, version) {
      if (!Number.isSafeInteger(Number(version))) throw invalid('version is required to update a service')
      try {
        const rows = await write(req, `UPDATE ${table} SET title = :title, description = :description, collections = :collections, warehouse = NULLIF(:warehouse, ''), updated_by = current_user(), updated_at = current_timestamp(), version = version + 1 WHERE name = :name AND version = CAST(:version AS BIGINT)`,
          { name: def.name, title: def.title, description: def.description, collections: JSON.stringify(def.collections), warehouse: def.warehouse || '', version: String(version) })
        forget(def.name)
        if (Number(rows[0]?.num_affected_rows ?? 1) === 0) throw new OgcError(409, 'Conflict', `${def.name} was changed by someone else (or deleted); reload it and try again`)
      } catch (err) { throw wrap(err) }
    },
    async remove (req, name) {
      if (!NAME.test(String(name || ''))) throw invalid('Bad service name')
      try {
        const rows = await run(req, `DELETE FROM ${table} WHERE name = :name`, { name })
        forget(name)
        if (Number(rows[0]?.num_affected_rows ?? 1) === 0) throw new OgcError(404, 'NotFound', `No service named ${name}`)
      } catch (err) { throw wrap(err) }
    },
    async setup (req) {
      try {
        await run(req, createTableSql(table))
        forget('')
      } catch (err) { throw wrap(err) }
    },
    _cache: cache,
    _engines: engines
  }
}

module.exports = { NAME, COLLECTION_ID, MAX_COLLECTIONS, validateService, defaultCollectionId, fromRow, createTableSql, createStore, notSetUp, denied }
