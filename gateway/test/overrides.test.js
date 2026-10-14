// lib/overrides.js and the /api/overrides + /api/scan routes in server.js
process.env.LOG_LEVEL = 'ERROR'
process.env.LAYER_OVERRIDES_TABLE = 'c.s.layer_overrides'
process.env.ALLOWED_ORIGINS = 'https://portal.example'
process.env.DATABRICKS_HOST = 'example.cloud.databricks.com'
process.env.DATABRICKS_WAREHOUSE_ID = 'abcdef1234567890'
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateOverride, createOverrideStore, createTableSql } = require('../lib/overrides')

test('validateOverride: plain names, one geometry source, lon/lat together, EPSG srid', () => {
  assert.deepEqual(validateOverride({ geometryColumn: 'shape', srid: '2263' }), { geometryColumn: 'shape', lonColumn: null, latColumn: null, idColumn: null, srid: 2263 })
  assert.deepEqual(validateOverride({ lonColumn: 'x', latColumn: 'y', idColumn: 'k' }), { geometryColumn: null, lonColumn: 'x', latColumn: 'y', idColumn: 'k', srid: null })
  for (const [body, re] of [
    [{}, /Nothing to override/],
    [{ geometryColumn: 'a b' }, /plain column name/],
    [{ idColumn: "x'; DROP" }, /plain column name/],
    [{ geometryColumn: 'g', lonColumn: 'x', latColumn: 'y' }, /either/],
    [{ lonColumn: 'x' }, /go together/],
    [{ lonColumn: 'x', latColumn: 'x' }, /different/],
    [{ geometryColumn: 'g', srid: 'abc' }, /EPSG/],
    [{ geometryColumn: 'g', srid: -1 }, /EPSG/]
  ]) assert.throws(() => validateOverride(body), re)
})

test('store: reads all overrides once (cached), treats a missing table as empty, writes with parameters', async () => {
  const calls = []
  let rows = [{ table_name: 'a.b.c', geometry_column: 'shape', geometry_srid: 2263, id_column: 'k', updated_by: 'me', updated_at: '2026-10-14T00:00:00Z' }, { table_name: 'bad name', geometry_column: 'x' }]
  const run = async (sql, params) => { calls.push({ sql, params }); return /^SELECT/.test(sql) ? rows : [] }
  const store = createOverrideStore({ table: 'c.s.o' })
  assert.deepEqual(await store.get(run, 'a.b.c'), { geometryColumn: 'shape', srid: 2263, lonColumn: null, latColumn: null, idColumn: 'k', updatedBy: 'me', updatedAt: '2026-10-14T00:00:00.000Z' })
  assert.equal(await store.get(run, 'x.y.z'), null)
  assert.equal((await store.all(run)).size, 1, 'rows with bad table names are dropped')
  assert.equal(calls.length, 1, 'one read, cached')
  await store.put(run, 'a.b.c', { geometryColumn: null, srid: null, lonColumn: 'x', latColumn: 'y', idColumn: null })
  const put = calls.at(-1)
  assert.match(put.sql, /^MERGE INTO c\.s\.o AS t USING \(SELECT :name AS table_name\)/)
  assert.deepEqual(put.params, { name: 'a.b.c', geom: '', srid: '', lon: 'x', lat: 'y', id: '' })
  assert.ok(!put.sql.includes("'x'"), 'values are parameters, not SQL text')
  rows = []
  assert.equal(await store.get(run, 'a.b.c'), null, 'a write clears the cache')
  await store.remove(run, 'a.b.c')
  assert.deepEqual(calls.at(-1), { sql: 'DELETE FROM c.s.o WHERE table_name = :name', params: { name: 'a.b.c' } })
  await assert.rejects(store.put(run, 'nope', {}), /catalog.schema.table/)
  await store.setup(run)
  assert.match(calls.at(-2).sql, /^CREATE TABLE IF NOT EXISTS c\.s\.o/)
  assert.equal(calls.at(-1).sql, 'GRANT SELECT ON TABLE c.s.o TO `account users`')
  const missing = createOverrideStore({ table: 'c.s.o' })
  assert.equal((await missing.all(async () => { throw new Error('[TABLE_OR_VIEW_NOT_FOUND] c.s.o') })).size, 0)
  assert.equal(missing.missing, true)
  await assert.rejects(createOverrideStore({ table: 'c.s.o2' }).all(async () => { throw new Error('PERMISSION_DENIED') }), /PERMISSION_DENIED/)
  assert.throws(() => createOverrideStore({ table: 'x' }), /catalog.schema.table/)
  assert.match(createTableSql('a.b.c'), /geometry_column STRING, geometry_srid INT, lon_column STRING, lat_column STRING, id_column STRING/)
})

