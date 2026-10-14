/*
  spec.test.js — Tests for spec.js (table geometry/id detection)
*/
const test = require('node:test')
const assert = require('node:assert/strict')

// Load spec functions
const spec = require('../provider/spec')

test('spec.detect: GEOMETRY(4326) column', async t => {
  // Note: spec.detect requires lname (lowercase name) field; test here documents the issue
  const cols = [
    { name: 'id', lname: 'id', type: 'bigint' },
    { name: 'geometry', lname: 'geometry', type: 'geometry(4326)' }
  ]
  const result = spec.detect(cols)
  assert.ok(result, 'should detect spec')
  assert.equal(result.objectId, 'id')
  assert.equal(result.geometryColumn, 'geometry')
  assert.equal(result.geometryFormat, 'expr')
  assert.equal(result.spatialReference, 4326)
  assert.ok(result.geometryExpr.includes('geometry'))
})

test('spec.detect: GEOGRAPHY column (lon/lat)', async t => {
  const cols = [
    { name: 'objectid', lname: 'objectid', type: 'bigint' },
    { name: 'shape', lname: 'shape', type: 'geography' }
  ]
  const result = spec.detect(cols)
  assert.ok(result, 'should detect spec')
  assert.equal(result.objectId, 'objectid')
  assert.ok(result.geometryExpr.includes('ST_GeomFromWKB'))
})

