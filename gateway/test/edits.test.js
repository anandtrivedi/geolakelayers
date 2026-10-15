/*
  edits.test.js — Tests for edits.js (toWkt, parseList, planEdits)
*/
const test = require('node:test')
const assert = require('node:assert/strict')

const edits = require('../edits')

// ============ toWkt tests ============

test('edits.toWkt: point in 4326', async t => {
  const geom = { x: -74.0, y: 40.7 }
  const wkt = edits.toWkt(geom)
  assert.match(wkt, /POINT \(-74 40.7\)/)
})

test('edits.toWkt: null geometry', async t => {
  const wkt = edits.toWkt(null)
  assert.equal(wkt, null)
})

test('edits.toWkt: point with spatialReference 4326', async t => {
  const geom = {
    x: -74.0,
    y: 40.7,
    spatialReference: { wkid: 4326 }
  }
  const wkt = edits.toWkt(geom)
  assert.ok(wkt.includes('POINT'))
})

test('edits.toWkt: WebMercator (3857) to WGS84', async t => {
  // WebMercator uses easting/northing, must convert
  const geom = {
    x: -8235875,
    y: 4963144,
    spatialReference: { wkid: 3857 }
  }
  const wkt = edits.toWkt(geom)
  assert.ok(wkt.includes('POINT'))
  // After conversion, lon should be near -74, lat near 40
  assert.match(wkt, /POINT \(-?[\d.]+\s+[\d.]+\)/)
})

test('edits.toWkt: WebMercator 102100 (alternate code)', async t => {
  const geom = {
    x: -8235875,
    y: 4963144,
    spatialReference: { latestWkid: 102100 }
  }
  const wkt = edits.toWkt(geom)
  assert.ok(wkt.includes('POINT'))
})

test('edits.toWkt: multipoint', async t => {
  const geom = {
    points: [[-74, 40.7], [-73.9, 40.8]],
    spatialReference: { wkid: 4326 }
  }
  const wkt = edits.toWkt(geom)
  assert.match(wkt, /MULTIPOINT \(\(-74 40\.7\), \(-73\.9 40\.8\)\)/)
})

test('edits.toWkt: single linestring', async t => {
  const geom = {
    paths: [[[-74, 40], [-73, 41], [-72, 42]]],
    spatialReference: { wkid: 4326 }
  }
  const wkt = edits.toWkt(geom)
  assert.match(wkt, /LINESTRING/)
})

test('edits.toWkt: multilinestring', async t => {
  const geom = {
    paths: [[[-74, 40], [-73, 41]], [[-72, 42], [-71, 43]]],
    spatialReference: { wkid: 4326 }
  }
  const wkt = edits.toWkt(geom)
  assert.match(wkt, /MULTILINESTRING/)
})

test('edits.toWkt: polygon', async t => {
  const geom = {
    rings: [[[-74, 40], [-73, 40], [-73, 41], [-74, 41], [-74, 40]]],
    spatialReference: { wkid: 4326 }
  }
  const wkt = edits.toWkt(geom)
  assert.match(wkt, /POLYGON/)
})

test('edits.toWkt: non-finite coordinates throw', async t => {
  const geom = {
    x: Infinity,
    y: 40.7
  }
  assert.throws(() => edits.toWkt(geom), /Unsupported|must be numbers/)
})

test('edits.toWkt: unsupported geometry throws', async t => {
  const geom = { some: 'unknown' }
  assert.throws(() => edits.toWkt(geom), /Unsupported geometry/)
})

// ============ parseList tests ============

test('edits.parseList: JSON array', async t => {
  const result = edits.parseList('[1, 2, 3]')
  assert.deepEqual(result, [1, 2, 3])
})

test('edits.parseList: CSV string', async t => {
  const result = edits.parseList('a, b, c')
  assert.deepEqual(result, ['a', 'b', 'c'])
})

test('edits.parseList: array input', async t => {
  const arr = [1, 2, 3]
  const result = edits.parseList(arr)
  assert.equal(result, arr)
})

test('edits.parseList: empty string', async t => {
  const result = edits.parseList('')
  assert.deepEqual(result, [])
})

test('edits.parseList: null/undefined', async t => {
  assert.deepEqual(edits.parseList(null), [])
  assert.deepEqual(edits.parseList(undefined), [])
})

test('edits.parseList: whitespace trimmed', async t => {
  const result = edits.parseList('  a  ,  b  ,  c  ')
  assert.deepEqual(result, ['a', 'b', 'c'])
})

// ============ planEdits tests ============

test('edits.planEdits: add with attributes and geometry', async t => {
  const columns = [
    { name: 'id', type: 'bigint' },
    { name: 'name', type: 'string' },
    { name: 'geometry_wkt', type: 'string' }
  ]
  const spec = {
    objectId: 'id',
    geometryColumn: 'geometry_wkt',
    geometryFormat: 'wkt',
    source: 'table'
  }
  const adds = [{
    attributes: { name: 'Point A' },
    geometry: { x: -74, y: 40.7 }
  }]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds,
    updates: [],
    deletes: []
  })

  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, 'add')
  assert.ok(plan[0].nextIdSql)
  assert.ok(plan[0].sql)
  assert.ok(plan[0].sql.includes('INSERT'))
})

test('edits.planEdits: update with geometry', async t => {
  const columns = [
    { name: 'id', type: 'bigint' },
    { name: 'name', type: 'string' },
    { name: 'geometry_wkt', type: 'string' }
  ]
  const spec = {
    objectId: 'id',
    geometryColumn: 'geometry_wkt',
    geometryFormat: 'wkt',
    source: 'table'
  }
  const updates = [{
    attributes: { id: 123, name: 'Updated' },
    geometry: { x: -74, y: 40.7 }
  }]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds: [],
    updates,
    deletes: []
  })

  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, 'update')
  assert.equal(plan[0].id, 123)
  assert.ok(plan[0].sql.includes('UPDATE'))
  assert.ok(plan[0].sql.includes('WHERE'))
})

