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

test('validation.validateWhereClause: a keyword inside a string literal is a value, not SQL', async t => {
  assert.equal(validateWhereClause('name = \'drop\'').valid, true)
  assert.equal(validateWhereClause('name = \'a\' OR 1=1; DROP TABLE x').valid, false)
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

test('validation.validateWhereClause: date literals and intervals ArcGIS clients send', async t => {
  for (const w of ["went_dark >= timestamp '2024-07-04 00:00:00'", "d BETWEEN DATE '2024-07-01' AND DATE '2024-07-07'",
    "t BETWEEN CURRENT_TIMESTAMP - INTERVAL '7' DAY AND CURRENT_TIMESTAMP", "TIMESTAMP '2024-07-04 00:00:00' < t AND kind = 'a'"]) {
    assert.equal(validateWhereClause(w).valid, true, w)
  }
  for (const w of ["t = timestamp '1' OR 1=1; DROP TABLE x", "t = timestamp 'x' UNION SELECT 1", 't = DATE (SELECT max(t) FROM x)']) {
    assert.equal(validateWhereClause(w).valid, false, w)
  }
})

test('validation.validateWhereClause: functions that reach beyond the table are refused', async t => {
  for (const w of ["secret('scope', 'key') LIKE 'a%'", "try_secret('s', 'k') = 'x'", "`ai_query`('m', 'p') = 'x'",
    "AI_GEN('x') = 'y'", "reflect('java.lang.Thread', 'sleep', 100000) IS NULL", "java_method('a', 'b') = 1",
    "http_request('c', 'GET') IS NOT NULL", "kind = 'a' AND (secret('s', 'k') = 'x' OR 1 = 1)"]) {
    assert.equal(validateWhereClause(w).valid, false, w)
  }
  for (const w of ["UPPER(name) LIKE 'A%'", "LOWER(kind) = 'a' AND COALESCE(n, 0) > 1", "name = 'secret(1)'"]) {
    assert.equal(validateWhereClause(w).valid, true, w)
  }
})

test('validation.validateWhereClause: comments and trailing clauses are refused', async t => {
  for (const w of ['1=1 -- x', '1=1 /* x */', 'x = 1 /*! OR y IN (SELECT 1) */', 'x = 1 # y', '1=1 ORDER BY 1', '1=1 LIMIT 1', '1=1 GROUP BY x']) {
    assert.equal(validateWhereClause(w).valid, false, w)
  }
  for (const w of ["name = 'a--b'", "tag = '#1' AND note = '/* not a comment */'", '`odd--name` = 1']) {
    assert.equal(validateWhereClause(w).valid, true, w)
  }
})

test('validation.validateWhereClause: quotes escaped the way ArcGIS and Databricks do', async t => {
  for (const w of ["name = 'O''Brien'", "x = ''", "x = 'a\\\\' OR y = 1"]) {
    assert.equal(validateWhereClause(w).valid, true, w)
  }
  for (const w of ["x = 'it''s' AND y IN (SELECT 1)", "x = INTERVAL 'a\\'' OR x IN (SELECT s FROM c.s.t) OR ''' DAY"]) {
    assert.equal(validateWhereClause(w).valid, false, w)
  }
})

test('validation.validateWhereClause: a keyword inside a literal does not move where literals end', async t => {
  for (const w of ["a = 'INTERVAL' or secret(chr(115), chr(107)) = chr(120) or b = ' DAY'",
    "a = 'INTERVAL' or 1 = (select count(*) from other.s.t) or b = ' DAY'",
    "a = \"INTERVAL\" or x in (select 1) or b = ' DAY'", "`INTERVAL` = 'x' or x in (select 1) or b = ' DAY'"]) {
    assert.equal(validateWhereClause(w).valid, false, w)
  }
  for (const w of ["status = 'Pending Update'", "note LIKE '%delete%'", "t > CURRENT_TIMESTAMP - INTERVAL '7' DAY AND n = 'O''Brien'"]) {
    assert.equal(validateWhereClause(w).valid, true, w)
  }
})

test('validation.validateWhereClause: raw, hex and Unicode literals are refused', async t => {
  for (const w of ["x = r'\\' OR secret('s', 'k') = 'x' OR y = '", "x = R'abc'", "x = X'41'", "x = U&'\\' UESCAPE '!' OR secret('s', 'k') = '"]) {
    assert.equal(validateWhereClause(w).valid, false, w)
  }
  for (const w of ["name='ArcGIS'", "t >= DATE'2024-01-01'", 'x="abc"']) {
    assert.equal(validateWhereClause(w).valid, true, w)
  }
})