// Routes, with Databricks SQL answered by a fake session
const connectionManager = require('../provider/connection')
const overrideRows = new Map()
const log = []
connectionManager.getSession = async () => ({
  async executeStatement (sql, opts) {
    log.push({ sql, params: opts.namedParameters })
    const rows = (() => {
      if (/^DESCRIBE c\.s\.points/.test(sql)) return [{ col_name: 'pid', data_type: 'bigint' }, { col_name: 'x', data_type: 'double' }, { col_name: 'y', data_type: 'double' }, { col_name: 'note', data_type: 'string' }]
      if (/^DESCRIBE c\.s\.texty/.test(sql)) return [{ col_name: 'k', data_type: 'int' }, { col_name: 'footprint', data_type: 'string' }]
      if (/^DESCRIBE/.test(sql)) return [{ col_name: 'n', data_type: 'int' }]
      if (/FROM c\.s\.layer_overrides$/.test(sql)) return [...overrideRows.values()]
      if (/^MERGE INTO c\.s\.layer_overrides/.test(sql)) { const p = opts.namedParameters; overrideRows.set(p.name, { table_name: p.name, geometry_column: p.geom || null, lon_column: p.lon || null, lat_column: p.lat || null, id_column: p.id || null, geometry_srid: p.srid ? Number(p.srid) : null }); return [] }
      if (/^DELETE FROM c\.s\.layer_overrides/.test(sql)) { overrideRows.delete(opts.namedParameters.name); return [] }
      if (/information_schema\.columns WHERE table_schema = 's'/.test(sql)) return [{ tbl: 'texty', native: 0, text: 1 }, { tbl: 'points', native: 0, text: 1 }, { tbl: 'geo', native: 1, text: 1 }, { tbl: 'nums', native: 0, text: 0 }]
      if (/AS sample$/.test(sql)) return [/c\.s\.texty/.test(sql) ? { n0: 20, g0: 20, j0: 0, s0: 0 } : { n0: 20, g0: 0, j0: 0, s0: 0 }]
      if (/system\.information_schema\.columns/.test(sql)) return [{ cat: 'c', sch: 's', tbl: 'geo', geom: 'shape', dt: 'geometry(4326)', pk: null }]
      return []
    })()
    return { fetchAll: async () => rows, close: async () => {} }
  },
  close: async () => {}
})

const { start } = require('../server')
let base, server
test.before(async () => { server = start(0); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}` })
test.after(() => server.close())
const call = (path, { method = 'GET', body, origin, type = 'application/json' } = {}) => fetch(base + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'x-forwarded-access-token': 'tok', 'x-forwarded-host': `127.0.0.1:${server.address().port}`, ...(type ? { 'content-type': type } : {}), ...(origin ? { origin } : {}) }
}).then(async r => { const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null } })

test('a table with only lon/lat columns has no geometry until an author picks them; then it lists and reads', async () => {
  let r = await call('/api/spec/c.s.points')
  assert.equal(r.body.spec, null)
  assert.deepEqual(r.body.columns.map(c => c.name), ['pid', 'x', 'y', 'note'])
  r = await call('/api/overrides/c.s.points', { method: 'PUT', body: { lonColumn: 'x', latColumn: 'y', idColumn: 'pid' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.spec.geometryExpr, 'ST_Point(x, y, 4326)')
  assert.equal(r.body.spec.objectId, 'pid')
  assert.equal(r.body.spec.idSource, 'override')
  r = await call('/api/catalog?catalogs=c')
  assert.deepEqual(r.body.tables.map(t => [t.table, t.detectedBy, t.idField]), [['c.s.geo', 'type', 'derived'], ['c.s.points', 'override', 'pid']])
  r = await call('/api/overrides/c.s.points', { method: 'DELETE' })
  assert.equal(r.status, 204)
  r = await call('/api/spec/c.s.points')
  assert.equal(r.body.spec, null, 'removing the override takes effect at once')
})

test('overrides are checked against the table: missing columns and wrong types are refused', async () => {
  for (const [body, re] of [
    [{ geometryColumn: 'nope' }, /no column nope/],
    [{ lonColumn: 'note', latColumn: 'y' }, /can't be longitude/],
    [{ geometryColumn: 'pid' }, /can't be a geometry column/],
    [{ geometryColumn: 'note', idColumn: 'x' }, /can't be the object id/],
    [{}, /Nothing to override/]
  ]) {
    const r = await call('/api/overrides/c.s.points', { method: 'PUT', body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.body.error, re)
  }
  assert.equal((await call('/api/overrides/bad', { method: 'PUT', body: { idColumn: 'x' } })).status, 400)
})

test('override writes are console-only: foreign origin, non-JSON and preflight are refused', async () => {
  assert.equal((await call('/api/overrides/c.s.points', { method: 'PUT', body: { idColumn: 'pid' }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('/api/overrides/c.s.points', { method: 'PUT', body: { idColumn: 'pid' }, type: 'text/plain' })).status, 403)
  assert.equal((await call('/api/overrides/c.s.points', { method: 'OPTIONS' })).status, 403)
  const r = await call('/api/overrides')
  assert.deepEqual(r.body, { enabled: true, table: 'c.s.layer_overrides', missing: false })
})

test('scan schema: samples text tables without native geometry and lists what it finds', async () => {
  let r = await call('/api/scan?schema=c.s')
  assert.equal(r.status, 200)
  assert.equal(r.body.checked, 2, 'texty and points; geo has native geometry, nums has no text')
  assert.deepEqual(r.body.found.map(f => [f.table, f.geometry, f.detectedBy, f.idField]), [['c.s.texty', 'footprint', 'content', 'derived']])
  r = await call('/api/catalog?catalogs=c')
  assert.ok(r.body.tables.some(t => t.table === 'c.s.texty' && t.detectedBy === 'content'), 'scanned tables join the listing')
  assert.equal((await call('/api/scan?schema=c')).status, 400)
  assert.equal((await call("/api/scan?schema=c.s'--")).status, 400)
})

test('OGC console writes refuse preflights too', async () => {
  assert.equal((await call('/api/ogc/services', { method: 'OPTIONS', origin: 'https://portal.example' })).status, 403)
})
