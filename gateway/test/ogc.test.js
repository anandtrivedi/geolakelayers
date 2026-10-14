// OGC API – Features routes, params, CRS, services and OpenAPI, against a fake model and an in-memory store
process.env.LOG_LEVEL = 'ERROR'
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const { ogcRouter, consoleApi, CONFORMANCE, withQuery } = require('../ogc')
const params = require('../ogc/params')
const crs = require('../ogc/crs')
const services = require('../ogc/services')
const { buildOpenApi, jsonType } = require('../ogc/openapi')

const FIELDS = [
  { name: 'objectid', sqlType: 'bigint' },
  { name: 'kind', sqlType: 'string' },
  { name: 'score', sqlType: 'double' },
  { name: 'seen_at', sqlType: 'timestamp' },
  { name: 'tags', sqlType: 'array<string>' }
]
const ROWS = Array.from({ length: 25 }, (_, i) => ({
  type: 'Feature', id: i + 1, geometry: { type: 'Point', coordinates: [-77 + i * 0.01, 38.9] }, properties: { objectid: i + 1, kind: i % 2 ? 'b' : 'a' }
}))

function fakeModel () {
  const calls = []
  return {
    calls,
    checkRateLimit: () => true,
    async collectionInfo ({ table, timeField }) {
      if (table === 'c.s.secret') throw new Error('[INSUFFICIENT_PERMISSIONS] User does not have SELECT')
      if (table === 'c.s.flat') throw Object.assign(new Error('c.s.flat has no usable geometry or id'), { code: 400 })
      return { idField: 'objectid', fields: FIELDS, extent: { xmin: -77, ymin: 38.9, xmax: -76.76, ymax: 38.9 }, count: ROWS.length, temporal: timeField ? ['2024-01-01T00:00:00.000Z', '2024-12-31T00:00:00.000Z'] : null }
    },
    async queryFeatures (q) {
      calls.push(q)
      let rows = ROWS
      if (q.featureId !== undefined) rows = rows.filter(r => r.id === q.featureId)
      if (q.cursor !== undefined) rows = rows.filter(r => r.id > q.cursor)
      else rows = rows.slice(q.offset || 0)
      rows = rows.slice(0, q.limit)
      return { features: rows, lastId: rows.length ? rows[rows.length - 1].id : null, numberMatched: q.count === 'auto' ? ROWS.length : undefined }
    }
  }
}

// In-memory stand-in for the UC table, answering the store's SQL by shape
function memoryRun () {
  const rows = new Map()
  let version = 0
  const run = async (req, sql, p = {}) => {
    if (req.headers['x-test-deny']) throw new Error('PERMISSION_DENIED: no MODIFY')
    if (sql.startsWith('CREATE TABLE')) return []
    if (sql.startsWith('SELECT 1')) return rows.has(p.name) ? [{ x: 1 }] : []
    if (sql.startsWith('SELECT') && sql.includes('WHERE name')) return rows.has(p.name) ? [rows.get(p.name)] : []
    if (sql.startsWith('SELECT')) return [...rows.values()]
    if (sql.startsWith('INSERT')) { rows.set(p.name, { ...p, owner: 'me@x', version: 1 }); return [] }
    if (sql.startsWith('UPDATE')) {
      const r = rows.get(p.name)
      if (!r || String(r.version) !== p.version) return [{ num_affected_rows: 0 }]
      rows.set(p.name, { ...r, ...p, version: r.version + 1 }); version++
      return [{ num_affected_rows: 1 }]
    }
    if (sql.startsWith('DELETE')) return [{ num_affected_rows: rows.delete(p.name) ? 1 : 0 }]
    throw new Error('unexpected SQL ' + sql)
  }
  return { rows, run }
}

async function server () {
  const model = fakeModel()
  const mem = memoryRun()
  const store = services.createStore({ table: 'c.s.ogc_services', run: mem.run, obo: req => req.headers['x-forwarded-access-token'] || null })
  const deps = { model, store, obo: req => req.headers['x-forwarded-access-token'] || null, selfOrigin: () => 'https://gw.example', defaultLimit: 10, maxLimit: 20 }
  const app = express()
  app.use('/ogc', ogcRouter(deps))
  app.use('/api/ogc', consoleApi(deps))
  const srv = app.listen(0)
  await new Promise(resolve => srv.once('listening', resolve))
  const url = `http://127.0.0.1:${srv.address().port}`
  const call = async (path, opts = {}) => {
    const r = await fetch(url + path, { ...opts, headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'tok', ...(opts.headers || {}) } })
    const text = await r.text()
    return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }
  }
  return { model, mem, store, call, close: () => srv.close() }
}

