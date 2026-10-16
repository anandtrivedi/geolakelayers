// provider/model.js: query builders, the per-user query cache, the Esri getData path and the OGC query path
process.env.LOG_LEVEL = 'ERROR'
process.env.MAX_ROWS = '100'
process.env.BIG_TABLE_FEATURES = '1000'
const test = require('node:test')
const assert = require('node:assert/strict')
const layerSpec = require('../provider/spec')
const connectionManager = require('../provider/connection')
const Model = require('../provider/model')
const I = Model._internals

const WKT_SPEC = { objectId: 'objectid', geometryColumn: 'geometry_wkt', geometryFormat: 'wkt', spatialReference: 4326, geometryType: 'esriGeometryPoint' }
const OPT_SPEC = { objectId: 'objectid', geometryColumn: 'geom', geometryFormat: 'geometry', spatialReference: 4326, bboxColumns: true }
const inSpec = (spec, fn) => layerSpec.store.run(spec, fn)

test('parseBbox: comma form, envelope JSON and object, point, Web Mercator, bad input', () => {
  assert.deepEqual(I.parseBbox('-77,38,-76,39'), [-77, 38, -76, 39])
  assert.deepEqual(I.parseBbox('{"xmin":1,"ymin":2,"xmax":3,"ymax":4}'), [1, 2, 3, 4])
  assert.deepEqual(I.parseBbox({ x: 5, y: 6 }), [5, 6, 5, 6])
  const [x0, y0] = I.parseBbox('{"xmin":0,"ymin":0,"xmax":111319.49,"ymax":111325.14,"spatialReference":{"wkid":102100}}')
  assert.equal(x0, 0); assert.equal(y0, 0)
  const merc = I.parseBbox('0,0,111319.49,111325.14', '3857')
  assert.ok(Math.abs(merc[2] - 1) < 1e-4 && Math.abs(merc[3] - 1) < 1e-3)
  for (const bad of ['1,2,3', 'a,b,c,d', '{bad json', '{"rings":[]}', '1,2,3,4,5']) assert.equal(I.parseBbox(bad), null, bad)
})

