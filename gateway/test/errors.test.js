// lib/errors.js: Databricks errors as a status and a sentence that says what's missing
const test = require('node:test')
const assert = require('node:assert/strict')
const { explain, sendExplained, ExplainedError } = require('../lib/errors')

test('explain: a missing grant names the privilege, the object and who can fix it', () => {
  // Real messages from a SQL warehouse
  let e = explain(new Error("BAD_REQUEST PERMISSION_DENIED: User does not have MODIFY on Table 'samples.nyctaxi.trips'."))
  assert.equal(e.status, 403)
  assert.equal(e.code, 'permission')
  assert.equal(e.message, "You don't have MODIFY on table samples.nyctaxi.trips. Ask its owner or a Databricks admin to grant it.")
  e = explain(new Error("[INSUFFICIENT_PERMISSIONS] Insufficient privileges:\nUser does not have CREATE TABLE and USE SCHEMA on Schema 'main.default'. SQLSTATE: 42501"))
  assert.equal(e.status, 403)
  assert.match(e.message, /^You don't have CREATE TABLE and USE SCHEMA on schema main\.default\./)
  e = explain(new Error('PERMISSION_DENIED: User does not have USE CATALOG on Catalog \'secret\'.'))
  assert.match(e.message, /USE CATALOG on catalog secret/)
})

test('explain: warehouse refusals, other refusals, missing tables, expired sign-ins', () => {
  let e = explain(new Error('PERMISSION_DENIED: You are not authorized to use this SQL warehouse'))
  assert.equal(e.status, 403)
  assert.match(e.message, /CAN USE on it/)
  e = explain(new Error('PERMISSION_DENIED: something else entirely'))
  assert.equal(e.status, 403)
  assert.match(e.message, /^Unity Catalog refused this for your account: PERMISSION_DENIED/)
  e = explain(new Error('[TABLE_OR_VIEW_NOT_FOUND] The table or view `main`.`geo`.`roads` cannot be found. Verify the spelling. SQLSTATE: 42P01'))
  assert.equal(e.status, 404)
  assert.match(e.message, /^main\.geo\.roads wasn't found, or you can't see it\. Reading a table needs USE CATALOG, USE SCHEMA and SELECT\.$/)
  e = explain(new Error('[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column with name `nope` cannot be resolved'))
  assert.equal(e.status, 500, 'a missing column is not a missing table')
  e = explain(new Error('HTTP 401: invalid access token'))
  assert.equal(e.status, 401)
  assert.match(e.message, /Sign in again/)
})

test('explain: our own 4xx errors pass through; others keep their first line without SQLSTATE', () => {
  const own = Object.assign(new Error('catalog.schema expected'), { status: 400 })
  assert.deepEqual([explain(own).status, explain(own).message], [400, 'catalog.schema expected'])
  const e = explain(new Error('[DIVIDE_BY_ZERO] Division by zero. SQLSTATE: 22012\n  at line 3'))
  assert.deepEqual([e.status, e.message], [500, '[DIVIDE_BY_ZERO] Division by zero.'])
  const already = new ExplainedError(409, 'taken', 'conflict')
  assert.equal(explain(already), already)
  assert.equal(explain(null).message, 'Something went wrong')
})

test('sendExplained: JSON { error, code } with the explained status', () => {
  const sent = {}
  const res = { status (s) { sent.status = s; return this }, json (b) { sent.body = b } }
  sendExplained(res, new Error("PERMISSION_DENIED: User does not have SELECT on Table 'a.b.c'."))
  assert.equal(sent.status, 403)
  assert.deepEqual(Object.keys(sent.body), ['error', 'code'])
  assert.equal(sent.body.code, 'permission')
})