const demo = { name: 'demo', title: 'Demo', collections: [{ table: 'c.s.places', timeField: 'seen_at' }, { table: 'c.s.roads' }] }

test('params: bbox, crs, limit, offset, datetime, unknown and repeated parameters', () => {
  assert.deepEqual(params.parseBbox('1,2,3,4', crs.CRS84), [[1, 2, 3, 4]])
  assert.throws(() => params.parseBbox('1,2,0,3,4,9', crs.CRS84), /heights/)
  // Web Mercator: no antimeridian split, inverted boxes refused, out-of-range values clamped
  assert.throws(() => params.parseBbox('1000,-1000,-1000,1000', crs.EPSG3857), /minx is greater/)
  const world = params.parseBbox('-40000000,-40000000,40000000,40000000', crs.EPSG3857)
  assert.equal(world.length, 1)
  assert.ok(Math.abs(world[0][0] + 180) < 1e-9 && Math.abs(world[0][2] - 180) < 1e-9 && world[0][3] < 85.06)
  assert.deepEqual(params.parseBbox('170,-10,-170,10', crs.CRS84), [[170, -10, 180, 10], [-180, -10, -170, 10]])
  const [[x0, y0]] = params.parseBbox('-8571600,4705800,-8562000,4710000', crs.EPSG3857)
  assert.ok(Math.abs(x0 - -77.0) < 0.01 && Math.abs(y0 - 38.9) < 0.05)
  for (const b of ['1,2,3', 'a,b,c,d', '1,2,3,4,5', '0,0,200,10', '0,10,1,0', '1,,3,4']) assert.throws(() => params.parseBbox(b, crs.CRS84), /bbox/)
  assert.equal(params.parseCrs(undefined), crs.CRS84)
  assert.equal(params.parseCrs('EPSG:3857'), crs.EPSG3857)
  assert.equal(params.parseCrs(`[${crs.EPSG3857}]`), crs.EPSG3857)
  assert.throws(() => params.parseCrs('EPSG:2263', 'crs'), /not supported/)
  assert.equal(params.parseLimit(undefined, { defaultLimit: 10, maxLimit: 20 }), 10)
  assert.equal(params.parseLimit('999', { defaultLimit: 10, maxLimit: 20 }), 20)
  for (const l of ['0', '-1', '1.5', 'x']) assert.throws(() => params.parseLimit(l, { defaultLimit: 10, maxLimit: 20 }), /limit/)
  assert.deepEqual(params.parseDatetime('2024-01-01T00:00:00Z'), { startMs: Date.UTC(2024, 0, 1), endMs: Date.UTC(2024, 0, 1) })
  assert.deepEqual(params.parseDatetime('2024-01-01'), { startMs: Date.UTC(2024, 0, 1), endMs: Date.UTC(2024, 0, 2) - 1 })
  assert.deepEqual(params.parseDatetime('../2024-01-01T00:00:00Z'), { startMs: null, endMs: Date.UTC(2024, 0, 1) })
  assert.deepEqual(params.parseDatetime('2024-01-01T00:00:00+05:00/'), { startMs: Date.UTC(2023, 11, 31, 19), endMs: null })
  for (const d of ['2025-02-30', '2025-02-29T10:00:00Z', '2024-01-01T25:00:00Z', '2024-01-01T10:61:00Z']) assert.throws(() => params.parseDatetime(d), /datetime/, d)
  assert.ok(params.parseDatetime('2024-02-29'), 'leap day is a real date')
  for (const d of ['../..', '2024-13-01T00:00:00Z/..', 'yesterday', '2024-02-01/2024-01-01', 'a/b/c', '2024-01-01T00:00:00']) assert.throws(() => params.parseDatetime(d), /datetime/)
  assert.throws(() => params.parseItemsQuery({ foo: '1' }), /Unknown parameter foo/)
  assert.throws(() => params.parseItemsQuery({ limit: ['1', '2'] }), /more than once/)
  assert.throws(() => params.parseItemsQuery({ datetime: '2024-01-01' }), /no time field/)
  assert.throws(() => params.parseItemsQuery({ f: 'html' }), /not supported/)
  assert.throws(() => params.parseItemsQuery({ offset: '-1' }), /offset/)
})

