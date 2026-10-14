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

test('routing rules: reads vs metadata vs writes, table of a statement', () => {
  const { READ, METADATA, CALLER_ERROR, tableOf } = require('../provider/connection')._routing
  for (const s of ['SELECT 1', '  with x as (select 1) select * from x', '(SELECT 1)']) assert.ok(READ.test(s), s)
  for (const s of ['INSERT INTO a.b.c VALUES (1)', 'MERGE INTO a.b.c', 'DESCRIBE a.b.c', 'CREATE TABLE x']) assert.ok(!READ.test(s) || METADATA.test(s), s)
  for (const s of ['DESCRIBE a.b.c', 'SHOW CATALOGS', 'SELECT * FROM system.information_schema.columns', 'SELECT 1 FROM c.information_schema.table_constraints']) assert.ok(METADATA.test(s), s)
  assert.ok(!METADATA.test('SELECT systematic FROM a.b.c'))
  assert.equal(tableOf('SELECT *, x FROM a.b.c WHERE y'), 'a.b.c')
  assert.equal(tableOf('SELECT * FROM (SELECT *, h AS objectid FROM a.b.c) AS __src ORDER BY objectid'), 'a.b.c')
  assert.equal(tableOf('SELECT 1'), null)
  assert.ok(CALLER_ERROR.test('[INSUFFICIENT_PERMISSIONS] User does not have SELECT'))
  assert.ok(!CALLER_ERROR.test('[UNSUPPORTED_FEATURE] The function st_asgeojson is not supported'))
})

test('realtime session: reads on Lakehouse//RT, metadata and writes on the regular warehouse, refusals fall back per table', async () => {
  const sea = require('../provider/sea')
  const original = sea.seaSession
  const rtCalls = []
  let refuse = /never/
  sea.seaSession = () => ({
    async executeStatement (sql) {
      rtCalls.push(sql)
      if (refuse.test(sql)) throw new Error('[UNSUPPORTED_FEATURE] st_asgeojson is not supported')
      if (/denied/.test(sql)) throw new Error('[INSUFFICIENT_PERMISSIONS] no')
      return { fetchAll: async () => [{ from: 'rt' }], close: async () => {} }
    },
    async close () {}
  })
  const { ConnectionManager } = require('../provider/connection')
  const cm = new ConnectionManager()
  const regularCalls = []
  let regularOpened = 0
  const regularWarehouses = []
  cm.getUserSession = async (token, wh) => {
    regularOpened++
    regularWarehouses.push(wh)
    return { executeStatement: async sql => { regularCalls.push(sql); return { fetchAll: async () => [{ from: 'regular' }], close: async () => {} } }, close: async () => {} }
  }
  try {
    const s = await cm.getSession('tok', 'rt0000000000000a')
    const run = async sql => (await (await s.executeStatement(sql, {})).fetchAll())[0].from
    assert.equal(await run('SELECT * FROM a.b.c LIMIT 10'), 'rt')
    assert.equal(regularOpened, 0, 'no regular session until one is needed')
    assert.equal(await run('DESCRIBE a.b.c'), 'regular')
    assert.equal(await run('INSERT INTO a.b.c VALUES (1)'), 'regular')
    assert.equal(regularOpened, 1, 'one regular session per request, reused')
    assert.deepEqual(regularWarehouses, [undefined], 'the bound warehouse')
    refuse = /x\.y\.z/
    assert.equal(await run('SELECT ST_AsGeoJSON(g) FROM x.y.z'), 'regular', 'refused read retried on the regular warehouse')
    const rtBefore = rtCalls.length
    assert.equal(await run('SELECT count(*) FROM x.y.z'), 'regular', 'that table now skips Lakehouse//RT')
    assert.equal(rtCalls.length, rtBefore)
    assert.equal(await run('SELECT * FROM a.b.c'), 'rt', 'other tables still use it')
    await assert.rejects(s.executeStatement('SELECT denied FROM q.r.s', {}), /INSUFFICIENT_PERMISSIONS/, 'permission errors are not retried')
    const st = cm.realtimeStatus()
    assert.deepEqual(st.warehouses, ['rt0000000000000a'])
    assert.equal(st.fallbacks, 1)
    assert.deepEqual(st.tablesOnRegular.map(t => t.table), ['x.y.z'])
    assert.match(st.recentErrors[0].error, /UNSUPPORTED_FEATURE/)
    await assert.rejects(cm.getSession(null, 'rt0000000000000a'), /caller's token/)
    // Regular warehouses don't go through the realtime path
    await cm.getSession('tok', 'reg000000000000b')
    assert.equal(regularOpened, 2)
  } finally {
    sea.seaSession = original
  }
})
