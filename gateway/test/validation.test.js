/*
  validation.test.js — Tests for validation.js (SQL injection prevention)
*/
const test = require('node:test')
const assert = require('node:assert/strict')

const { validateWhereClause, validateColumnName, validateColumnList } = require('../provider/validation')

// ============ validateWhereClause tests ============

test('validation.validateWhereClause: simple equality', async t => {
  const result = validateWhereClause('name = \'John\'')
  assert.equal(result.valid, true)
  assert.equal(result.error, null)
})

test('validation.validateWhereClause: comparison operators', async t => {
  const result = validateWhereClause('age > 18 AND status = \'active\'')
  assert.equal(result.valid, true)
})

test('validation.validateWhereClause: IN clause', async t => {
  const result = validateWhereClause('status IN (\'active\', \'pending\')')
  assert.equal(result.valid, true)
})

test('validation.validateWhereClause: LIKE operator', async t => {
  const result = validateWhereClause('name LIKE \'John%\'')
  assert.equal(result.valid, true)
})

test('validation.validateWhereClause: empty string', async t => {
  const result = validateWhereClause('')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: null', async t => {
  const result = validateWhereClause(null)
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: DROP keyword rejected', async t => {
  const result = validateWhereClause('name = \'x\' DROP TABLE users')
  assert.equal(result.valid, false)
  assert.ok(result.error.includes('keyword'))
})

test('validation.validateWhereClause: CREATE keyword rejected', async t => {
  const result = validateWhereClause('CREATE TABLE x (id INT)')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: ALTER keyword rejected', async t => {
  const result = validateWhereClause('ALTER TABLE users ADD COLUMN')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: INSERT keyword rejected', async t => {
  const result = validateWhereClause('INSERT INTO x VALUES (1)')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: UPDATE keyword rejected', async t => {
  const result = validateWhereClause('UPDATE users SET name = \'x\'')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: DELETE keyword rejected', async t => {
  const result = validateWhereClause('DELETE FROM users')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: UNION keyword rejected', async t => {
  const result = validateWhereClause('id = 1 UNION SELECT * FROM users')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: GRANT keyword rejected', async t => {
  const result = validateWhereClause('id = 1; GRANT SELECT ON * TO user')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: case-insensitive keyword detection', async t => {
  const result = validateWhereClause('id = 1 drop table x')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: keyword in string rejected (conservative)', async t => {
  // The validation uses a simple regex that catches keywords even in strings
  // This is conservative but effective at blocking most injection attempts
  // Future: could parse more carefully to allow keywords in string literals
  const result = validateWhereClause('name = \'drop\'')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: unparseable SQL rejected', async t => {
  const result = validateWhereClause('this is not valid SQL syntax !!!!')
  assert.equal(result.valid, false)
})

test('validation.validateWhereClause: number comparison', async t => {
  const result = validateWhereClause('id > 100 AND id < 1000')
  assert.equal(result.valid, true)
})

// ============ validateColumnName tests ============

test('validation.validateColumnName: simple name', async t => {
  const result = validateColumnName('age')
  assert.equal(result.valid, true)
})

test('validation.validateColumnName: underscore prefix', async t => {
  const result = validateColumnName('_id')
  assert.equal(result.valid, true)
})

test('validation.validateColumnName: mixed case', async t => {
  const result = validateColumnName('UserName')
  assert.equal(result.valid, true)
})

test('validation.validateColumnName: with numbers', async t => {
  const result = validateColumnName('column_123')
  assert.equal(result.valid, true)
})

test('validation.validateColumnName: empty string', async t => {
  const result = validateColumnName('')
  assert.equal(result.valid, false)
})

test('validation.validateColumnName: null', async t => {
  const result = validateColumnName(null)
  assert.equal(result.valid, false)
})

test('validation.validateColumnName: starts with number rejected', async t => {
  const result = validateColumnName('123column')
  assert.equal(result.valid, false)
})

test('validation.validateColumnName: space rejected', async t => {
  const result = validateColumnName('col name')
  assert.equal(result.valid, false)
})

test('validation.validateColumnName: dash rejected', async t => {
  const result = validateColumnName('col-name')
  assert.equal(result.valid, false)
})

test('validation.validateColumnName: special chars rejected', async t => {
  const result = validateColumnName('col@name')
  assert.equal(result.valid, false)
})

test('validation.validateColumnName: whitespace trimmed', async t => {
  const result = validateColumnName('  column  ')
  assert.equal(result.valid, true)
})

// ============ validateColumnList tests ============

test('validation.validateColumnList: single column', async t => {
  const result = validateColumnList('id')
  assert.equal(result.valid, true)
  assert.deepEqual(result.fields, ['id'])
})

test('validation.validateColumnList: multiple columns', async t => {
  const result = validateColumnList('id, name, status')
  assert.equal(result.valid, true)
  assert.deepEqual(result.fields, ['id', 'name', 'status'])
})

test('validation.validateColumnList: whitespace around commas', async t => {
  const result = validateColumnList('  col1  ,  col2  ,  col3  ')
  assert.equal(result.valid, true)
  assert.deepEqual(result.fields, ['col1', 'col2', 'col3'])
})

test('validation.validateColumnList: empty string', async t => {
  const result = validateColumnList('')
  assert.equal(result.valid, false)
})

test('validation.validateColumnList: null', async t => {
  const result = validateColumnList(null)
  assert.equal(result.valid, false)
})

test('validation.validateColumnList: invalid column name in list', async t => {
  const result = validateColumnList('id, 123invalid, name')
  assert.equal(result.valid, false)
})

test('validation.validateColumnList: only whitespace', async t => {
  const result = validateColumnList('  ,  ,  ')
  assert.equal(result.valid, false)
})

test('validation.validateColumnList: underscore columns', async t => {
  const result = validateColumnList('_id, _name, _status')
  assert.equal(result.valid, true)
  assert.deepEqual(result.fields, ['_id', '_name', '_status'])
})

test('validation.validateColumnList: mixed valid and invalid rejected', async t => {
  const result = validateColumnList('valid_col, "quoted", another_col')
  assert.equal(result.valid, false)
})