test('params: property filters become typed named parameters, never SQL text', () => {
  const q = params.parseItemsQuery({ kind: "a' OR 1=1 --", score: '2.5' }, { queryables: params.queryablesOf(FIELDS) })
  assert.deepEqual(q.filters.map(f => f.clause), ['`kind` = CAST(:p0 AS STRING)', '`score` = CAST(:p1 AS DOUBLE)'])
  // A column named like a SQL keyword is quoted
  assert.equal(params.parseItemsQuery({ group: '3' }, { queryables: [{ name: 'group', sqlType: 'int' }] }).filters[0].clause, '`group` = CAST(:p0 AS INT)')
  assert.deepEqual(params.parseItemsQuery({ properties: 'kind, score' }).properties, ['kind', 'score'])
  assert.throws(() => params.parseItemsQuery({ properties: 'a,b c' }), /properties/)
  assert.deepEqual(q.params, { p0: "a' OR 1=1 --", p1: '2.5' })
  assert.deepEqual(params.queryablesOf(FIELDS).map(f => f.name), ['objectid', 'kind', 'score', 'seen_at'])
  assert.deepEqual(params.queryablesOf([{ name: 'bad name', sqlType: 'string' }, { name: 'limit', sqlType: 'int' }, { name: 'd', sqlType: 'decimal(10,2)' }]).map(f => f.name), ['d'])
  const many = {}; const fields = []
  for (let i = 0; i < 11; i++) { many[`c${i}`] = '1'; fields.push({ name: `c${i}`, sqlType: 'int' }) }
  assert.throws(() => params.parseItemsQuery(many, { queryables: fields }), /At most 10/)
})

test('crs: Web Mercator round trip, latitude clamp, every geometry type', () => {
  const [x, y] = crs.toWebMercator([-77, 38.9])
  const [lon, lat] = crs.toWgs84([x, y])
  assert.ok(Math.abs(lon + 77) < 1e-9 && Math.abs(lat - 38.9) < 1e-9)
  assert.ok(Number.isFinite(crs.toWebMercator([0, 90])[1]))
  const poly = { type: 'MultiPolygon', coordinates: [[[[0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 0, 5]]]] }
  const out = crs.reproject(poly, crs.EPSG3857)
  assert.equal(out.coordinates[0][0][1][2], 5)
  assert.ok(Math.abs(out.coordinates[0][0][1][0] - 111319.49) < 0.1)
  assert.equal(crs.reproject(poly, crs.CRS84), poly)
  const gc = crs.reproject({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [1, 0] }] }, crs.EPSG3857)
  assert.ok(gc.geometries[0].coordinates[0] > 1000)
  assert.equal(crs.reproject(null, crs.EPSG3857), null)
})

test('services: validation and default collection ids', () => {
  const s = services.validateService({ collections: [{ table: 'a.b.c' }, { table: 'a.d.c' }, { table: 'a.b.e', id: 'roads' }] }, 'demo')
  assert.deepEqual(s.collections.map(c => c.id), ['b_c', 'd_c', 'roads'])
  assert.equal(s.title, 'demo')
  for (const [body, name, re] of [
    [{ collections: [{ table: 'a.b.c' }] }, 'Bad Name', /Service name/],
    [{ collections: [] }, 'ok', /at least one/],
    [{ collections: [{ table: 'a.b' }] }, 'ok', /catalog.schema.table/],
    [{ collections: [{ table: 'a.b.c; DROP' }] }, 'ok', /catalog.schema.table/],
    [{ collections: [{ table: 'a.b.c', id: 'x' }, { table: 'a.b.d', id: 'x' }] }, 'ok', /twice/],
    [{ collections: [{ table: 'a.b.c', timeField: 'a-b' }] }, 'ok', /Time field/],
    [{ collections: [{ table: 'a.b.c', id: 'bad id' }] }, 'ok', /Collection id/],
    [{ title: 'x'.repeat(201), collections: [{ table: 'a.b.c' }] }, 'ok', /Title/],
    [{ collections: Array.from({ length: 51 }, (_, i) => ({ table: `a.b.t${i}` })) }, 'ok', /At most 50/]
  ]) assert.throws(() => services.validateService(body, name), re)
  assert.equal(services.fromRow({ name: 'x', collections: 'not json' }), null)
  assert.match(services.createTableSql('a.b.c'), /CREATE TABLE IF NOT EXISTS a\.b\.c/)
  assert.throws(() => services.createStore({ table: 'nope', run: () => {}, obo: () => null }), /catalog.schema.table/)
})

