// Lakehouse//RT: the Statement Execution API session (provider/sea.js) and the routing in connection.js
process.env.LOG_LEVEL = 'ERROR'
process.env.REALTIME_WAREHOUSES = 'rt0000000000000a'
process.env.DATABRICKS_HOST = 'ws.example.com'
process.env.DATABRICKS_WAREHOUSE_ID = 'reg000000000000b'
const test = require('node:test')
const assert = require('node:assert/strict')
const { seaSession, toValue, parametersOf } = require('../provider/sea')

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) })

test('toValue converts JSON_ARRAY text by column type', () => {
  assert.equal(toValue('42', 'LONG'), 42)
  assert.equal(toValue('1.5', 'DOUBLE'), 1.5)
  assert.equal(toValue('12.30', 'DECIMAL'), 12.3)
  assert.equal(toValue('true', 'BOOLEAN'), true)
  assert.equal(toValue('false', 'BOOLEAN'), false)
  assert.equal(toValue(null, 'INT'), null)
  assert.deepEqual(toValue('{"a":1}', 'STRUCT'), { a: 1 })
  assert.deepEqual(toValue('[1,2]', 'ARRAY'), [1, 2])
  assert.equal(toValue('2024-01-02 03:04:05', 'TIMESTAMP').toISOString(), '2024-01-02T03:04:05.000Z')
  assert.equal(toValue('2024-01-02T03:04:05.000Z', 'TIMESTAMP').toISOString(), '2024-01-02T03:04:05.000Z')
  assert.equal(toValue('2024-01-02', 'DATE').toISOString(), '2024-01-02T00:00:00.000Z')
  assert.ok(Buffer.isBuffer(toValue('eA==', 'BINARY')))
  assert.equal(toValue('{"type":"Point"}', 'STRING'), '{"type":"Point"}')
  assert.deepEqual(parametersOf({ a: 1, b: null, c: 'x' }), [{ name: 'a', value: '1' }, { name: 'b' }, { name: 'c', value: 'x' }])
})

test('seaSession: posts the statement as the caller, polls while running, reads every chunk', async () => {
  const calls = []
  const responses = [
    reply(200, { statement_id: 's1', status: { state: 'RUNNING' } }),
    reply(200, { statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'objectid', type_name: 'LONG' }, { name: '__geojson__', type_name: 'STRING' }] } }, result: { data_array: [['1', '{}']], next_chunk_internal_link: '/api/2.0/sql/statements/s1/result/chunks/1' } }),
    reply(200, { data_array: [['2', null]] })
  ]
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return responses.shift() }
  const s = seaSession({ host: 'ws.example.com', token: 'tok', warehouseId: 'rt0000000000000a', fetchImpl, sleep: async () => {} })
  const op = await s.executeStatement('SELECT 1', { queryTimeout: 30, namedParameters: { p0: 'a' } })
  assert.deepEqual(await op.fetchAll(), [{ objectid: 1, __geojson__: '{}' }, { objectid: 2, __geojson__: null }])
  const post = JSON.parse(calls[0].init.body)
  assert.equal(calls[0].url, 'https://ws.example.com/api/2.0/sql/statements')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok')
  assert.deepEqual([post.warehouse_id, post.statement, post.format, post.disposition], ['rt0000000000000a', 'SELECT 1', 'JSON_ARRAY', 'INLINE'])
  assert.deepEqual(post.parameters, [{ name: 'p0', value: 'a' }])
  assert.equal(calls[1].url, 'https://ws.example.com/api/2.0/sql/statements/s1')
  assert.equal(calls[2].url, 'https://ws.example.com/api/2.0/sql/statements/s1/result/chunks/1')
})

test('seaSession: failed statements, HTTP errors and timeouts (which cancel) throw', async () => {
  const one = body => seaSession({ host: 'h', token: 't', warehouseId: 'w', fetchImpl: async () => reply(200, body), sleep: async () => {} })
  await assert.rejects(one({ statement_id: 's', status: { state: 'FAILED', error: { message: '[UNSUPPORTED_FEATURE] st_asgeojson', error_code: 'BAD_REQUEST' } } }).executeStatement('SELECT 1'), /UNSUPPORTED_FEATURE/)
  await assert.rejects(seaSession({ host: 'h', token: 't', warehouseId: 'w', fetchImpl: async () => reply(501, { message: 'Thrift not supported' }) }).executeStatement('SELECT 1'), /Thrift not supported/)
  const urls = []
  let now = 0
  const realNow = Date.now
  Date.now = () => now
  try {
    const s = seaSession({ host: 'h', token: 't', warehouseId: 'w', sleep: async () => { now += 2000 }, fetchImpl: async url => { urls.push(url); return reply(200, { statement_id: 's9', status: { state: 'RUNNING' } }) } })
    await assert.rejects(s.executeStatement('SELECT 1', { queryTimeout: 5 }), /timed out after 5 s/)
  } finally { Date.now = realNow }
  assert.equal(urls.at(-1), 'https://h/api/2.0/sql/statements/s9/cancel')
})

