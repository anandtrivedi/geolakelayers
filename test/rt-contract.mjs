// Lakehouse//RT contract checks: the behavior the gateway's routing relies on (provider/connection.js), run
// against a real RT warehouse. Re-run after RT changes (it is Beta) and before changing the routing.
//
//   node test/rt-contract.mjs <profile> <rtWarehouseId> <regularWarehouseId> <catalog.scratch_schema> [--keep]
//
// Creates the scratch schema (it must not exist yet) with a few small tables on the regular warehouse,
// runs the checks on RT, writes testimages/rt-contract.json and drops the schema (unless --keep).
// Needs CREATE SCHEMA on the catalog. The checks that matter most are the governance ones: a table with a
// row filter or a column mask must be refused by RT, never served without the policy.
import { execFileSync } from 'child_process'
import fs from 'fs'

const [profile, rtId, regularId, scratch, ...flags] = process.argv.slice(2)
if (!profile || !rtId || !regularId || !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(scratch || '')) {
  console.error('usage: node test/rt-contract.mjs <profile> <rtWarehouseId> <regularWarehouseId> <catalog.scratch_schema> [--keep]')
  process.exit(2)
}
const keep = flags.includes('--keep')
const auth = JSON.parse(execFileSync('databricks', ['auth', 'describe', '--profile', profile, '-o', 'json']))
const host = String(auth.details?.host || auth.host || '').replace(/\/$/, '')
const token = JSON.parse(execFileSync('databricks', ['auth', 'token', '--profile', profile])).access_token
if (!host) throw new Error(`No host for profile ${profile}`)