test('console API: create, read, update with version, conflicts, delete, permission errors', async () => {
  const s = await server()
  try {
    let r = await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify(demo) })
    assert.equal(r.status, 201)
    assert.equal(r.body.collections.length, 2)
    assert.equal(r.body.version, 1)
    r = await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify(demo) })
    assert.equal(r.status, 409)
    r = await s.call('/api/ogc/services/demo', { method: 'PUT', body: JSON.stringify({ ...demo, title: 'Demo 2', version: 1 }) })
    assert.equal(r.status, 200)
    assert.equal(r.body.title, 'Demo 2')
    assert.equal(r.body.version, 2)
    r = await s.call('/api/ogc/services/demo', { method: 'PUT', body: JSON.stringify({ ...demo, version: 1 }) })
    assert.equal(r.status, 409, 'stale version')
    r = await s.call('/api/ogc/services/demo', { method: 'PUT', body: JSON.stringify(demo) })
    assert.equal(r.status, 400, 'missing version')
    r = await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify({ name: 'x', collections: [{ table: 'c.s.secret' }] }) })
    assert.equal(r.status, 403)
    r = await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify({ name: 'x', collections: [{ table: 'c.s.flat' }] }) })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /c\.s\.flat/)
    r = await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify({ name: 'x', collections: [{ table: 'c.s.places', timeField: 'kind' }] }) })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /not a date or timestamp/)
    r = await s.call('/api/ogc/services', { method: 'POST', headers: { 'x-test-deny': '1' }, body: JSON.stringify({ name: 'y', collections: [{ table: 'c.s.places' }] }) })
    assert.equal(r.status, 403)
    r = await s.call('/api/ogc/columns/c.s.places')
    assert.deepEqual(r.body.timeFields, ['seen_at'])
    r = await s.call('/api/ogc/services')
    assert.deepEqual(r.body.services.map(x => x.name), ['demo'])
    r = await s.call('/api/ogc/services/demo', { method: 'DELETE' })
    assert.equal(r.status, 204)
    r = await s.call('/api/ogc/services/demo', { method: 'DELETE' })
    assert.equal(r.status, 404)
    r = await s.call('/api/ogc/services/demo')
    assert.equal(r.status, 404)
  } finally { s.close() }
})

test('store: reads are cached per user and writes invalidate', async () => {
  let selects = 0
  const mem = memoryRun()
  const run = async (req, sql, p) => { if (sql.startsWith('SELECT') && sql.includes('WHERE name = :name') && !sql.startsWith('SELECT 1')) selects++; return mem.run(req, sql, p) }
  const store = services.createStore({ table: 'c.s.t', run, obo: req => req.token })
  const a = { headers: {}, token: 'a' }; const b = { headers: {}, token: 'b' }
  await store.create(a, services.validateService(demo))
  await store.get(a, 'demo'); await store.get(a, 'demo')
  assert.equal(selects, 1)
  await store.get(b, 'demo')
  assert.equal(selects, 2, 'other user reads for themselves')
  await store.update(a, services.validateService({ ...demo, title: 'T' }), 1)
  assert.equal((await store.get(b, 'demo')).title, 'T', 'write clears every user\'s copy')
  assert.equal(await store.get(a, 'NOT VALID'), null)
  const missing = services.createStore({ table: 'c.s.t', run: async () => { throw new Error('[TABLE_OR_VIEW_NOT_FOUND] c.s.t') }, obo: () => null })
  await assert.rejects(missing.list({ headers: {} }), e => e.status === 404 && e.setup === true)
})