test('routing rules: reads and metadata vs writes, table of a statement', () => {
  const { READ, REGULAR_ONLY, CALLER_ERROR, tableOf } = require('../provider/connection')._routing
  for (const s of ['SELECT 1', '  with x as (select 1) select * from x', '(SELECT 1)', 'DESCRIBE a.b.c', 'SHOW TABLES IN a.b']) assert.ok(READ.test(s), s)
  for (const s of ['INSERT INTO a.b.c VALUES (1)', 'MERGE INTO a.b.c', 'CREATE TABLE x', 'ALTER TABLE a.b.c ADD COLUMNS (x INT)']) assert.ok(!READ.test(s), s)
  assert.ok(REGULAR_ONLY.test('SELECT * FROM system.information_schema.columns'))
  assert.ok(!REGULAR_ONLY.test('SELECT systematic FROM a.b.c'))
  assert.equal(tableOf('SELECT *, x FROM a.b.c WHERE y'), 'a.b.c')
  assert.equal(tableOf('SELECT * FROM (SELECT *, h AS objectid FROM a.b.c) AS __src ORDER BY objectid'), 'a.b.c')
  assert.equal(tableOf('DESCRIBE a.b.c'), 'a.b.c')
  assert.equal(tableOf('DESCRIBE TABLE EXTENDED a.b.c'), 'a.b.c')
  assert.equal(tableOf('SELECT 1'), null)
  assert.ok(CALLER_ERROR.test('[INSUFFICIENT_PERMISSIONS] User does not have SELECT'))
  assert.ok(!CALLER_ERROR.test('[UNSUPPORTED_FEATURE] The function st_asgeojson is not supported'))
})

test('refusalOf: what a Lakehouse//RT error means (messages as RT returns them, see test/rt-contract.mjs)', () => {
  const { refusalOf } = require('../provider/connection')._routing
  const kind = (message, status) => refusalOf(Object.assign(new Error(message), status ? { status } : {}))
  assert.equal(kind('[UNSUPPORTED_FEATURE] A table with row filters, column masks, or ABAC policies is not supported in Lakehouse//RT. Details: table c.s.t.').kind, 'governed')
  assert.deepEqual(kind('[UNSUPPORTED_FEATURE] Function `st_envelope_agg` is not supported in Lakehouse//RT.'), { kind: 'function', fn: 'st_envelope_agg' })
  assert.equal(kind('[UNSUPPORTED_FEATURE] Delta feature x is not supported').kind, 'unsupported')
  assert.equal(kind('[TABLE_OR_VIEW_NOT_FOUND] The table or view c.s.nope cannot be found.').kind, 'caller')
  assert.equal(kind('[INSUFFICIENT_PERMISSIONS] User does not have SELECT on c.s.t').kind, 'caller')
  assert.equal(kind('Statement Execution API: HTTP 503', 503).kind, 'transient')
  assert.equal(kind('slow down', 429).kind, 'transient')
  assert.equal(kind('Query timed out after 60 s').kind, 'transient')
  assert.equal(kind('fetch failed').kind, 'transient')
  assert.equal(kind('something new').kind, 'unknown')
})

// A routing session over fakes: rt(sql) decides what Lakehouse//RT does with each statement
async function routed ({ rt = () => {}, governed = new Set(), checkOnRt = true } = {}) {
  const sea = require('../provider/sea')
  const original = sea.seaSession
  const calls = { rt: [], regular: [] }
  const policyCount = sql => [...governed].some(t => { const [, s, n] = t.split('.'); return sql.includes(`table_schema = '${s}' AND table_name = '${n}'`) }) ? 1 : 0
  sea.seaSession = () => ({
    async executeStatement (sql) {
      calls.rt.push(sql)
      if (/information_schema\.row_filters/.test(sql)) {
        if (!checkOnRt) throw new Error('[UNSUPPORTED_FEATURE] information_schema is not supported')
        return { fetchAll: async () => [{ n: policyCount(sql) }], close: async () => {} }
      }
      rt(sql)
      return { fetchAll: async () => [{ from: 'rt' }], close: async () => {} }
    },
    async close () {}
  })
  const connection = require('../provider/connection')
  const cm = new connection.ConnectionManager()
  connection.noteWarehouseType('rt0000000000000a', 'REALTIME')
  connection.noteWarehouseType('reg000000000000b', 'PRO')
  let regularOpened = 0
  const regularWarehouses = []
  cm.getUserSession = async (token, wh) => {
    regularOpened++
    regularWarehouses.push(wh)
    return {
      executeStatement: async sql => {
        calls.regular.push(sql)
        const n = /information_schema\.row_filters/.test(sql) ? policyCount(sql) : undefined
        return { fetchAll: async () => [n === undefined ? { from: 'regular' } : { n }], close: async () => {} }
      },
      close: async () => {}
    }
  }
  const s = await cm.getSession('tok', 'rt0000000000000a')
  sea.seaSession = original
  const run = async sql => (await (await s.executeStatement(sql, {})).fetchAll())[0].from
  return { cm, s, run, calls, opened: () => regularOpened, regularWarehouses }
}

