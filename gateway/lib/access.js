/*
  access.js — can the signed-in user do this, before they try?

  Reads the catalog's information_schema (grants on the table, its schema and its catalog, plus owners) and
  keeps the rows that apply to the caller: granted to them, or to a group they're in. Unity Catalog
  privileges inherit downward, so a schema- or catalog-level grant counts for a table.

  It's a hint, not a gate: metastore admins and some indirect grants don't show in information_schema, so
  "not found" means "we found no grant", and the action itself still decides. The console uses it to warn
  before a write; the write's own error is explained by errors.js.
*/

const { PLAIN } = require('./http')

// What each action needs, and at which levels a grant counts
const NEEDS = {
  SELECT: [['SELECT', ['table', 'schema', 'catalog']], ['USE_SCHEMA', ['schema', 'catalog']], ['USE_CATALOG', ['catalog']]],
  MODIFY: [['MODIFY', ['table', 'schema', 'catalog']], ['USE_SCHEMA', ['schema', 'catalog']], ['USE_CATALOG', ['catalog']]],
  CREATE_TABLE: [['CREATE_TABLE', ['schema', 'catalog']], ['USE_SCHEMA', ['schema', 'catalog']], ['USE_CATALOG', ['catalog']]]
}
const LEVELS = ['table', 'schema', 'catalog']

/** Parse "catalog.schema" or "catalog.schema.table" into its parts; null if not plain identifiers. */
function target (name) {
  const parts = String(name || '').split('.')
  if (parts.length < 2 || parts.length > 3 || !parts.every(p => PLAIN.test(p))) return null
  const [catalog, schema, table] = parts
  return { catalog, schema, table: table || null, name: parts.join('.') }
}

/** One query: the caller's grants and ownerships on the target and its parents. Every branch names its
 * columns, since a UNION takes its names from whichever branch comes first. */
function grantsSql (t) {
  const is = `\`${t.catalog}\`.information_schema`
  const parts = []
  if (t.table) {
    parts.push(`SELECT 'table' AS level, grantee, privilege_type FROM ${is}.table_privileges WHERE table_schema = :schema AND table_name = :table`)
    parts.push(`SELECT 'table' AS level, table_owner AS grantee, 'OWNER' AS privilege_type FROM ${is}.tables WHERE table_schema = :schema AND table_name = :table`)
  }
  parts.push(`SELECT 'schema' AS level, grantee, privilege_type FROM ${is}.schema_privileges WHERE schema_name = :schema`)
  parts.push(`SELECT 'schema' AS level, schema_owner AS grantee, 'OWNER' AS privilege_type FROM ${is}.schemata WHERE schema_name = :schema`)
  parts.push(`SELECT 'catalog' AS level, grantee, privilege_type FROM ${is}.catalog_privileges WHERE catalog_name = :catalog`)
  parts.push(`SELECT 'catalog' AS level, catalog_owner AS grantee, 'OWNER' AS privilege_type FROM ${is}.catalogs WHERE catalog_name = :catalog`)
  return `SELECT level, privilege_type FROM (${parts.join(' UNION ALL ')}) AS g
    WHERE g.grantee = current_user() OR is_account_group_member(g.grantee) OR is_member(g.grantee)`
}

/**
 * From the caller's grant rows, what's missing for an action. A privilege counts at any level it can be
 * granted for the action (UC inherits downward); owning that level or ALL PRIVILEGES on it counts too.
 * USE CATALOG only counts on the catalog itself, so owning a schema doesn't supply it.
 */
function missingFor (action, rows, t) {
  const held = new Map(LEVELS.map(l => [l, new Set()]))
  for (const r of rows) held.get(String(r.level))?.add(String(r.privilege_type).toUpperCase().replace(/ /g, '_'))
  const has = (privilege, levels) => levels.some(l => ['OWNER', 'ALL_PRIVILEGES', privilege].some(p => held.get(l).has(p)))
  return NEEDS[action]
    .filter(([privilege, levels]) => !has(privilege, levels.filter(l => l !== 'table' || t.table)))
    .map(([privilege, levels]) => {
      const level = levels.find(l => l !== 'table' || t.table)
      const object = level === 'catalog' ? t.catalog : level === 'schema' ? `${t.catalog}.${t.schema}` : t.name
      return `${privilege.replace(/_/g, ' ')} on ${level} ${object}`
    })
}

/**
 * Check one action for the caller. run(sql, params) runs as the caller.
 * Returns { ok: true } | { ok: false, missing: [...] } | { ok: null, reason } when the grants can't be read.
 */
async function check (run, action, name) {
  if (!NEEDS[action]) throw Object.assign(new Error(`Unknown action ${action}`), { status: 400 })
  const t = target(name)
  if (!t || (action !== 'CREATE_TABLE' && !t.table) || (action === 'CREATE_TABLE' && t.table)) {
    throw Object.assign(new Error(action === 'CREATE_TABLE' ? 'catalog.schema expected' : 'catalog.schema.table expected'), { status: 400 })
  }
  let rows
  try {
    rows = await run(grantsSql(t), { schema: t.schema, table: t.table || '', catalog: t.catalog })
  } catch (err) {
    return { ok: null, reason: `Couldn't read the grants on ${t.name}: ${String(err.message || err).split('\n')[0].slice(0, 200)}` }
  }
  const missing = missingFor(action, rows, t)
  return missing.length ? { ok: false, missing } : { ok: true }
}

module.exports = { check, missingFor, grantsSql, target, NEEDS }