test('buildBboxFilter: ST_Intersects with numbers only, plus the bounding-box prefilter for optimized copies', () => {
  inSpec(WKT_SPEC, () => {
    const f = I.buildBboxFilter('-77,38,-76,39')
    assert.equal(f, "ST_Intersects(ST_GeomFromText(geometry_wkt, 4326), ST_GeomFromText('POLYGON((-77 38, -76 38, -76 39, -77 39, -77 38))', 4326))")
    assert.equal(I.buildBboxFilter("1,2,3,4'); DROP TABLE x; --"), null)
  })
  inSpec(OPT_SPEC, () => {
    const f = I.buildBboxFilter('-77,38,-76,39')
    assert.match(f, /^\(_xmax >= -77 AND _xmin <= -76 AND _ymax >= 38 AND _ymin <= 39 AND ST_Intersects\(geom, /)
  })
})

test('buildQuery: Esri SQL is unchanged by an empty extra list; extra clauses are ANDed', () => {
  inSpec(WKT_SPEC, () => {
    const q = { where: "kind = 'a'", geometry: '-77,38,-76,39', resultRecordCount: '10', resultOffset: '20' }
    const plain = I.buildQuery('c.s.t', q, 't')
    assert.equal(I.buildQuery('c.s.t', q, 't', []), plain)
    assert.match(plain, /^SELECT \*, ST_AsGeoJSON\(ST_GeomFromText\(geometry_wkt, 4326\)\) as __geojson__ FROM c\.s\.t WHERE \(kind = 'a'\) AND ST_Intersects/)
    assert.match(plain, /ORDER BY objectid LIMIT 10 OFFSET 20$/)
    const extra = I.buildQuery('c.s.t', {}, 't', ['x = CAST(:p0 AS STRING)'])
    assert.match(extra, /WHERE x = CAST\(:p0 AS STRING\) ORDER BY objectid LIMIT 100$/)
    assert.equal(I.buildCountQuery('c.s.t', {}, ['a = 1', 'b = 2']), 'SELECT COUNT(*) as cnt FROM c.s.t WHERE a = 1 AND b = 2')
  })
  inSpec({ ...WKT_SPEC, source: '(SELECT 1) AS src' }, () => {
    assert.match(I.buildQuery('c.s.t', {}, 't'), /FROM \(SELECT 1\) AS src/)
  })
})

test('limits, offsets, order by, where validation, time filter', () => {
  assert.equal(I.parseResultRecordCount('5'), 5)
  assert.equal(I.parseResultRecordCount('99999'), 100)
  assert.equal(I.parseResultRecordCount('-3'), 100)
  assert.equal(I.parseResultRecordCount('x'), 100)
  assert.equal(I.parseResultOffset('-1'), 0)
  assert.equal(I.parseResultOffset('7'), 7)
  assert.equal(I.sanitizeOrderBy('a desc, b'), 'a DESC, b')
  assert.throws(() => I.sanitizeOrderBy('a; drop'), /Invalid orderByFields/)
  inSpec(WKT_SPEC, () => assert.throws(() => I.buildQuery('c.s.t', { where: '1=1; DROP TABLE x' }, 't'), /Invalid WHERE/))
  assert.equal(I.buildTimeFilter('0,null', 'ts'), "ts >= TIMESTAMP '1970-01-01T00:00:00.000Z'")
  assert.equal(I.buildTimeFilter('null,0', 'ts'), "ts <= TIMESTAMP '1970-01-01T00:00:00.000Z'")
  assert.match(I.buildTimeFilter('0,1000', 'ts'), /^ts BETWEEN TIMESTAMP '1970-01-01T00:00:00.000Z' AND TIMESTAMP '1970-01-01T00:00:01.000Z'$/)
  assert.equal(I.buildTimeFilter('null,null', 'ts'), null)
  assert.throws(() => I.buildTimeFilter('0', 'ts; drop'), /Invalid timeField/)
})

test('isLayerInfoPath', () => {
  for (const u of ['/databricks/rest/services/a.b.c/FeatureServer', '/x/FeatureServer/0', '/x/FeatureServer/0/', '/x/FeatureServer/0?f=json']) assert.equal(I.isLayerInfoPath(u), true, u)
  for (const u of ['/x/FeatureServer/0/query', '/x/FeatureServer/0/query?f=json', '', undefined]) assert.equal(I.isLayerInfoPath(u), false, String(u))
})

test('translateWithSTFunctions: geometry parsed, helper columns dropped, complex values JSON text or objects', () => {
  const rows = [{ objectid: 1, geometry_wkt: 'POINT (1 2)', _xmin: 1, names: { primary: 'A', n: 3n }, blob: Buffer.from('x'), when: new Date(0), __geojson__: '{"type":"Point","coordinates":[1,2]}' }]
  inSpec({ ...WKT_SPEC, bboxColumns: true }, () => {
    const esri = I.translateWithSTFunctions(rows, {})
    const p = esri.features[0].properties
    assert.deepEqual(esri.features[0].geometry, { type: 'Point', coordinates: [1, 2] })
    assert.equal(p.names, '{"primary":"A","n":3}')
    assert.ok(!('geometry_wkt' in p) && !('_xmin' in p) && !('blob' in p) && !('__geojson__' in p))
    assert.ok(p.when instanceof Date)
    const ogc = I.translateWithSTFunctions(rows, {}, { stringifyComplex: false })
    assert.deepEqual(ogc.features[0].properties.names, { primary: 'A', n: 3 })
    assert.equal(I.translateWithSTFunctions([{ __geojson__: 'not json' }], {}).features[0].geometry, null)
    assert.equal(I.translateWithSTFunctions(rows, { returnGeometry: 'false' }).features[0].geometry, null)
  })
})

test('query cache: per user and warehouse, params change the key, TTL-free hit, big results not cached, forgetTable clears', () => {
  const k1 = I.queryCacheKey('tokA', 'wh', 'SELECT 1')
  assert.notEqual(k1, I.queryCacheKey('tokB', 'wh', 'SELECT 1'))
  assert.notEqual(k1, I.queryCacheKey('tokA', 'wh2', 'SELECT 1'))
  assert.equal(k1, I.queryCacheKey('tokA', 'wh', 'SELECT 1', {}))
  assert.notEqual(I.queryCacheKey('tokA', 'wh', 'SELECT 1', { p0: 'a' }), I.queryCacheKey('tokA', 'wh', 'SELECT 1', { p0: 'b' }))
  assert.ok(!k1.includes('tokA'))
  I.forgetTable('nothing.at.all')
  I.queryCachePut(k1, [{ a: 1 }])
  assert.deepEqual(I.queryCacheGet(k1), [{ a: 1 }])
  assert.deepEqual(I.queryCacheStats(), { entries: 1, rows: 1 })
  I.queryCachePut(k1, [{ a: 2 }, { a: 3 }])
  assert.deepEqual(I.queryCacheStats(), { entries: 1, rows: 2 }, 'replacing an entry keeps the row count right')
  I.queryCachePut('big', new Array(200000).fill({}))
  assert.equal(I.queryCacheGet('big'), null, 'over a quarter of QUERY_CACHE_MAX_ROWS is not cached')
  I.forgetTable('c.s.t')
  assert.equal(I.queryCacheGet(k1), null)
  assert.deepEqual(I.queryCacheStats(), { entries: 0, rows: 0 })
})

// Fake DBSQL session answering by SQL shape, recording every statement and its named parameters
function fakeDb ({ rows = 30, count = 30, describe, pk = ['objectid'] } = {}) {
  const log = []
  const cols = describe || [
    { col_name: 'objectid', data_type: 'bigint' },
    { col_name: 'kind', data_type: 'string' },
    { col_name: 'names', data_type: 'struct<primary:string>' },
    { col_name: 'seen_at', data_type: 'timestamp' },
    { col_name: 'geometry_wkt', data_type: 'string' }
  ]
  const answer = sql => {
    if (/^DESCRIBE/.test(sql)) return cols
    // Primary key: objectid; content sample: geometry_wkt parses as WKT, other text columns don't
    if (/PRIMARY KEY/.test(sql)) return pk.map(c => ({ c }))
    if (/AS sample$/.test(sql)) {
      const texts = [...sql.matchAll(/count\((\w+)\) AS n(\d+)/g)].map(m => m[1])
      const row = {}
      texts.forEach((c, i) => Object.assign(row, { [`n${i}`]: 50, [`g${i}`]: c === 'geometry_wkt' ? 50 : 0, [`j${i}`]: 0, [`s${i}`]: 0 }))
      return [row]
    }
    if (/MIN\(seen_at\)/.test(sql)) return [{ t0: '2024-01-01T00:00:00Z', t1: '2024-02-01T00:00:00Z' }]
    if (/MIN\(ST_XMin/.test(sql)) return [{ xmin: -77, ymin: 38, xmax: -76, ymax: 39 }]
    if (/GROUP BY/.test(sql)) return [{ kind: 'a', n: 10n }, { kind: 'b', n: 20n }]
    if (/^SELECT DISTINCT/.test(sql)) return [{ kind: 'a' }, { kind: 'b' }]
    if (/COUNT\(\*\)/i.test(sql)) return [{ cnt: count }]
    const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] || 100)
    const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] || 0)
    return Array.from({ length: Math.max(0, Math.min(limit, rows - offset)) }, (_, i) => ({
      objectid: offset + i + 1, kind: 'a', names: { primary: `n${offset + i + 1}` }, geometry_wkt: 'POINT (1 2)', __geojson__: '{"type":"Point","coordinates":[1,2]}'
    }))
  }
  const session = {
    async executeStatement (sql, opts) {
      log.push({ sql, params: opts.namedParameters })
      return { fetchAll: async () => answer(sql), close: async () => {} }
    },
    close: async () => {}
  }
  return { log, session }
}