test('OGC: landing, conformance, collections, collection, queryables, API', async () => {
  const s = await server()
  try {
    await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify({ ...demo, collections: [...demo.collections, { table: 'c.s.secret' }] }) }).then(r => assert.equal(r.status, 403))
    await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify(demo) })
    // A table the author could read but this reader can't is left out of /collections
    s.mem.rows.get('demo').collections = JSON.stringify([...JSON.parse(s.mem.rows.get('demo').collections), { id: 'secret', table: 'c.s.secret', title: 'secret' }])
    s.store._cache.clear()

    let r = await s.call('/ogc/demo')
    assert.equal(r.status, 200)
    const rels = r.body.links.map(l => l.rel)
    for (const rel of ['self', 'service-desc', 'service-doc', 'conformance', 'data']) assert.ok(rels.includes(rel), rel)
    assert.ok(r.body.links.every(l => l.href.startsWith('https://gw.example')))
    assert.equal((await s.call('/ogc/demo/')).status, 200)

    r = await s.call('/ogc/demo/conformance')
    assert.deepEqual(r.body.conformsTo, CONFORMANCE)

    r = await s.call('/ogc/demo/collections')
    assert.deepEqual(r.body.collections.map(c => c.id), ['places', 'roads'])
    const places = r.body.collections[0]
    assert.equal(places.itemType, 'feature')
    assert.deepEqual(places.crs, crs.SUPPORTED)
    assert.equal(places.storageCrs, crs.CRS84)
    assert.deepEqual(places.extent.spatial.bbox, [[-77, 38.9, -76.76, 38.9]])
    assert.deepEqual(places.extent.temporal.interval, [['2024-01-01T00:00:00.000Z', '2024-12-31T00:00:00.000Z']])
    assert.equal(r.body.collections[1].extent.temporal, undefined)
    assert.ok(places.links.some(l => l.rel === 'items' && l.type === 'application/geo+json'))

    r = await s.call('/ogc/demo/collections/roads')
    assert.equal(r.body.id, 'roads')
    assert.equal((await s.call('/ogc/demo/collections/nope')).status, 404)
    r = await s.call('/ogc/demo/collections/secret')
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'Forbidden')

    r = await s.call('/ogc/demo/collections/places/queryables')
    assert.deepEqual(Object.keys(r.body.properties), ['objectid', 'kind', 'score', 'seen_at'])
    assert.equal(r.body.properties.seen_at.format, 'date-time')

    r = await s.call('/ogc/demo/api')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /openapi\+json/)
    assert.equal(r.body.openapi, '3.0.3')
    const items = r.body.paths['/collections/places/items'].get.parameters
    assert.ok(items.some(p => p.$ref === '#/components/parameters/datetime'))
    assert.ok(items.some(p => p.name === 'kind'))
    assert.ok(!r.body.paths['/collections/roads/items'].get.parameters.some(p => p.$ref === '#/components/parameters/datetime'))
    assert.ok(r.body.paths['/collections/secret/items'], 'unreadable table still described, without queryables')

    assert.equal((await s.call('/ogc/nope')).status, 404)
    assert.equal((await s.call('/ogc/demo?f=xml')).status, 400)
    r = await s.call('/ogc')
    assert.deepEqual(r.body.services.map(x => x.name), ['demo'])
  } finally { s.close() }
})

test('OGC items: GeoJSON, paging links with cursor, limit clamp, filters, CRS, errors', async () => {
  const s = await server()
  try {
    await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify(demo) })
    let r = await s.call('/ogc/demo/collections/places/items')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /application\/geo\+json/)
    assert.equal(r.headers.get('content-crs'), `<${crs.CRS84}>`)
    assert.equal(r.body.type, 'FeatureCollection')
    assert.equal(r.body.numberReturned, 10, 'default limit')
    assert.equal(r.body.numberMatched, 25)
    assert.ok(r.body.timeStamp)
    assert.equal(r.body.features[0].id, 1)
    let next = r.body.links.find(l => l.rel === 'next')
    assert.ok(next)
    assert.ok(!r.body.links.some(l => l.rel === 'prev'))
    const u = new URL(next.href)
    assert.equal(u.searchParams.get('cursor'), '10')
    assert.equal(u.searchParams.get('offset'), '10')

    // Follow next links to the end
    const seen = r.body.features.map(f => f.id)
    while (next) {
      r = await s.call(new URL(next.href).pathname + new URL(next.href).search)
      seen.push(...r.body.features.map(f => f.id))
      assert.ok(r.body.links.some(l => l.rel === 'prev'))
      next = r.body.links.find(l => l.rel === 'next')
    }
    assert.deepEqual(seen, ROWS.map(x => x.id))

    r = await s.call('/ogc/demo/collections/places/items?limit=500')
    assert.equal(r.body.numberReturned, 20, 'clamped to maxLimit')
    assert.equal(s.model.calls.at(-1).limit, 20)

    r = await s.call('/ogc/demo/collections/places/items?offset=20&limit=10')
    const prev = new URL(r.body.links.find(l => l.rel === 'prev').href)
    assert.equal(prev.searchParams.get('offset'), '10')
    assert.equal(prev.searchParams.get('cursor'), null)

    await s.call('/ogc/demo/collections/places/items?bbox=-78,38,-76,39&kind=a&datetime=2024-01-01/..')
    const q = s.model.calls.at(-1)
    assert.deepEqual(q.bbox, [[-78, 38, -76, 39]])
    assert.deepEqual(q.params, { p0: 'a' })
    assert.equal(q.time.field, 'seen_at')
    assert.equal(q.time.startMs, Date.UTC(2024, 0, 1))
    assert.equal(q.userToken, 'tok')

    r = await s.call('/ogc/demo/collections/places/items?properties=kind&limit=2')
    assert.deepEqual(Object.keys(r.body.features[0].properties), ['kind'])
    assert.ok(r.body.features[0].geometry && r.body.features[0].id)

    r = await s.call(`/ogc/demo/collections/places/items?crs=${encodeURIComponent(crs.EPSG3857)}&limit=1`)
    assert.equal(r.headers.get('content-crs'), `<${crs.EPSG3857}>`)
    assert.ok(Math.abs(r.body.features[0].geometry.coordinates[0]) > 1000)

    for (const bad of ['foo=1', 'limit=0', 'bbox=1,2', 'datetime=nope', 'f=html', 'crs=EPSG:2263']) {
      r = await s.call(`/ogc/demo/collections/places/items?${bad}`)
      assert.equal(r.status, 400, bad)
      assert.equal(r.body.code, 'InvalidParameterValue')
      assert.ok(r.body.description)
    }
    r = await s.call('/ogc/demo/collections/roads/items?datetime=2024-01-01')
    assert.equal(r.status, 400, 'datetime on a collection without a time field')
  } finally { s.close() }
})

