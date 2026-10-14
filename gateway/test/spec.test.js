// provider/spec.js: geometry and id detection by type and content (never by column name), overrides,
// the primary key, derived ids, and resolveSpec's caching
process.env.LOG_LEVEL = 'ERROR'
const test = require('node:test')
const assert = require('node:assert/strict')
const spec = require('../provider/spec')

const cols = list => list.map(([name, type]) => ({ name, lname: name.toLowerCase(), type }))
const parsedFor = (table, columns, rowByColumn) => {
  const sample = spec.sampleSql(table, columns)
  const row = {}
  sample.cands.forEach((c, i) => Object.assign(row, { [`n${i}`]: 0, [`g${i}`]: 0, [`j${i}`]: 0, [`s${i}`]: 0 }, rowByColumn[c.name] ? Object.fromEntries(Object.entries(rowByColumn[c.name]).map(([k, v]) => [`${k}${i}`, v])) : {}))
  return spec.readSample(sample, row)
}

test('native GEOMETRY / GEOGRAPHY are found by type whatever they are called', () => {
  for (const [type, expr] of [
    ['geometry(4326)', 'footprint'],
    ['geometry(3857)', 'ST_Transform(footprint, 4326)'],
    ['geometry', 'ST_SetSRID(footprint, 4326)'],
    ['geography', 'ST_GeomFromWKB(ST_AsBinary(footprint), 4326)']
  ]) {
    const s = spec.detect(cols([['k', 'bigint'], ['footprint', type]]))
    assert.equal(s.geometryColumn, 'footprint', type)
    assert.equal(s.geometryExpr, expr, type)
    assert.equal(s.geometryDetectedBy, 'type')
    assert.equal(s.geometryStorage, 'native')
  }
})

test('names mean nothing: a lat/lon pair or a column called geometry_wkt is not geometry without content', () => {
  assert.equal(spec.detect(cols([['objectid', 'bigint'], ['lat', 'double'], ['lon', 'double']])), null)
  assert.equal(spec.detect(cols([['objectid', 'bigint'], ['geometry_wkt', 'string']])), null, 'not sampled = not geometry')
})

test('text/binary geometry is found by sampling: WKT, GeoJSON, WKB; best parse rate wins; SRID from the data', () => {
  const c = cols([['a', 'string'], ['footprint', 'string'], ['shape_b', 'binary'], ['n', 'bigint']])
  let p = parsedFor('x.y.z', c, { footprint: { n: 200, g: 200, j: 0, s: 0 }, a: { n: 200, g: 3 } })
  assert.deepEqual(p.map(x => x.column), ['footprint'], '1.5% parse rate is not geometry')
  let s = spec.detect(c, { parsed: p })
  assert.equal(s.geometryColumn, 'footprint')
  assert.equal(s.geometryExpr, 'ST_SetSRID(try_to_geometry(footprint), 4326)')
  assert.equal(s.geometryStorage, 'wkt')
  assert.equal(s.geometryDetectedBy, 'content')

  p = parsedFor('x.y.z', c, { footprint: { n: 100, g: 100, j: 100 } })
  assert.equal(p[0].storage, 'geojson')
  p = parsedFor('x.y.z', c, { shape_b: { n: 10, g: 10 } })
  assert.equal(p[0].storage, 'wkb')
  p = parsedFor('x.y.z', c, { footprint: { n: 50, g: 50, s: 3857 } })
  assert.equal(spec.detect(c, { parsed: p }).geometryExpr, 'ST_Transform(ST_SetSRID(try_to_geometry(footprint), 3857), 4326)')
  // Both parse: the higher rate (then more values) wins, the other stays a candidate
  p = parsedFor('x.y.z', c, { footprint: { n: 100, g: 96 }, a: { n: 100, g: 100 } })
  s = spec.detect(c, { parsed: p })
  assert.equal(s.geometryColumn, 'a')
  assert.deepEqual(s.geometryCandidates, ['a', 'footprint'])
  assert.deepEqual(parsedFor('x.y.z', c, { footprint: { n: 0, g: 0 } }), [], 'empty columns are not geometry')
})