let tableN = 0
function withDb (opts, fn) {
  return async () => {
    const db = fakeDb(opts)
    const original = connectionManager.getSession
    connectionManager.getSession = async () => db.session
    const table = `c.s.t${++tableN}`
    try {
      await fn(db, table)
    } finally {
      connectionManager.getSession = original
    }
  }
}
const features = db => db.log.filter(e => /__geojson__/.test(e.sql))

test('queryFeatures: first page, ids, objects kept, numberMatched from the table count', withDb({}, async (db, table) => {
  const r = await Model.queryFeatures({ table, userToken: 'tok', limit: 10, count: 'auto' })
  assert.equal(r.features.length, 10)
  assert.equal(r.features[0].id, 1)
  assert.equal(r.lastId, 10)
  assert.deepEqual(r.features[0].properties.names, { primary: 'n1' })
  assert.equal(r.numberMatched, 30)
  assert.equal(r.idField, 'objectid')
  assert.match(features(db)[0].sql, /ORDER BY objectid LIMIT 10$/)
}))

test('queryFeatures: bbox boxes OR-ed, property filters and time as SQL, values as named parameters', withDb({}, async (db, table) => {
  await Model.queryFeatures({
    table, userToken: 'tok', limit: 5,
    bbox: [[170, -10, 180, 10], [-180, -10, -170, 10]],
    propertyFilters: [{ column: 'kind', clause: 'kind = CAST(:p0 AS STRING)' }],
    params: { p0: "a' OR 1=1" },
    time: { field: 'seen_at', startMs: 0, endMs: null }
  })
  const q = features(db)[0]
  assert.match(q.sql, /WHERE \(ST_Intersects\(.*POLYGON\(\(170 -10.*\) OR ST_Intersects\(.*POLYGON\(\(-180 -10.*\)\) AND kind = CAST\(:p0 AS STRING\) AND seen_at >= TIMESTAMP '1970-01-01T00:00:00.000Z'/)
  assert.deepEqual(q.params, { p0: "a' OR 1=1" })
  assert.ok(!q.sql.includes("a' OR"))
}))

test('queryFeatures: cursor paging uses the id and no OFFSET; numberMatched ignores the cursor', withDb({ count: 50 }, async (db, table) => {
  const r = await Model.queryFeatures({ table, userToken: 'tok', limit: 10, offset: 10, cursor: 10, propertyFilters: [{ clause: 'kind = CAST(:p0 AS STRING)' }], params: { p0: 'a' }, count: 'auto' })
  const q = features(db)[0]
  assert.match(q.sql, /AND objectid > CAST\(:cursor AS BIGINT\) ORDER BY objectid LIMIT 10$/)
  assert.deepEqual(q.params, { p0: 'a', cursor: '10' })
  const count = db.log.find(e => /COUNT/.test(e.sql) && e.params)
  assert.ok(!count.sql.includes(':cursor'))
  assert.deepEqual(count.params, { p0: 'a' })
  assert.equal(r.numberMatched, 50)
}))

test('queryFeatures: one feature by id; bad table; unusable table', withDb({}, async (db, table) => {
  await Model.queryFeatures({ table, userToken: 'tok', featureId: 7, limit: 1 })
  const q = features(db)[0]
  assert.match(q.sql, /WHERE objectid = CAST\(:fid AS BIGINT\)/)
  assert.deepEqual(q.params, { fid: '7' })
  await assert.rejects(Model.queryFeatures({ table: 'x; DROP', userToken: 'tok' }), e => e.code === 400)
}))

test('queryFeatures: a table without geometry is a 400', withDb({ describe: [{ col_name: 'objectid', data_type: 'bigint' }, { col_name: 'kind', data_type: 'string' }] }, async (db, table) => {
  await assert.rejects(Model.queryFeatures({ table, userToken: 'tok' }), e => e.code === 400 && /no usable geometry/.test(e.message))
}))

test('queryFeatures: big tables skip filtered counts', withDb({ count: 5000 }, async (db, table) => {
  const r = await Model.queryFeatures({ table, userToken: 'tok', limit: 10, propertyFilters: [{ clause: 'kind = CAST(:p0 AS STRING)' }], params: { p0: 'a' }, count: 'auto' })
  assert.equal(r.numberMatched, undefined)
}))

test('queryFeatures: a count that comes back lower than the page (failed count = 0) is not reported', withDb({ count: 0 }, async (db, table) => {
  const first = await Model.queryFeatures({ table, userToken: 'tok', limit: 10, count: 'auto' })
  assert.equal(first.features.length, 10)
  assert.equal(first.numberMatched, undefined)
  const keyset = await Model.queryFeatures({ table, userToken: 'tok', limit: 10, cursor: 10, offset: 10, count: 'auto' })
  assert.equal(keyset.numberMatched, undefined, 'keyset pages are guarded too')
}))

test('queryFeatures: results are cached per user, and a different user queries again', withDb({}, async (db, table) => {
  await Model.queryFeatures({ table, userToken: 'tok', limit: 3 })
  await Model.queryFeatures({ table, userToken: 'tok', limit: 3 })
  assert.equal(features(db).length, 1)
  await Model.queryFeatures({ table, userToken: 'other', limit: 3 })
  assert.equal(features(db).length, 2)
}))

test('collectionInfo: fields with SQL types, extent, count, time range; cached', withDb({}, async (db, table) => {
  const info = await Model.collectionInfo({ table, userToken: 'tok', timeField: 'seen_at' })
  assert.deepEqual(info.fields.map(f => [f.name, f.sqlType]), [['objectid', 'bigint'], ['kind', 'string'], ['names', 'struct<primary:string>'], ['seen_at', 'timestamp']])
  assert.deepEqual(info.extent, { xmin: -77, ymin: 38, xmax: -76, ymax: 39, spatialReference: { wkid: 4326 } })
  assert.equal(info.count, 30)
  assert.deepEqual(info.temporal, ['2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z'])
  const n = db.log.length
  await Model.collectionInfo({ table, userToken: 'tok', timeField: 'seen_at' })
  assert.equal(db.log.length, n, 'second call served from caches')
  await Model.collectionInfo({ table, userToken: 'tok', timeField: 'bad name' })
}))

test('getData (Esri path): layer info fetches one row; a query fetches a page; same SQL shape as before', withDb({}, async (db, table) => {
  const model = new Model()
  const call = req => new Promise((resolve, reject) => model.getData({ headers: { 'x-forwarded-access-token': 'tok' }, params: { id: table }, ...req }, (e, d) => e ? reject(e) : resolve(d)))
  const info = await call({ url: `/databricks/rest/services/${table}/FeatureServer/0`, query: {} })
  assert.equal(info.features.length, 1)
  assert.equal(info.metadata.idField, 'objectid')
  assert.equal(info.metadata.geometryType, 'esriGeometryPoint')
  assert.deepEqual(info.metadata.extent.xmin, -77)
  assert.equal(info.metadata.fields.find(f => f.name === 'names').type, 'esriFieldTypeString')
  const page = await call({ url: `/databricks/rest/services/${table}/FeatureServer/0/query`, query: { resultRecordCount: '7', resultOffset: '7', where: '1=1' } })
  assert.equal(page.features.length, 7)
  assert.equal(page.features[0].properties.names, '{"primary":"n8"}', 'Esri attributes stay scalar')
  const q = features(db).at(-1)
  assert.equal(q.sql, `SELECT *, ST_AsGeoJSON(ST_SetSRID(try_to_geometry(geometry_wkt), 4326)) as __geojson__ FROM ${table}  ORDER BY objectid LIMIT 7 OFFSET 7`, "same shape as before (empty WHERE leaves two spaces)")
  assert.equal(q.params, undefined, 'no named parameters on the Esri path')
  const count = await call({ url: `/x/FeatureServer/0/query`, query: { returnCountOnly: 'true' } })
  assert.deepEqual(count, { count: 30 })
  await assert.rejects(call({ url: '/x', params: { id: 'bad; name' }, query: {} }), /Invalid table name/)
}))

test('queryFeatures: a table without a primary key gets a derived id through a wrapped source', withDb({ pk: [] }, async (db, table) => {
  const r = await Model.queryFeatures({ table, userToken: 'tok', limit: 3 })
  assert.equal(r.idField, '__objectid', 'objectid is taken, so the derived id gets another name')
  const q = features(db)[0]
  assert.match(q.sql, /FROM \(SELECT \*, CAST\(pmod\(xxhash64\(objectid, kind, names, seen_at, geometry_wkt\), 9007199254740881\) AS BIGINT\) AS __objectid FROM c\.s\.t\d+\) AS __src/)
  assert.match(q.sql, /ORDER BY __objectid/)
}))

test('simplifyTolerance: maxAllowableOffset in degrees for lines and polygons only, Mercator scaled by latitude', () => {
  const LINE = { ...WKT_SPEC, geometryType: 'esriGeometryPolyline' }
  inSpec(WKT_SPEC, () => assert.equal(I.simplifyTolerance({ maxAllowableOffset: '1000', outSR: '102100' }), 0))
  inSpec(LINE, () => {
    assert.equal(I.simplifyTolerance({}), 0)
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '0' }), 0)
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '0.01' }), 0.01)
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '0.01', outSR: '4326' }), 0.01)
    // About 1 degree of longitude at the equator, half that at 60°N
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '111319.49', outSR: '{"wkid":102100}' }), 1)
    const north = I.simplifyTolerance({ maxAllowableOffset: '111319.49', outSR: { wkid: 102100 }, geometry: '-10,59,10,61', inSR: '4326' })
    assert.ok(Math.abs(north - 0.5) < 0.01, String(north))
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '1e9', outSR: '4326' }), 5)
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '10', outSR: '2263' }), 0)
    assert.equal(I.simplifyTolerance({ maxAllowableOffset: '10', outSR: '{bad' }), 0)
  })
})