test('realtime session: reads and metadata on Lakehouse//RT, writes on the regular warehouse', async () => {
  const { run, calls, opened, regularWarehouses } = await routed()
  assert.equal(await run('SELECT * FROM a.b.c LIMIT 10'), 'rt')
  assert.ok(calls.rt.some(q => /row_filters[\s\S]*column_masks/.test(q)), 'checked for row filters and column masks first, on RT')
  assert.equal(calls.regular.length, 0, 'the regular warehouse was not used')
  const checks = calls.rt.length
  assert.equal(await run('SELECT count(*) FROM a.b.c'), 'rt')
  assert.equal(calls.rt.length, checks + 1, 'the policy check is cached per table')
  assert.equal(await run('DESCRIBE a.b.c'), 'rt', 'DESCRIBE runs on RT')
  assert.equal(await run('SELECT k.column_name FROM a.information_schema.table_constraints t'), 'rt', 'information_schema runs on RT, with no policy check of its own')
  assert.ok(!calls.rt.some(q => q.includes("table_name = 'table_constraints'")))
  assert.equal(await run('SELECT * FROM system.access.audit'), 'regular')
  assert.equal(await run('INSERT INTO a.b.c VALUES (1)'), 'regular')
  assert.equal(await run('SELECT ST_AsGeoJSON(ST_Simplify(g, 0.1)) FROM a.b.c'), 'regular', 'simplified tiles: no ST_Simplify on Lakehouse//RT')
  assert.equal(await run('SELECT * FROM a.b.c LIMIT 5'), 'rt', 'without pinning the table')
  assert.equal(opened(), 1, 'one regular session per request, reused')
  assert.deepEqual(regularWarehouses, [undefined], 'the bound warehouse')
})

test('realtime session: governed tables, refusals by kind, permission errors', async () => {
  const fail = { 'x.y.z': '[UNSUPPORTED_FEATURE] A table with row filters, column masks, or ABAC policies is not supported in Lakehouse//RT', 't.u.v': 'something new', 'f.g.h': '[UNSUPPORTED_FEATURE] Function `st_envelope_agg` is not supported in Lakehouse//RT.' }
  const { cm, s, run, calls } = await routed({
    governed: new Set(['q.r.masked']),
    rt: sql => {
      if (/denied/.test(sql)) throw new Error('[INSUFFICIENT_PERMISSIONS] no')
      if (/st_envelope_agg/i.test(sql)) throw new Error(fail['f.g.h'])
      for (const t of ['x.y.z', 't.u.v']) if (sql.includes(t)) throw new Error(fail[t])
    }
  })
  const rtBefore = calls.rt.length
  assert.equal(await run('SELECT * FROM q.r.masked'), 'regular', 'a table with a row filter or column mask never goes to Lakehouse//RT')
  assert.equal(calls.rt.length, rtBefore + 1, 'only the policy check ran there')
  assert.equal(await run('SELECT ST_AsGeoJSON(g) FROM x.y.z'), 'regular', 'refused read retried on the regular warehouse')
  assert.equal(await run('SELECT count(*) FROM x.y.z'), 'regular', 'that table now skips Lakehouse//RT')
  assert.equal(await run('SELECT * FROM t.u.v'), 'regular')
  assert.equal(await run('SELECT * FROM a.b.c'), 'rt', 'other tables still use it')
  assert.equal(await run('SELECT ST_XMin(ST_Envelope_Agg(g)) FROM f.g.h'), 'regular')
  assert.equal(await run('SELECT ST_Envelope_Agg(g) FROM a.b.c'), 'regular', 'a learned unsupported function goes to regular for every table')
  assert.equal(await run('SELECT * FROM f.g.h'), 'rt', 'without pinning the table it was learned on')
  await assert.rejects(s.executeStatement('SELECT denied FROM q.r.s', {}), /INSUFFICIENT_PERMISSIONS/, 'permission errors are not retried')
  const st = cm.realtimeStatus()
  assert.ok(st.warehouses.includes('rt0000000000000a') && !st.warehouses.includes('reg000000000000b'))
  assert.deepEqual(st.refusals, { governed: 1, unknown: 1, function: 1 })
  assert.ok(st.unsupportedFunctions.includes('st_simplify') && st.unsupportedFunctions.includes('st_envelope_agg'))
  const pins = Object.fromEntries(st.tablesOnRegular.map(t => [t.table, t]))
  assert.equal(pins['q.r.masked'].reason, 'row filter or column mask')
  assert.equal(pins['x.y.z'].reason, 'row filter or column mask')
  assert.ok(!pins['f.g.h'])
  const hours = t => (Date.parse(pins[t].until) - Date.now()) / 3600000
  assert.ok(hours('x.y.z') > 5, 'a known incompatibility is pinned for hours')
  assert.ok(hours('t.u.v') < 0.2, 'an unexplained failure only for minutes')
  assert.equal(st.recentErrors[0].kind, 'function')
})

