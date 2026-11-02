// Filters on open tables (read as the app's service principal) may call only allow-listed functions
process.env.OPEN_TABLES = 'cat.sch.open_one'
const test = require('node:test')
const assert = require('node:assert/strict')
const layerSpec = require('../provider/spec')
const Model = require('../provider/model')
const { pushValidatedWhere } = Model._internals

const specFor = table => ({ table, objectId: 'objectid', idSource: 'primary key', geometryColumn: 'g', geometryFormat: 'expr', geometryExpr: 'g', geometrySource: 'geometry(4326)', spatialReference: 4326 })

test('pushValidatedWhere: an open table refuses functions off the allow-list; other tables keep the deny-list only', () => {
  const chr = "chr(115) = 's'"
  layerSpec.store.run(specFor('cat.sch.open_one'), () => {
    assert.throws(() => pushValidatedWhere([], chr), /not allowed on this table/)
    const ok = []
    pushValidatedWhere(ok, "upper(name) = 'X' AND ST_Intersects(g, ST_GeomFromText('POINT(0 0)', 4326))")
    assert.deepEqual(ok, ["(upper(name) = 'X' AND ST_Intersects(g, ST_GeomFromText('POINT(0 0)', 4326)))"])
    assert.throws(() => pushValidatedWhere([], "secret('s', 'k') = 'x'"), /disallowed function secret/)
  })
  layerSpec.store.run(specFor('cat.sch.mine'), () => {
    const clauses = []
    pushValidatedWhere(clauses, chr)
    assert.deepEqual(clauses, ["(chr(115) = 's')"], 'a table read as the caller accepts it')
    assert.throws(() => pushValidatedWhere([], "secret('s', 'k') = 'x'"), /disallowed function secret/, 'the deny-list applies everywhere')
  })
  assert.equal(layerSpec.isOpenTable('CAT.SCH.OPEN_ONE'), true, 'open table names compare case-insensitively')
})

test('resolveSpec records the table name on the spec, so filters know which table they are for', async () => {
  const rows = { describe: [{ col_name: 'id', data_type: 'bigint' }, { col_name: 'g', data_type: 'geometry(4326)' }], 'primary key': [{ c: 'id' }], geomtype: [{ t: 'st_point' }] }
  const spec = await layerSpec.resolveSpec('cat.sch.named', async (sql, kind) => rows[kind] || [], 'test-open-tables')
  assert.equal(spec.table, 'cat.sch.named')
  assert.equal(spec.objectId, 'id')
})