test('buildSelectClause: wraps the geometry in ST_Simplify only when there is a tolerance', () => {
  inSpec(WKT_SPEC, () => {
    assert.equal(I.buildSelectClause('*', true), '*, ST_AsGeoJSON(ST_GeomFromText(geometry_wkt, 4326)) as __geojson__')
    const g = 'ST_GeomFromText(geometry_wkt, 4326)'
    assert.equal(I.buildSelectClause('*', true, 0.02), `*, ST_AsGeoJSON(CASE WHEN ST_IsEmpty(ST_Simplify(${g}, 0.02)) THEN ${g} ELSE ST_Simplify(${g}, 0.02) END) as __geojson__`,
      'shapes smaller than the tolerance keep their geometry instead of going empty')
    assert.equal(I.buildSelectClause('*', false, 0.02), '*')
  })
})

test('statistics and distinct values: SQL over the whole table, validated names, same filters', () => {
  inSpec(WKT_SPEC, () => {
    const stats = I.parseStatistics('[{"statisticType":"count","onStatisticField":"kind","outStatisticFieldName":"n"}]')
    assert.deepEqual(stats, [{ fn: 'COUNT', field: 'kind', alias: 'n' }])
    assert.equal(I.buildStatisticsQuery('c.s.t', { groupByFieldsForStatistics: 'kind', where: "kind <> 'x'" }, stats),
      "SELECT kind, COUNT(kind) AS n FROM c.s.t WHERE (kind <> 'x') GROUP BY kind ORDER BY kind LIMIT 100")
    assert.equal(I.buildStatisticsQuery('c.s.t', {}, I.parseStatistics([{ statisticType: 'max', onStatisticField: 'height' }, { statisticType: 'count' }])),
      'SELECT MAX(height) AS max_height, COUNT(*) AS count_all FROM c.s.t')
    assert.equal(I.buildStatisticsQuery('c.s.t', { groupByFieldsForStatistics: 'kind', orderByFields: 'n DESC', resultRecordCount: '5', resultOffset: '5' }, stats),
      'SELECT kind, COUNT(kind) AS n FROM c.s.t GROUP BY kind ORDER BY n DESC LIMIT 5 OFFSET 5')
    assert.equal(I.buildDistinctQuery('c.s.t', { outFields: 'kind', where: "state = 'NY  NJ'" }),
      "SELECT DISTINCT kind FROM c.s.t WHERE (state = 'NY  NJ') ORDER BY kind LIMIT 100", 'string literals untouched')
    assert.equal(I.parseStatistics(undefined), null)
    assert.equal(I.parseStatistics('[]'), null)
    for (const bad of ['{nope', '[{"statisticType":"median","onStatisticField":"a"}]', '[{"statisticType":"sum","onStatisticField":"a; drop"}]',
      '[{"statisticType":"sum","onStatisticField":"a","outStatisticFieldName":"x y"}]', '[{"statisticType":"sum"}]']) {
      assert.throws(() => I.parseStatistics(bad), /Invalid|Unsupported/, bad)
    }
    assert.throws(() => I.buildStatisticsQuery('c.s.t', { groupByFieldsForStatistics: 'a,b c' }, stats), /Invalid groupByFieldsForStatistics/)
    assert.throws(() => I.buildDistinctQuery('c.s.t', { outFields: '*' }), /needs outFields/)
  })
})

