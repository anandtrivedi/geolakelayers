// lib/access.js: what the caller's grants allow, read from information_schema
const test = require('node:test')
const assert = require('node:assert/strict')
const { check, missingFor, grantsSql, target } = require('../lib/access')

const T = target('main.geo.roads')
const S = target('main.geo')
const rows = list => list.map(([level, privilege_type]) => ({ level, privilege_type }))

test('target: two or three plain parts', () => {
  assert.deepEqual(T, { catalog: 'main', schema: 'geo', table: 'roads', name: 'main.geo.roads' })
  assert.deepEqual(S, { catalog: 'main', schema: 'geo', table: null, name: 'main.geo' })
  for (const bad of ['', 'main', 'a.b.c.d', 'a.b-c.d', "a.b.c'; DROP", null]) assert.equal(target(bad), null, String(bad))
})

test('grantsSql: the caller\'s grants and ownerships at each level, names as parameters', () => {
  const sql = grantsSql(T)
  for (const view of ['table_privileges', 'tables', 'schema_privileges', 'schemata', 'catalog_privileges', 'catalogs']) assert.match(sql, new RegExp(`\`main\`\\.information_schema\\.${view} `))
  assert.match(sql, /grantee = current_user\(\) OR is_account_group_member\(g\.grantee\) OR is_member\(g\.grantee\)/)
  assert.ok(!sql.includes("'roads'"), 'table name is a parameter')
  assert.ok(!grantsSql(S).includes('table_privileges'), 'a schema check skips table views')
})

test('missingFor: direct grants, inheritance, ALL PRIVILEGES and ownership', () => {
  const use = [['schema', 'USE_SCHEMA'], ['catalog', 'USE_CATALOG']]
  assert.deepEqual(missingFor('SELECT', rows([...use, ['table', 'SELECT']]), T), [])
  assert.deepEqual(missingFor('MODIFY', rows([...use, ['table', 'SELECT']]), T), ['MODIFY on table main.geo.roads'])
  assert.deepEqual(missingFor('MODIFY', rows([...use, ['catalog', 'MODIFY']]), T), [], 'catalog-level grants inherit')
  assert.deepEqual(missingFor('MODIFY', rows([['catalog', 'ALL_PRIVILEGES']]), T), [], 'ALL PRIVILEGES on the catalog covers USE too')
  assert.deepEqual(missingFor('MODIFY', rows([['catalog', 'OWNER']]), T), [], 'the catalog owner can do anything in it')
  assert.deepEqual(missingFor('MODIFY', rows([['table', 'OWNER'], ['schema', 'USE_SCHEMA']]), T), ['USE CATALOG on catalog main'], 'a table owner still needs USE CATALOG')
  assert.deepEqual(missingFor('CREATE_TABLE', rows([['schema', 'OWNER']]), S), ['USE CATALOG on catalog main'])
  assert.deepEqual(missingFor('CREATE_TABLE', rows([]), S), ['CREATE TABLE on schema main.geo', 'USE SCHEMA on schema main.geo', 'USE CATALOG on catalog main'])
  assert.deepEqual(missingFor('CREATE_TABLE', rows([['table', 'ALL_PRIVILEGES'], ...use]), S), ['CREATE TABLE on schema main.geo'], 'table grants never count for creating')
  assert.deepEqual(missingFor('SELECT', [{ level: 'table', privilege_type: 'select' }, ...rows(use)], T), [], 'case and spaces are normalized')
})

test('check: runs as the caller with parameters; unreadable grants are "unknown", bad input is a 400', async () => {
  const calls = []
  const run = async (sql, params) => { calls.push(params); return rows([['catalog', 'USE_CATALOG'], ['schema', 'USE_SCHEMA'], ['table', 'SELECT']]) }
  assert.deepEqual(await check(run, 'SELECT', 'main.geo.roads'), { ok: true })
  assert.deepEqual(calls[0], { schema: 'geo', table: 'roads', catalog: 'main' })
  assert.deepEqual(await check(run, 'MODIFY', 'main.geo.roads'), { ok: false, missing: ['MODIFY on table main.geo.roads'] })
  const unknown = await check(async () => { throw new Error('PERMISSION_DENIED: no information_schema\nmore') }, 'MODIFY', 'main.geo.roads')
  assert.equal(unknown.ok, null)
  assert.match(unknown.reason, /^Couldn't read the grants on main\.geo\.roads: PERMISSION_DENIED: no information_schema$/)
  for (const [action, name] of [['DROP', 'main.geo.roads'], ['MODIFY', 'main.geo'], ['CREATE_TABLE', 'main.geo.roads'], ['SELECT', 'x']]) {
    await assert.rejects(check(run, action, name), e => e.status === 400, `${action} ${name}`)
  }
})