async function call (method, path, body) {
  const r = await fetch(`${host}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(d.message || `HTTP ${r.status}`), { errorCode: d.error_code, status: r.status })
  return d
}

// Run one statement; returns { ok, ms, columns, rows, error, errorCode }
async function run (warehouse, statement) {
  const t0 = Date.now()
  try {
    let d = await call('POST', '/api/2.0/sql/statements', { warehouse_id: warehouse, statement, disposition: 'INLINE', format: 'JSON_ARRAY', wait_timeout: '30s', on_wait_timeout: 'CONTINUE' })
    while (['PENDING', 'RUNNING'].includes(d.status?.state)) {
      await new Promise(r => setTimeout(r, 1000))
      d = await call('GET', `/api/2.0/sql/statements/${d.statement_id}`)
    }
    if (d.status?.state !== 'SUCCEEDED') {
      const e = d.status?.error || {}
      return { ok: false, ms: Date.now() - t0, error: (e.message || d.status?.state || '').split('\n')[0].slice(0, 400), errorCode: e.error_code || null }
    }
    const columns = (d.manifest?.schema?.columns || []).map(c => ({ name: c.name, type_name: c.type_name, type_text: c.type_text }))
    return { ok: true, ms: Date.now() - t0, columns, rows: d.result?.data_array || [] }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message.split('\n')[0].slice(0, 400), errorCode: err.errorCode || null, status: err.status }
  }
}

async function setup (sql) {
  const r = await run(regularId, sql)
  if (!r.ok) throw new Error(`Setup failed: ${sql.slice(0, 120)}: ${r.error}`)
  return r
}

const S = scratch
const report = { at: new Date().toISOString(), host, rtWarehouse: rtId, regularWarehouse: regularId, checks: [] }
// expect: what the gateway relies on; a check with a false 'pass' means the routing must change
function record (name, result, pass, note) {
  report.checks.push({ name, pass, note, ...result })
  console.log(`${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO'}  ${name}${note ? ` — ${note}` : ''}${result.ok === false ? `  [${result.errorCode || ''}] ${result.error}` : ''}  (${result.ms} ms)`)
}

const existing = await run(regularId, `SHOW SCHEMAS IN ${S.split('.')[0]} LIKE '${S.split('.')[1]}'`)
if (existing.ok && existing.rows.length) { console.error(`${S} already exists; pick a new scratch schema`); process.exit(2) }

console.log(`Setting up ${S} on ${regularId}`)
try {
  await setup(`CREATE SCHEMA ${S} COMMENT 'LakeGate RT contract test scratch schema; safe to drop'`)
  await setup(`CREATE TABLE ${S}.plain (
    id BIGINT NOT NULL, name STRING, geom GEOMETRY(4326), geog GEOGRAPHY(4326), wkt STRING, wkb BINARY,
    attrs STRUCT<a: INT, b: STRING>, tags ARRAY<STRING>, m MAP<STRING, INT>, ts TIMESTAMP, ts_ntz TIMESTAMP_NTZ,
    d DATE, amount DECIMAL(10,2), small SMALLINT, flag BOOLEAN, ratio DOUBLE, v VARIANT,
    CONSTRAINT plain_pk PRIMARY KEY (id))`)
  await setup(`INSERT INTO ${S}.plain SELECT id, concat('n', id), ST_Point(id, id, 4326), ST_GeogFromText(concat('POINT(', id, ' ', id, ')')),
    concat('POINT(', id, ' ', id, ')'), ST_AsBinary(ST_Point(id, id)), named_struct('a', CAST(id AS INT), 'b', 'x'), array('t1', 't2'),
    map('k', CAST(id AS INT)), current_timestamp(), CAST(current_timestamp() AS TIMESTAMP_NTZ), current_date(), 1.25, 3, true, 0.5,
    parse_json('{"k": 1}') FROM range(1, 11) AS r(id)`)
  await setup(`CREATE TABLE ${S}.lines AS SELECT id, ST_GeomFromText(concat('LINESTRING(0 0, ', id, ' 0.001, ', id, ' ', id, ')'), 4326) AS geom FROM range(1, 6) AS r(id)`)
  await setup(`CREATE TABLE ${S}.filtered (id BIGINT, secret STRING)`)
  await setup(`INSERT INTO ${S}.filtered SELECT id, concat('row', id) FROM range(1, 6) AS r(id)`)
  await setup(`CREATE FUNCTION ${S}.deny_all (id BIGINT) RETURN false`)
  await setup(`ALTER TABLE ${S}.filtered SET ROW FILTER ${S}.deny_all ON (id)`)
  await setup(`CREATE TABLE ${S}.masked (id BIGINT, secret STRING)`)
  await setup(`INSERT INTO ${S}.masked SELECT id, concat('secret', id) FROM range(1, 6) AS r(id)`)
  await setup(`CREATE FUNCTION ${S}.hide (s STRING) RETURN '***'`)
  await setup(`ALTER TABLE ${S}.masked ALTER COLUMN secret SET MASK ${S}.hide`)
  await setup(`CREATE VIEW ${S}.plain_view AS SELECT id, name, geom FROM ${S}.plain`)
  // A table that gets a row filter after RT has already read it (policy change between reads)
  await setup(`CREATE TABLE ${S}.later (id BIGINT, secret STRING)`)
  await setup(`INSERT INTO ${S}.later SELECT id, concat('later', id) FROM range(1, 6) AS r(id)`)

  console.log(`Checks on RT warehouse ${rtId} (the first one may wait for it to start)`)
  const warm = await run(rtId, 'SELECT 1 AS x')
  record('RT warehouse answers', warm, warm.ok)

  // Governance: refused (pass), or served without the policy (FAIL = data exposure)
  let r = await run(rtId, `SELECT id, secret FROM ${S}.filtered`)
  record('row filter: refused, never served unfiltered', r, !r.ok || r.rows.length === 0,
    r.ok ? (r.rows.length ? `RT RETURNED ${r.rows.length} ROWS the filter hides` : 'RT applied the filter (0 rows)') : 'refused')
  r = await run(rtId, `SELECT id, secret FROM ${S}.masked`)
  const unmasked = r.ok && r.rows.some(row => row[1] !== '***')
  record('column mask: refused, never served unmasked', r, !r.ok || !unmasked,
    r.ok ? (unmasked ? 'RT RETURNED UNMASKED VALUES' : 'RT applied the mask') : 'refused')
  r = await run(rtId, `SELECT count(*) AS n FROM ${S}.filtered`)
  record('row filter, aggregate: refused or filtered', r, !r.ok || Number(r.rows[0]?.[0]) === 0, r.ok ? `count = ${r.rows[0]?.[0]}` : 'refused')
  r = await run(rtId, `SELECT id, secret FROM ${S}.later`)
  record('policy change: first read before a row filter', r, r.ok, r.ok ? `${r.rows.length} rows` : 'refused')
  await setup(`ALTER TABLE ${S}.later SET ROW FILTER ${S}.deny_all ON (id)`)
  r = await run(rtId, `SELECT id, secret FROM ${S}.later`)
  // RT has been seen to serve the table for a few seconds after the change; the gateway's pre-check
  // (information_schema, below) is what closes that window, so this one is informational
  record('policy change: read right after the filter is added', r, null,
    r.ok ? (r.rows.length ? `RT served ${r.rows.length} rows after the filter was added` : 'filtered') : 'refused')
  if (!r.ok) report.governanceErrorCode = r.errorCode
  // information_schema (as the gateway's pre-check reads it) right after the change
  r = await run(rtId, `SELECT count(*) AS n FROM ${S.split('.')[0]}.information_schema.row_filters WHERE table_schema = '${S.split('.')[1]}' AND table_name = 'later'`)
  record('policy change: information_schema on RT sees the new filter at once', r, r.ok && Number(r.rows[0]?.[0]) === 1, r.ok ? `count = ${r.rows[0]?.[0]}` : 'not available')
  // How long RT keeps serving the table without the filter: new statement text each time, so no result cache
  const changedAt = Date.now()
  let window = null
  for (let i = 1; i <= 24; i++) {
    r = await run(rtId, `SELECT id, secret FROM ${S}.later WHERE id > -${i}`)
    if (!r.ok || r.rows.length === 0) { window = Math.round((Date.now() - changedAt) / 1000); break }
    await new Promise(resolve => setTimeout(resolve, 10000))
  }
  report.policyChangeWindowSeconds = window
  record('policy change: RT refuses the table within a minute', r, window !== null && window <= 60,
    window === null ? 'still served after 4 min' : `refused ${window} s after the filter was added`)

  // Metadata on RT
  r = await run(rtId, `SELECT (SELECT count(*) FROM ${S.split('.')[0]}.information_schema.row_filters WHERE table_schema = '${S.split('.')[1]}') AS rf,
    (SELECT count(*) FROM ${S.split('.')[0]}.information_schema.column_masks WHERE table_schema = '${S.split('.')[1]}') AS cm`)
  record('information_schema row_filters/column_masks on RT', r, null, r.ok ? `row filters ${r.rows[0]?.[0]}, masks ${r.rows[0]?.[1]} (expect 2, 1)` : 'not available')
  report.informationSchemaOnRt = r.ok && Number(r.rows[0]?.[0]) === 2 && Number(r.rows[0]?.[1]) === 1
  r = await run(rtId, `SELECT k.column_name FROM ${S.split('.')[0]}.information_schema.table_constraints t
    JOIN ${S.split('.')[0]}.information_schema.key_column_usage k ON k.constraint_catalog = t.constraint_catalog AND k.constraint_schema = t.constraint_schema AND k.constraint_name = t.constraint_name
    WHERE t.table_schema = '${S.split('.')[1]}' AND t.table_name = 'plain' AND t.constraint_type = 'PRIMARY KEY'`)
  record('information_schema primary key on RT', r, null, r.ok ? `pk = ${r.rows.map(x => x[0]).join(',')}` : 'not available')
  // The gateway detects native geometry from DESCRIBE (spec.js), so DESCRIBE on RT must name the type
  r = await run(rtId, `DESCRIBE ${S}.plain`)
  const geomType = r.ok ? (r.rows.find(x => x[0] === 'geom') || [])[1] : null
  record('DESCRIBE on RT names GEOMETRY(4326)', r, geomType === 'geometry(4326)', r.ok ? `geom: ${geomType}` : 'not available')
  r = await run(rtId, `DESCRIBE ${S}.filtered`)
  record('DESCRIBE of a row-filtered table on RT', r, null, r.ok ? 'works' : 'refused')
  r = await run(rtId, `SHOW TABLES IN ${S}`)
  record('SHOW TABLES on RT', r, null, r.ok ? 'works' : 'not available')

  // Schema from a zero-row result: what the manifest says for each type
  const limit0 = await run(rtId, `SELECT * FROM ${S}.plain LIMIT 0`)
  record('SELECT * LIMIT 0 on RT', limit0, limit0.ok, limit0.ok ? `${limit0.columns.length} columns` : '')
  const described = await run(regularId, `DESCRIBE ${S}.plain`)
  if (limit0.ok && described.ok) {
    report.manifestTypes = limit0.columns.map(c => ({ ...c, describe: (described.rows.find(x => x[0] === c.name) || [])[1] || null }))
    console.log('       manifest type_text vs DESCRIBE data_type:')
    for (const c of report.manifestTypes) console.log(`         ${c.name.padEnd(8)} ${String(c.type_name).padEnd(10)} ${String(c.type_text).padEnd(28)} ${c.describe}`)
  }
  const regular0 = await run(regularId, `SELECT * FROM ${S}.plain LIMIT 0`)
  if (regular0.ok && limit0.ok) {
    const diff = limit0.columns.filter((c, i) => c.type_text !== regular0.columns[i]?.type_text)
    // GEOMETRY/GEOGRAPHY come back as STRING in result manifests, so a zero-row SELECT can't replace DESCRIBE
    record('manifest types: RT = regular warehouse', regular0, null, diff.length ? `differ: ${diff.map(c => `${c.name} ${c.type_text} vs ${regular0.columns.find(x => x.name === c.name)?.type_text}`).join(', ')}` : 'same')
  }
  r = await run(rtId, `SELECT * FROM ${S}.plain_view LIMIT 0`)
  record('view on RT', r, null, r.ok ? 'served' : 'refused')
  r = await run(rtId, `SELECT * FROM ${S}.nope LIMIT 0`)
  record('missing table error code', r, !r.ok, r.errorCode || '')
  report.missingTableError = { code: r.errorCode, message: r.error }

  // Functions the gateway sends to RT
  r = await run(rtId, `SELECT ST_AsGeoJSON(geom) AS g, try_to_geometry(wkt) IS NOT NULL AS p, xxhash64(id) AS h, ST_SRID(geom) AS s FROM ${S}.plain LIMIT 1`)
  record('geometry functions on RT', r, r.ok)
  r = await run(rtId, `SELECT ST_XMin(ST_Envelope_Agg(geom)) AS xmin, ST_YMax(ST_Envelope_Agg(geom)) AS ymax FROM ${S}.plain`)
  record('extent aggregate on RT', r, null, r.ok ? `xmin ${r.rows[0]?.[0]}, ymax ${r.rows[0]?.[1]}` : 'not available')
  r = await run(rtId, `SELECT min(ST_XMin(geom)) AS xmin, max(ST_YMax(geom)) AS ymax FROM ${S}.plain`)
  record('min/max extent on RT', r, r.ok)
  r = await run(rtId, `SELECT ST_AsGeoJSON(ST_Simplify(geom, 0.01)) FROM ${S}.lines`)
  record('ST_Simplify on RT', r, null, r.ok ? 'now supported' : 'unsupported (routed to regular)')
  report.simplifyErrorCode = r.ok ? null : r.errorCode
} finally {
  if (!keep) {
    const d = await run(regularId, `DROP SCHEMA IF EXISTS ${S} CASCADE`)
    console.log(d.ok ? `Dropped ${S}` : `Could not drop ${S}: ${d.error}`)
  }
  const out = new URL('../testimages/rt-contract.json', import.meta.url).pathname
  fs.mkdirSync(new URL('../testimages/', import.meta.url).pathname, { recursive: true })
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`Report: ${out}`)
}
const failed = report.checks.filter(c => c.pass === false)
if (failed.length) { console.log(`${failed.length} check(s) failed`); process.exit(1) }