test('getData: statistics come back precalculated, distinct values as features without geometry', withDb({}, async (db, table) => {
  const model = new Model()
  const call = query => new Promise((resolve, reject) => model.getData({ headers: { 'x-forwarded-access-token': 'tok' }, params: { id: table }, url: `/x/FeatureServer/0/query`, query }, (e, d) => e ? reject(e) : resolve(d)))
  const stats = await call({ where: '1=1', groupByFieldsForStatistics: 'kind', outStatistics: '[{"statisticType":"count","onStatisticField":"kind","outStatisticFieldName":"n"}]' })
  assert.deepEqual(stats.statistics, [{ kind: 'a', n: 10 }, { kind: 'b', n: 20 }], 'BIGINT counts become numbers')
  assert.ok(stats.metadata.fields.find(f => f.name === 'kind'))
  const distinct = await call({ where: '1=1', outFields: 'kind', returnDistinctValues: 'true', returnGeometry: 'false' })
  assert.deepEqual(distinct.features.map(f => f.properties.kind), ['a', 'b'])
  assert.equal(distinct.features[0].geometry, null)
  assert.deepEqual(distinct.filtersApplied, { where: true, geometry: true, offset: true, limit: true }, 'Koop must not filter or page again')
  assert.equal(features(db).length, 0, 'no feature page fetched')
}))
