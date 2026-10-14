/*
  overrides.js — authors' choices for tables whose geometry or id can't be detected (or was detected
  wrongly): which column holds the geometry (and its SRID), which two columns are lon/lat, which column is
  the object id. Kept in a Unity Catalog table (LAYER_OVERRIDES_TABLE) so every user and every gateway
  instance sees the same layer.

  Everyone needs SELECT on that table (setup grants it to account users); changing an override needs
  MODIFY, which a Unity Catalog admin grants to the people who curate layers. Reads and writes run as the
  caller, like everything else.
*/

const { THREE_PART, PLAIN } = require('./http')

const TTL_MS = parseInt(process.env.OVERRIDE_TTL_MS) || 60000
const FIELDS = ['geometryColumn', 'srid', 'lonColumn', 'latColumn', 'idColumn']

class OverrideError extends Error {
  constructor (status, message) { super(message); this.status = status }
}

/** Check and normalize an override from the console. Throws OverrideError(400). */
function validateOverride (body) {
  const b = body || {}
  const out = {}
  for (const k of ['geometryColumn', 'lonColumn', 'latColumn', 'idColumn']) {
    const v = b[k] === undefined || b[k] === null ? '' : String(b[k]).trim()
    if (v && !PLAIN.test(v)) throw new OverrideError(400, `${k} must be a plain column name`)
    out[k] = v || null
  }
  if (out.geometryColumn && (out.lonColumn || out.latColumn)) throw new OverrideError(400, 'Pick either a geometry column or lon/lat columns, not both')
  if (!!out.lonColumn !== !!out.latColumn) throw new OverrideError(400, 'Longitude and latitude columns go together')
  if (out.lonColumn && out.lonColumn === out.latColumn) throw new OverrideError(400, 'Longitude and latitude must be different columns')
  const srid = b.srid === undefined || b.srid === null || b.srid === '' ? null : Number(b.srid)
  if (srid !== null && !(Number.isInteger(srid) && srid > 0 && srid < 1000000)) throw new OverrideError(400, 'srid must be an EPSG code')
  out.srid = srid
  if (!FIELDS.some(k => out[k])) throw new OverrideError(400, 'Nothing to override')
  return out
}

function fromRow (r) {
  return {
    geometryColumn: r.geometry_column || null,
    srid: r.geometry_srid === null || r.geometry_srid === undefined ? null : Number(r.geometry_srid),
    lonColumn: r.lon_column || null,
    latColumn: r.lat_column || null,
    idColumn: r.id_column || null,
    updatedBy: r.updated_by || null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null
  }
}

function createTableSql (table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  table_name STRING NOT NULL COMMENT 'catalog.schema.table',
  geometry_column STRING, geometry_srid INT, lon_column STRING, lat_column STRING, id_column STRING,
  updated_by STRING, updated_at TIMESTAMP
) COMMENT 'LakeGate layer overrides: geometry and id columns for tables that are not detected automatically'
TBLPROPERTIES ('lakegate.layer_overrides' = 'true')`
}

const notSetUp = err => /TABLE_OR_VIEW_NOT_FOUND|cannot be found|does not exist/i.test(err?.message || '')

/**
 * Store bound to one table. run(sql, params) runs SQL (as the caller) and returns rows. All overrides are
 * read in one query and cached briefly (there are few, and the catalog listing needs all of them).
 */
function createOverrideStore ({ table }) {
  if (!THREE_PART.test(table || '')) throw new Error('Layer overrides table must be catalog.schema.table')
  let cache = null // { at, map }
  let missing = false
  return {
    table,
    /** All overrides as Map(table -> override); empty when the table doesn't exist yet. */
    async all (run) {
      if (cache && Date.now() - cache.at < TTL_MS) return cache.map
      let rows = []
      try {
        rows = await run(`SELECT table_name, geometry_column, geometry_srid, lon_column, lat_column, id_column, updated_by, updated_at FROM ${table}`)
        missing = false
      } catch (err) {
        if (!notSetUp(err)) throw err
        missing = true
      }
      const map = new Map(rows.filter(r => THREE_PART.test(r.table_name || '')).map(r => [r.table_name, fromRow(r)]))
      cache = { at: Date.now(), map }
      return map
    },
    get missing () { return missing },
    async get (run, name) {
      return (await this.all(run)).get(name) || null
    },
    async put (run, name, o) {
      if (!THREE_PART.test(name)) throw new OverrideError(400, 'catalog.schema.table expected')
      // Empty strings stand for "not set" (named parameters can't be NULL)
      const v = p => `NULLIF(:${p}, '')`
      await run(`MERGE INTO ${table} AS t USING (SELECT :name AS table_name) AS s ON t.table_name = s.table_name
        WHEN MATCHED THEN UPDATE SET geometry_column = ${v('geom')}, geometry_srid = CAST(${v('srid')} AS INT), lon_column = ${v('lon')}, lat_column = ${v('lat')}, id_column = ${v('id')}, updated_by = current_user(), updated_at = current_timestamp()
        WHEN NOT MATCHED THEN INSERT (table_name, geometry_column, geometry_srid, lon_column, lat_column, id_column, updated_by, updated_at)
          VALUES (:name, ${v('geom')}, CAST(${v('srid')} AS INT), ${v('lon')}, ${v('lat')}, ${v('id')}, current_user(), current_timestamp())`,
      { name, geom: o.geometryColumn || '', srid: o.srid ? String(o.srid) : '', lon: o.lonColumn || '', lat: o.latColumn || '', id: o.idColumn || '' })
      cache = null
    },
    async remove (run, name) {
      if (!THREE_PART.test(name)) throw new OverrideError(400, 'catalog.schema.table expected')
      await run(`DELETE FROM ${table} WHERE table_name = :name`, { name })
      cache = null
    },
    async setup (run) {
      await run(createTableSql(table))
      // Every gateway user reads overrides (they decide how a table draws for everyone)
      await run(`GRANT SELECT ON TABLE ${table} TO \`account users\``)
      cache = null
    },
    forget () { cache = null }
  }
}

module.exports = { validateOverride, createOverrideStore, createTableSql, fromRow, OverrideError, notSetUp }