test('sampleSql: plain-named STRING/BINARY columns only, one bounded query', () => {
  const s = spec.sampleSql('c.s.t', cols([['a', 'string'], ['b', 'binary'], ['n', 'int'], ['bad name', 'string'], ['v', 'varchar(20)']]))
  assert.deepEqual(s.cands.map(c => c.name), ['a', 'b', 'v'])
  assert.match(s.sql, /^SELECT count\(a\) AS n0, count\(try_to_geometry\(a\)\) AS g0, count_if\(ltrim\(a\) LIKE '\{%'\) AS j0, mode\(ST_SRID\(try_to_geometry\(a\)\)\) AS s0, /)
  assert.match(s.sql, /0 AS j1/, 'binary columns are never GeoJSON')
  assert.match(s.sql, /FROM \(SELECT a, b, v FROM c\.s\.t LIMIT 200\) AS sample$/)
  assert.equal(spec.sampleSql('c.s.t', cols([['n', 'int']])), null)
})

test('object id: override, then single-column integer primary key, then a hash of the whole row', () => {
  const c = cols([['objectid', 'string'], ['k', 'bigint'], ['code', 'string'], ['g', 'geometry(4326)'], ['tags', 'map<string,string>'], ['v', 'variant']])
  let s = spec.detect(c, { override: { idColumn: 'k' } })
  assert.deepEqual([s.objectId, s.idSource, s.objectIdExpr], ['k', 'override', undefined])
  s = spec.detect(c, { override: { idColumn: 'code' } })
  assert.equal(s.idSource, 'override')
  assert.equal(s.syntheticIdFrom, 'code')
  assert.equal(s.objectId, '__objectid', 'a column called objectid already exists')
  assert.equal(s.objectIdExpr, `CAST(pmod(xxhash64(code), ${spec.SYNTHETIC_ID_MODULUS}) AS BIGINT)`)
  s = spec.detect(c, { primaryKey: ['k'] })
  assert.deepEqual([s.objectId, s.idSource], ['k', 'primary key'])
  s = spec.detect(c, { primaryKey: ['k', 'code'] })
  assert.equal(s.idSource, 'derived', 'composite keys are not used')
  s = spec.detect(c, { primaryKey: ['code'] })
  assert.equal(s.idSource, 'derived', 'string keys are not used as-is')
  assert.equal(s.objectIdExpr, `CAST(pmod(xxhash64(objectid, k, code, ST_AsBinary(g), to_json(tags), to_json(v)), ${spec.SYNTHETIC_ID_MODULUS}) AS BIGINT)`)
  // An id override pointing at a missing or unsuitable column falls through
  assert.equal(spec.detect(c, { override: { idColumn: 'nope' }, primaryKey: ['k'] }).idSource, 'primary key')
  assert.equal(spec.detect(c, { override: { idColumn: 'g' } }).idSource, 'derived')
})

test('derived ids skip the bounding-box helper columns of map-optimized copies', () => {
  const s = spec.detect(cols([['g', 'geometry(4326)'], ['x', 'int'], ['_xmin', 'double'], ['_ymin', 'double'], ['_xmax', 'double'], ['_ymax', 'double']]))
  assert.equal(s.bboxColumns, true)
  assert.match(s.objectIdExpr, /xxhash64\(ST_AsBinary\(g\), x\)/)
})

test('geometry overrides: a column (with SRID), or lon/lat; bad overrides are ignored', () => {
  const c = cols([['k', 'bigint'], ['x1', 'double'], ['y1', 'double'], ['shape', 'string'], ['g', 'geometry(4326)'], ['g2', 'geography']])
  let s = spec.detect(c, { override: { lonColumn: 'x1', latColumn: 'y1' } })
  assert.equal(s.geometryExpr, 'ST_Point(x1, y1, 4326)')
  assert.equal(s.geometryColumn, null)
  assert.equal(s.geometryStorage, 'lonlat')
  assert.equal(s.geometryDetectedBy, 'override')
  s = spec.detect(c, { override: { geometryColumn: 'shape', srid: 2263 } })
  assert.equal(s.geometryExpr, 'ST_Transform(ST_SetSRID(try_to_geometry(shape), 2263), 4326)')
  s = spec.detect(c, { override: { geometryColumn: 'g2' } })
  assert.equal(s.geometryColumn, 'g2', 'override picks the second native column')
  assert.equal(spec.detect(c, { override: { geometryColumn: 'k' } }).geometryColumn, 'g', 'an integer column cannot be geometry')
  assert.equal(spec.detect(c, { override: { lonColumn: 'x1', latColumn: 'nope' } }).geometryColumn, 'g')
})