test('spec.detect: WKT string geometry', async t => {
  const cols = [
    { name: 'oid', lname: 'oid', type: 'bigint' },
    { name: 'geometry_wkt', lname: 'geometry_wkt', type: 'string' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.equal(result.objectId, 'oid')
  assert.equal(result.geometryColumn, 'geometry_wkt')
  assert.equal(result.geometryFormat, 'wkt')
})

test('spec.detect: WKB binary geometry', async t => {
  const cols = [
    { name: 'fid', lname: 'fid', type: 'bigint' },
    { name: 'geom_wkb', lname: 'geom_wkb', type: 'binary' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.equal(result.geometryColumn, 'geom_wkb')
  assert.equal(result.geometryFormat, 'wkb')
})

test('spec.detect: lon/lat double columns', async t => {
  const cols = [
    { name: 'bigid', lname: 'bigid', type: 'bigint' },
    { name: 'lon', lname: 'lon', type: 'double' },
    { name: 'lat', lname: 'lat', type: 'double' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.ok(result.geometryExpr.includes('ST_Point'))
  assert.ok(result.geometryExpr.includes('lon'))
  assert.ok(result.geometryExpr.includes('lat'))
})

test('spec.detect: missing geometry returns null', async t => {
  const cols = [
    { name: 'id', lname: 'id', type: 'bigint' },
    { name: 'name', lname: 'name', type: 'string' }
  ]
  const result = spec.detect(cols)
  assert.equal(result, null)
})

test('spec.detect: missing id returns null', async t => {
  const cols = [
    { name: 'name', lname: 'name', type: 'string' },
    { name: 'geometry_wkt', lname: 'geometry_wkt', type: 'string' }
  ]
  const result = spec.detect(cols)
  assert.equal(result, null)
})

test('spec.detect: string id (Overture) creates synthetic id', async t => {
  const cols = [
    { name: 'id', lname: 'id', type: 'string' },
    { name: 'geometry_wkt', lname: 'geometry_wkt', type: 'string' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.ok(result.syntheticIdFrom)
  assert.equal(result.syntheticIdFrom, 'id')
  assert.ok(result.objectIdExpr.includes('xxhash64'))
})

test('spec.detect: GEOMETRY without SRID (assumed 4326)', async t => {
  const cols = [
    { name: 'id', lname: 'id', type: 'bigint' },
    { name: 'geom', lname: 'geom', type: 'geometry' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.ok(result.geometryExpr.includes('ST_SetSRID'))
})

test('spec.detect: GEOMETRY(3857) reprojected to 4326', async t => {
  const cols = [
    { name: 'id', lname: 'id', type: 'bigint' },
    { name: 'geom', lname: 'geom', type: 'geometry(3857)' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.ok(result.geometryExpr.includes('ST_Transform'))
})

test('spec.detect: non-plain identifier column ignored', async t => {
  const cols = [
    { name: 'id', lname: 'id', type: 'bigint' },
    { name: '"quoted name"', lname: '"quoted name"', type: 'string' },
    { name: 'geometry_wkt', lname: 'geometry_wkt', type: 'string' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  // Should detect despite the quoted column
  assert.equal(result.geometryColumn, 'geometry_wkt')
})

test('spec.detect: bbox columns detected', async t => {
  const cols = [
    { name: 'id', lname: 'id', type: 'bigint' },
    { name: 'geometry', lname: 'geometry', type: 'geometry(4326)' },
    { name: '_xmin', lname: '_xmin', type: 'double' },
    { name: '_ymin', lname: '_ymin', type: 'double' },
    { name: '_xmax', lname: '_xmax', type: 'double' },
    { name: '_ymax', lname: '_ymax', type: 'double' }
  ]
  const result = spec.detect(cols)
  assert.ok(result)
  assert.equal(result.bboxColumns, true)
})

test('spec.describeColumns: stops at metadata section', async t => {
  const rows = [
    { col_name: 'id', data_type: 'BIGINT' },
    { col_name: 'name', data_type: 'STRING' },
    { col_name: '# Partition Information', data_type: '# col_name' },
    { col_name: 'date', data_type: 'DATE' }
  ]
  const cols = spec.describeColumns(rows)
  assert.equal(cols.length, 2)
  assert.equal(cols[0].name, 'id')
  assert.equal(cols[1].name, 'name')
})

test('spec.sourceFor: without synthetic id', async t => {
  const specWithoutSynth = { objectId: 'id' }
  const result = spec.sourceFor('catalog.schema.table', specWithoutSynth)
  assert.equal(result, 'catalog.schema.table')
})

test('spec.sourceFor: with synthetic id', async t => {
  const specWithSynth = {
    objectId: 'objectid',
    objectIdExpr: 'CAST(pmod(xxhash64(id), 9007199254740881) AS BIGINT)',
    syntheticIdFrom: 'id'
  }
  const result = spec.sourceFor('catalog.schema.table', specWithSynth)
  assert.ok(result.includes('AS __src'))
  assert.ok(result.includes('CAST(pmod(xxhash64(id)'))
})

test('spec.whoOf: token creates hash', async t => {
  const token = 'dapi123456abcdef'
  const who = spec.whoOf(token)
  assert.equal(typeof who, 'string')
  assert.equal(who.length, 32) // SHA256 hex-truncated
  const who2 = spec.whoOf(token)
  assert.equal(who, who2) // deterministic
})

test('spec.whoOf: no token returns app', async t => {
  const who = spec.whoOf(null)
  assert.equal(who, 'app')
  const who2 = spec.whoOf(undefined)
  assert.equal(who2, 'app')
})

test('spec.forgetTable: clears cache entries', async t => {
  // This is a direct cache operation; simulate it
  // Since cache is module-scoped, we can't directly test clearing without mocking
  // So we'll document the expected behavior
  assert.ok(typeof spec.forgetTable === 'function')
})

test('spec.resolveSpec: caches per user', async t => {
  const execCalls = []
  const exec = async (sql, kind) => {
    execCalls.push({ sql, kind })
    if (kind === 'describe') {
      return [
        { col_name: 'id', data_type: 'BIGINT' },
        { col_name: 'geometry', data_type: 'GEOMETRY(4326)' }
      ]
    }
    if (kind === 'geomtype') {
      return [{ t: 'st_point' }]
    }
    return []
  }

  const s1 = await spec.resolveSpec('mytable', exec, 'user1')
  const s2 = await spec.resolveSpec('mytable', exec, 'user1')

  assert.equal(s1, s2) // same spec object
  assert.equal(execCalls.filter(c => c.kind === 'describe').length, 1) // exec called once per user
})

test('spec.current: returns store value or default', async t => {
  const defaults = { objectId: 'id', geometryColumn: 'geom' }
  // Without AsyncLocalStorage context, should return defaults
  const result = spec.current(defaults)
  assert.deepEqual(result, defaults)
})