test('edits.planEdits: delete', async t => {
  const columns = [
    { name: 'id', type: 'bigint' }
  ]
  const spec = {
    objectId: 'id',
    geometryColumn: 'geom',
    geometryFormat: 'wkt'
  }
  const deletes = [123, 456]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds: [],
    updates: [],
    deletes
  })

  assert.equal(plan.length, 2)
  assert.equal(plan[0].kind, 'delete')
  assert.equal(plan[0].id, 123)
  assert.ok(plan[0].sql.includes('DELETE'))
  assert.equal(plan[1].id, 456)
})

test('edits.planEdits: update without valid id gives error', async t => {
  const columns = [{ name: 'id', type: 'bigint' }]
  const spec = { objectId: 'id' }
  const updates = [{
    attributes: { name: 'No ID' }
  }]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds: [],
    updates,
    deletes: []
  })

  assert.equal(plan.length, 1)
  assert.equal(plan[0].kind, 'update')
  assert.ok(plan[0].error)
})

test('edits.planEdits: skips helper columns', async t => {
  const columns = [
    { name: 'id', type: 'bigint' },
    { name: '_xmin', type: 'double' },
    { name: '_ymin', type: 'double' },
    { name: 'name', type: 'string' }
  ]
  const spec = {
    objectId: 'id',
    bboxColumns: true
  }
  const adds = [{
    attributes: { _xmin: 0, _ymin: 0, name: 'Test' }
  }]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds,
    updates: [],
    deletes: []
  })

  assert.ok(plan[0].sql)
  assert.ok(!plan[0].sql.includes('_xmin'))
})

test('edits.planEdits: native GEOMETRY column', async t => {
  const columns = [
    { name: 'id', type: 'bigint' },
    { name: 'geometry', type: 'geometry(4326)' }
  ]
  const spec = {
    objectId: 'id',
    geometryColumn: 'geometry',
    geometryFormat: 'expr'
  }
  const adds = [{
    geometry: { x: -74, y: 40.7 }
  }]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds,
    updates: [],
    deletes: []
  })

  assert.ok(plan[0].sql)
  assert.ok(plan[0].sql.includes('ST_GeomFromText'))
})

test('edits.planEdits: lon/lat columns', async t => {
  const columns = [
    { name: 'id', type: 'bigint' },
    { name: 'lon', type: 'double' },
    { name: 'lat', type: 'double' }
  ]
  const spec = {
    objectId: 'id',
    geometryFormat: 'expr',
    geometryExpr: 'ST_Point(lon, lat, 4326)'
  }
  const adds = [{
    geometry: { x: -74, y: 40.7 }
  }]

  const plan = edits.planEdits({
    table: 'test.schema.points',
    spec,
    columns,
    adds,
    updates: [],
    deletes: []
  })

  assert.ok(plan[0].sql)
  assert.ok(plan[0].sql.includes('lon') || plan[0].sql.includes('ST_X'))
})

test('edits.editableSpec: true for integer id, no synthetic, no bbox', async t => {
  const spec = { objectId: 'id' }
  assert.equal(edits.editableSpec(spec), true)
})

test('edits.editableSpec: false for synthetic id', async t => {
  const spec = { objectId: 'objectid', objectIdExpr: 'CAST(...)' }
  assert.equal(edits.editableSpec(spec), false)
})

test('edits.editableSpec: false for bbox columns (map-optimized)', async t => {
  const spec = { objectId: 'id', bboxColumns: true }
  assert.equal(edits.editableSpec(spec), false)
})

test('edits.editableSpec: false for null spec', async t => {
  assert.equal(edits.editableSpec(null), false)
})

test('edits.applyPlan: runs each edit, reports per edit, and stops running once one is refused for permissions', async () => {
  const { explain } = require('../lib/errors')
  const ran = []
  const plan = [
    { kind: 'add', nextIdSql: 'SELECT max+1 AS n', sql: 'INSERT 1', params: { a: 1 } },
    { kind: 'update', id: 7, error: 'Update needs an objectid' },
    { kind: 'update', id: 8, sql: 'UPDATE 8', params: {} },
    { kind: 'delete', id: 9, sql: 'DELETE 9', params: {} }
  ]
  const run = async (sql, params) => {
    ran.push([sql, params])
    if (sql === 'SELECT max+1 AS n') return [{ n: 41 }]
    if (sql === 'UPDATE 8') throw new Error("PERMISSION_DENIED: User does not have MODIFY on Table 'a.b.c'.")
    return []
  }
  const { results, changed } = await edits.applyPlan(plan, run, explain)
  assert.equal(changed, true)
  assert.deepEqual(results.addResults, [{ objectId: 41, success: true }])
  assert.deepEqual(ran[1], ['INSERT 1', { a: 1, newid: 41 }])
  assert.deepEqual(results.updateResults[0], { objectId: 7, success: false, error: { code: 400, description: 'Update needs an objectid' } })
  assert.equal(results.updateResults[1].error.code, 403)
  assert.match(results.updateResults[1].error.description, /^You don't have MODIFY on table a\.b\.c/)
  assert.deepEqual(results.deleteResults[0].error, results.updateResults[1].error, 'later edits get the same refusal')
  assert.ok(!ran.some(([sql]) => sql === 'DELETE 9'), 'and are not run')
  const none = await edits.applyPlan([{ kind: 'delete', id: 1, error: 'bad id' }], run, explain)
  assert.equal(none.changed, false)
})
