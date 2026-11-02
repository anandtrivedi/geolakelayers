/*
  listing.js — the metadata query behind the catalog listing (server.js listTables), kept pure so it can be tested

  Lists every table with a GEOMETRY/GEOGRAPHY column (by type, whatever it's called) in the catalogs in scope,
  with its primary key column when the key is a single integer column. That is the same rule spec.js applies
  when it resolves a table (a string key gives a derived, read-only id), so what the listing says about a
  table's id is what the layer will have. information_schema spells BIGINT as `long`.
*/

// Integer types as information_schema.columns reports them (lower case); BIGINT appears as `long`
const INTEGER_KEY_TYPES = ['tinyint', 'smallint', 'int', 'integer', 'bigint', 'long']

// Catalog names are plain identifiers by the time they get here (requestedCatalogs, EXCLUDE_CATALOGS); a stray
// quote is dropped rather than escaped so the predicate can never be broken out of
const quote = names => names.map(c => `'${String(c).replace(/'/g, '')}'`).join(',')

/** The listing SQL for the catalogs in scope (scoped = [] means every catalog the caller can see). */
function listingSql ({ scoped = [], excludeCatalogs = [] } = {}) {
  const where = col => [
    scoped.length ? `${col} IN (${quote(scoped)})` : null,
    excludeCatalogs.length ? `${col} NOT IN (${quote(excludeCatalogs)})` : null
  ].filter(Boolean).join(' AND ') || 'TRUE'
  return `
    WITH g AS (
      SELECT table_catalog cat, table_schema sch, table_name tbl, min(column_name) geom, min(lower(data_type)) dt
      FROM system.information_schema.columns
      WHERE ${where('table_catalog')} AND table_schema <> 'information_schema' AND table_name NOT LIKE '\\_\\_%'
        AND (lower(data_type) LIKE 'geometry%' OR lower(data_type) LIKE 'geography%')
      GROUP BY 1, 2, 3
    ),
    pk AS (
      SELECT t.table_catalog cat, t.table_schema sch, t.table_name tbl, min(k.column_name) col, count(*) n, min(lower(c.data_type)) dt
      FROM system.information_schema.table_constraints t
      JOIN system.information_schema.key_column_usage k
        ON k.constraint_catalog = t.constraint_catalog AND k.constraint_schema = t.constraint_schema AND k.constraint_name = t.constraint_name
      LEFT JOIN system.information_schema.columns c
        ON c.table_catalog = k.table_catalog AND c.table_schema = k.table_schema AND c.table_name = k.table_name AND c.column_name = k.column_name
      WHERE ${where('t.table_catalog')} AND t.constraint_type = 'PRIMARY KEY'
      GROUP BY 1, 2, 3
    )
    SELECT g.cat, g.sch, g.tbl, g.geom, g.dt,
      CASE WHEN pk.n = 1 AND pk.dt IN (${quote(INTEGER_KEY_TYPES)}) THEN pk.col END AS pk
    FROM g LEFT JOIN pk ON pk.cat = g.cat AND pk.sch = g.sch AND pk.tbl = g.tbl
    ORDER BY 1, 2, 3`
}

module.exports = { listingSql, INTEGER_KEY_TYPES }