test('realtime session: the policy check falls back to the regular warehouse when RT can\'t run it', async () => {
  const { run, calls } = await routed({ governed: new Set(['q.r.masked']), checkOnRt: false })
  assert.equal(await run('SELECT * FROM q.r.masked'), 'regular')
  assert.ok(calls.regular.some(q => /row_filters/.test(q)))
  assert.equal(await run('SELECT * FROM a.b.c'), 'rt')
})

test('realtime session: circuit breaker after repeated transient failures, then one probe', async () => {
  let down = true
  const { cm, run, calls } = await routed({ rt: sql => { if (down && /FROM a\.b\./.test(sql)) throw Object.assign(new Error('Statement Execution API: HTTP 503'), { status: 503 }) } })
  for (let i = 0; i < 5; i++) assert.equal(await run(`SELECT * FROM a.b.t${i}`), 'regular')
  let st = cm.realtimeStatus()
  assert.equal(st.breakers.length, 1, 'open after 5 transient failures')
  assert.equal(st.tablesOnRegular.length, 0, 'transient failures do not pin tables')
  const tried = calls.rt.length
  assert.equal(await run('SELECT * FROM c.d.e'), 'regular', 'while open, RT is not tried')
  assert.equal(calls.rt.length, tried)
  assert.equal(cm.realtimeStatus().shortCircuited, 1)
  // Cool-down over: the next statement probes RT; one more failure reopens at once
  const b = cm.rt.breakers.get('rt0000000000000a')
  b.openUntil = Date.now() - 1
  assert.equal(await run('SELECT * FROM a.b.t9'), 'regular')
  assert.equal(cm.realtimeStatus().breakers.length, 1, 'reopened after one failed probe')
  assert.ok(b.cooldown > 30000, 'with a longer cool-down')
  b.openUntil = Date.now() - 1
  down = false
  assert.equal(await run('SELECT * FROM a.b.t9'), 'rt', 'recovered')
  st = cm.realtimeStatus()
  assert.equal(st.breakers.length, 0)
  assert.equal(b.cooldown, 30000, 'cool-down reset after a success')
})

test('isRealtime looks a warehouse up once (as the caller), caches it, and treats a failed lookup as regular', async () => {
  const connection = require('../provider/connection')
  const cm = new connection.ConnectionManager()
  const realFetch = global.fetch
  const seen = []
  global.fetch = async (url, init) => {
    seen.push([url, init.headers.Authorization])
    if (url.endsWith('/broken0000000000')) return { ok: false, status: 403, json: async () => ({}) }
    return { ok: true, json: async () => ({ warehouse_type: url.endsWith('/rtlook000000000a') ? 'REALTIME' : 'PRO' }) }
  }
  try {
    assert.equal(await cm.isRealtime('rtlook000000000a', 'tok'), true)
    assert.equal(await cm.isRealtime('rtlook000000000a', 'tok'), true)
    assert.equal(seen.length, 1, 'cached')
    assert.deepEqual(seen[0], ['https://ws.example.com/api/2.0/sql/warehouses/rtlook000000000a', 'Bearer tok'])
    assert.equal(await cm.isRealtime('prolook00000000b', 'tok'), false)
    assert.equal(await cm.isRealtime('broken0000000000', 'tok'), false)
  } finally { global.fetch = realFetch }
})
