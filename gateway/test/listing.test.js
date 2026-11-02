// The catalog listing's metadata query (lib/listing.js): scope predicates and the primary-key rule
const test = require('node:test')
const assert = require('node:assert/strict')
const { listingSql, INTEGER_KEY_TYPES } = require('../lib/listing')

test('listingSql: a primary key counts as the id only when it is a single integer column', () => {
  const sql = listingSql({ scoped: ['a'], excludeCatalogs: ['system'] })
  // The key's column type is joined in from information_schema.columns ...
  assert.match(sql, /LEFT JOIN system\.information_schema\.columns c\s+ON c\.table_catalog = k\.table_catalog AND c\.table_schema = k\.table_schema AND c\.table_name = k\.table_name AND c\.column_name = k\.column_name/)
  assert.match(sql, /min\(lower\(c\.data_type\)\) dt/)
  // ... and the CASE requires one column of an integer type, the same rule spec.js applies when it resolves a table
  assert.match(sql, /CASE WHEN pk\.n = 1 AND pk\.dt IN \('tinyint','smallint','int','integer','bigint','long'\) THEN pk\.col END AS pk/)
  assert.ok(INTEGER_KEY_TYPES.includes('long'), 'information_schema spells BIGINT as long')
  assert.ok(!INTEGER_KEY_TYPES.includes('string'))
})

test('listingSql: catalog scope and exclusions apply to both the geometry and the key lookups', () => {
  const sql = listingSql({ scoped: ['a', 'b'], excludeCatalogs: ['system', 'samples'] })
  assert.match(sql, /WHERE table_catalog IN \('a','b'\) AND table_catalog NOT IN \('system','samples'\) AND table_schema <> 'information_schema'/)
  assert.match(sql, /WHERE t\.table_catalog IN \('a','b'\) AND t\.table_catalog NOT IN \('system','samples'\) AND t\.constraint_type = 'PRIMARY KEY'/)
  const everything = listingSql({ scoped: [], excludeCatalogs: [] })
  assert.match(everything, /WHERE TRUE AND table_schema <> 'information_schema'/)
  assert.match(everything, /WHERE TRUE AND t\.constraint_type = 'PRIMARY KEY'/)
})

test('listingSql: only geometry-typed columns are listed, hidden tables skipped, quotes in names dropped', () => {
  const sql = listingSql({ scoped: ["a'b"], excludeCatalogs: [] })
  assert.match(sql, /lower\(data_type\) LIKE 'geometry%' OR lower\(data_type\) LIKE 'geography%'/)
  assert.match(sql, /table_name NOT LIKE '\\_\\_%'/, 'tables whose names start with __ are hidden')
  assert.match(sql, /IN \('ab'\)/, 'a quote in a catalog name cannot end the literal')
})