test('columns with non-plain names are never used (they would be SQL text)', () => {
  assert.equal(spec.detect(cols([['bad name', 'geometry(4326)']])), null)
  const s = spec.detect(cols([['g; DROP', 'geometry'], ['g', 'geometry(4326)']]), { override: { idColumn: 'x`y' } })
  assert.equal(s.geometryColumn, 'g')
  assert.ok(!s.objectIdExpr.includes('DROP'))
})

test('describeColumns stops at the metadata sections', () => {
  const c = spec.describeColumns([{ col_name: 'a', data_type: 'INT' }, { col_name: 'B', data_type: 'String' }, { col_name: '', data_type: '' }, { col_name: 'a', data_type: 'int' }])
  assert.deepEqual(c, [{ name: 'a', lname: 'a', type: 'int' }, { name: 'B', lname: 'b', type: 'string' }])
  assert.equal(spec.describeColumns([{ col_name: 'x', data_type: 'int' }, { col_name: '# Partition Information', data_type: '' }]).length, 1)
})

test('sourceFor wraps only derived ids; whoOf never holds the token', () => {
  assert.equal(spec.sourceFor('c.s.t', { objectId: 'k' }), 'c.s.t')
  assert.equal(spec.sourceFor('c.s.t', { objectId: 'objectid', objectIdExpr: 'E' }), '(SELECT *, E AS objectid FROM c.s.t) AS __src')
  assert.equal(spec.whoOf(null), 'app')
  assert.equal(spec.whoOf('secret-token'), spec.whoOf('secret-token'))
  assert.notEqual(spec.whoOf('a'), spec.whoOf('b'))
  assert.ok(!spec.whoOf('secret-token').includes('secret'))
  assert.match(spec.primaryKeySql('c.s.t'), /FROM c\.information_schema\.table_constraints[\s\S]*table_schema = 's' AND t\.table_name = 't' AND t\.constraint_type = 'PRIMARY KEY'/)
})

test('resolveSpec: describe, override, primary key, sample only when needed, geometry type; cached per user', async () => {
  const seen = []
  let override = null
  spec.setOverrideSource(async () => override)
  const exec = async (sql, kind) => {
    seen.push(kind)
    if (kind === 'describe') return [{ col_name: 'k', data_type: 'bigint' }, { col_name: 'wkt_text', data_type: 'string' }]
    if (kind === 'primary key') return [{ c: 'k' }]
    if (kind === 'sample') return [{ n0: 10, g0: 10, j0: 0, s0: 0 }]
    if (kind === 'geomtype') return [{ t: 'st_polygon' }]
    return []
  }
  const s = await spec.resolveSpec('c.s.t1', exec, 'u1')
  assert.deepEqual(seen, ['describe', 'primary key', 'sample', 'geomtype'])
  assert.equal(s.geometryColumn, 'wkt_text')
  assert.equal(s.objectId, 'k')
  assert.equal(s.geometryType, 'esriGeometryPolygon')
  assert.equal(s.source, 'c.s.t1')
  assert.deepEqual(s.columns, [{ name: 'k', type: 'bigint' }, { name: 'wkt_text', type: 'string' }])
  await spec.resolveSpec('c.s.t1', exec, 'u1')
  assert.equal(seen.length, 4, 'cached')
  await spec.resolveSpec('c.s.t1', exec, 'u2')
  assert.equal(seen.length, 8, 'per user')
  spec.forgetTable('c.s.t1')
  override = { lonColumn: 'k', latColumn: 'k' }
  await spec.resolveSpec('c.s.t1', exec, 'u1')
  assert.equal(seen.length, 12, 'forgotten after forgetTable')
  // Native geometry: no sample needed
  seen.length = 0
  override = null
  await spec.resolveSpec('c.s.t2', async (sql, kind) => { seen.push(kind); return kind === 'describe' ? [{ col_name: 'g', data_type: 'geometry(4326)' }] : [] }, 'u1')
  assert.deepEqual(seen, ['describe', 'primary key', 'geomtype'])
  // A failing primary-key lookup or override read doesn't break detection
  spec.setOverrideSource(async () => { throw new Error('no table') })
  const s3 = await spec.resolveSpec('c.s.t3', async (sql, kind) => { if (kind === 'primary key') throw new Error('denied'); return kind === 'describe' ? [{ col_name: 'g', data_type: 'geometry(4326)' }] : [] }, 'u1')
  assert.equal(s3.idSource, 'derived')
  spec.setOverrideSource(async () => null)
  assert.equal(await spec.resolveSpec('c.s.t4', async (sql, kind) => kind === 'describe' ? [{ col_name: 'n', data_type: 'int' }] : [], 'u1'), null)
})