test('OGC single item: found, CRS, 404s, unknown params', async () => {
  const s = await server()
  try {
    await s.call('/api/ogc/services', { method: 'POST', body: JSON.stringify(demo) })
    let r = await s.call('/ogc/demo/collections/places/items/7')
    assert.equal(r.status, 200)
    assert.equal(r.body.type, 'Feature')
    assert.equal(r.body.id, 7)
    assert.ok(r.body.links.some(l => l.rel === 'collection'))
    assert.equal(s.model.calls.at(-1).featureId, 7)
    for (const fid of ['999', 'abc', '1e3', '99999999999999999999']) assert.equal((await s.call(`/ogc/demo/collections/places/items/${fid}`)).status, 404, fid)
    assert.equal((await s.call('/ogc/demo/collections/places/items/7?bbox=1,2,3,4')).status, 400)
    r = await s.call(`/ogc/demo/collections/places/items/7?crs=${encodeURIComponent(crs.EPSG3857)}`)
    assert.equal(r.headers.get('content-crs'), `<${crs.EPSG3857}>`)
  } finally { s.close() }
})

test('OGC: gateway without a services table says so', async () => {
  const app = express()
  const deps = { model: fakeModel(), store: null, obo: () => null, selfOrigin: () => 'https://gw' }
  app.use('/ogc', ogcRouter(deps))
  app.use('/api/ogc', consoleApi(deps))
  const srv = app.listen(0)
  await new Promise(resolve => srv.once('listening', resolve))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    let r = await fetch(`${base}/ogc/demo`)
    assert.equal(r.status, 404)
    assert.match((await r.json()).description, /not turned on/)
    r = await fetch(`${base}/ogc`)
    assert.deepEqual((await r.json()).services, [])
    r = await fetch(`${base}/api/ogc/services`)
    assert.equal(r.status, 404)
  } finally { srv.close() }
})

test('helpers: withQuery and jsonType', () => {
  assert.equal(withQuery('https://x/i', { a: '1', b: '2' }, { b: null, c: 3 }), 'https://x/i?a=1&c=3')
  assert.equal(withQuery('https://x/i', {}, {}), 'https://x/i')
  assert.deepEqual(jsonType('BIGINT'), { type: 'integer' })
  assert.deepEqual(jsonType('decimal(10,2)'), { type: 'number' })
  assert.deepEqual(jsonType('date'), { type: 'string', format: 'date' })
  assert.deepEqual(jsonType('boolean'), { type: 'boolean' })
  const doc = buildOpenApi({ service: { name: 'd', title: 'D', collections: [] }, baseUrl: 'https://x/ogc/d', info: {}, maxLimit: 5, defaultLimit: 2 })
  assert.equal(doc.components.parameters.limit.schema.maximum, 5)
})
