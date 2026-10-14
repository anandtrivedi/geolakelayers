/*
  http.test.js — Tests for lib/http.js helpers
*/
const test = require('node:test')
const assert = require('node:assert/strict')

const http = require('../lib/http')

// ============ list function tests ============

test('http.list: comma-separated string', async t => {
  const result = http.list('a,b,c')
  assert.deepEqual(result, ['a', 'b', 'c'])
})

test('http.list: with whitespace', async t => {
  const result = http.list('  a  ,  b  ,  c  ')
  assert.deepEqual(result, ['a', 'b', 'c'])
})

test('http.list: dash means none', async t => {
  const result = http.list('-')
  assert.deepEqual(result, [])
})

test('http.list: empty string', async t => {
  const result = http.list('')
  assert.deepEqual(result, [])
})

test('http.list: null/undefined', async t => {
  assert.deepEqual(http.list(null), [])
  assert.deepEqual(http.list(undefined), [])
})

test('http.list: mixed with empty entries', async t => {
  const result = http.list('a,,b,-,c')
  assert.deepEqual(result, ['a', 'b', 'c'])
})

// ============ parseDirectory function tests ============

test('http.parseDirectory: single gateway', async t => {
  const result = http.parseDirectory('workspace1=https://app1.databricksapps.com')
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'workspace1')
  assert.equal(result[0].url, 'https://app1.databricksapps.com')
})

test('http.parseDirectory: multiple gateways', async t => {
  const result = http.parseDirectory('ws1=https://app1.databricksapps.com;ws2=https://app2.databricksapps.com')
  assert.equal(result.length, 2)
  assert.equal(result[0].name, 'ws1')
  assert.equal(result[1].name, 'ws2')
})

test('http.parseDirectory: trailing slash removed', async t => {
  const result = http.parseDirectory('workspace1=https://app1.databricksapps.com/')
  assert.equal(result[0].url, 'https://app1.databricksapps.com')
})

test('http.parseDirectory: dash means none', async t => {
  const result = http.parseDirectory('-')
  assert.deepEqual(result, [])
})

test('http.parseDirectory: non-https rejected', async t => {
  const result = http.parseDirectory('ws=http://app1.local')
  assert.equal(result.length, 0)
})

test('http.parseDirectory: malformed entry skipped', async t => {
  const result = http.parseDirectory('ws1=https://app1.com;no_equals;ws2=https://app2.com')
  assert.equal(result.length, 2)
  assert.equal(result[0].name, 'ws1')
  assert.equal(result[1].name, 'ws2')
})

test('http.parseDirectory: whitespace around entries', async t => {
  const result = http.parseDirectory('  ws1 = https://app1.com  ;  ws2 = https://app2.com  ')
  assert.equal(result.length, 2)
})

// ============ requestedCatalogs function tests ============

test('http.requestedCatalogs: single catalog from query', async t => {
  const req = { query: { catalogs: 'cat1' } }
  const result = http.requestedCatalogs(req, [])
  assert.deepEqual(result, ['cat1'])
})

test('http.requestedCatalogs: multiple catalogs comma-separated', async t => {
  const req = { query: { catalogs: 'cat1,cat2,cat3' } }
  const result = http.requestedCatalogs(req, [])
  assert.deepEqual(result, ['cat1', 'cat2', 'cat3'])
})

test('http.requestedCatalogs: invalid names filtered out', async t => {
  const req = { query: { catalogs: 'cat1,"quoted",cat2' } }
  const result = http.requestedCatalogs(req, [])
  assert.deepEqual(result, ['cat1', 'cat2'])
})

test('http.requestedCatalogs: cap enforced', async t => {
  const req = { query: { catalogs: 'cat1,cat2,cat3' } }
  const cap = ['cat2', 'cat3', 'cat4']
  const result = http.requestedCatalogs(req, cap)
  assert.deepEqual(result, ['cat2', 'cat3'])
})

test('http.requestedCatalogs: empty request uses cap', async t => {
  const req = { query: {} }
  const cap = ['cat1', 'cat2']
  const result = http.requestedCatalogs(req, cap)
  assert.deepEqual(result, ['cat1', 'cat2'])
})

test('http.requestedCatalogs: no cap, empty request', async t => {
  const req = { query: {} }
  const result = http.requestedCatalogs(req, [])
  assert.deepEqual(result, [])
})

// ============ PLAIN regex tests ============

test('http.PLAIN: alphanumeric underscore', async t => {
  assert.ok(http.PLAIN.test('valid_name'))
  assert.ok(http.PLAIN.test('_leading_underscore'))
  assert.ok(http.PLAIN.test('TrailingUnderscore_'))
  assert.ok(http.PLAIN.test('name123'))
})

test('http.PLAIN: rejects non-alphanumeric', async t => {
  assert.ok(!http.PLAIN.test('123invalid'))
  assert.ok(!http.PLAIN.test('invalid-name'))
  assert.ok(!http.PLAIN.test('invalid.name'))
  assert.ok(!http.PLAIN.test('invalid name'))
  assert.ok(!http.PLAIN.test('"quoted"'))
})

// ============ THREE_PART regex tests ============

test('http.THREE_PART: catalog.schema.table', async t => {
  assert.ok(http.THREE_PART.test('catalog.schema.table'))
  assert.ok(http.THREE_PART.test('my_cat.my_schema.my_table'))
  assert.ok(http.THREE_PART.test('cat1.s1.t1'))
})

test('http.THREE_PART: rejects invalid formats', async t => {
  assert.ok(!http.THREE_PART.test('two.parts'))
  assert.ok(!http.THREE_PART.test('one'))
  assert.ok(!http.THREE_PART.test('four.parts.three.here'))
  assert.ok(!http.THREE_PART.test('a.b.c-invalid'))
})

// ============ obo function tests ============

test('http.obo: returns token when USE_OBO not false', async t => {
  process.env.USE_OBO = 'true'
  const req = { headers: { 'x-forwarded-access-token': 'token123' } }
  const result = http.obo(req)
  assert.equal(result, 'token123')
})

test('http.obo: returns null when USE_OBO false', async t => {
  process.env.USE_OBO = 'false'
  const req = { headers: { 'x-forwarded-access-token': 'token123' } }
  const result = http.obo(req)
  assert.equal(result, null)
})

test('http.obo: returns null when no token', async t => {
  process.env.USE_OBO = 'true'
  const req = { headers: {} }
  const result = http.obo(req)
  assert.equal(result, null)
})

// ============ selfOrigin function tests ============

test('http.selfOrigin: uses x-forwarded-host', async t => {
  const req = {
    headers: {
      'x-forwarded-host': 'app.databricksapps.com',
      'host': 'localhost'
    }
  }
  const result = http.selfOrigin(req)
  assert.equal(result, 'https://app.databricksapps.com')
})

test('http.selfOrigin: falls back to host header', async t => {
  const req = {
    headers: {
      'host': 'localhost:3000'
    }
  }
  const result = http.selfOrigin(req)
  assert.equal(result, 'https://localhost:3000')
})

// ============ consoleOnly middleware tests ============

test('http.consoleOnly: allows GET requests', async t => {
  const middleware = http.consoleOnly('test')
  const req = { method: 'GET', headers: {} }
  const res = {}
  let nextCalled = false
  const next = () => { nextCalled = true }
  middleware(req, res, next)
  assert.ok(nextCalled)
})

test('http.consoleOnly: allows HEAD requests', async t => {
  const middleware = http.consoleOnly('test')
  const req = { method: 'HEAD', headers: {} }
  const res = {}
  let nextCalled = false
  const next = () => { nextCalled = true }
  middleware(req, res, next)
  assert.ok(nextCalled)
})

test('http.consoleOnly: rejects OPTIONS', async t => {
  const middleware = http.consoleOnly('test')
  const req = { method: 'OPTIONS', headers: {} }
  const res = { status: (code) => ({ end: () => {} }) }
  let nextCalled = false
  const next = () => { nextCalled = true }
  middleware(req, res, next)
  assert.ok(!nextCalled)
})

test('http.consoleOnly: requires application/json', async t => {
  const middleware = http.consoleOnly('test')
  const req = {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
  }
  const res = {
    status: (code) => ({
      json: (obj) => { this.jsonCalled = true }
    })
  }
  let nextCalled = false
  const next = () => { nextCalled = true }
  middleware(req, res, next)
  assert.ok(!nextCalled)
})

test('http.consoleOnly: rejects cross-origin POST', async t => {
  const middleware = http.consoleOnly('test')
  const req = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': 'https://other-site.com',
      'host': 'localhost'
    }
  }
  const res = {
    status: (code) => ({
      json: (obj) => { this.jsonCalled = true }
    })
  }
  let nextCalled = false
  const next = () => { nextCalled = true }
  middleware(req, res, next)
  assert.ok(!nextCalled)
})

test('http.consoleOnly: allows same-origin POST', async t => {
  const middleware = http.consoleOnly('test')
  const req = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': 'https://localhost',
      'host': 'localhost'
    }
  }
  const res = { status: () => ({}) }
  let nextCalled = false
  const next = () => { nextCalled = true }
  middleware(req, res, next)
  assert.ok(nextCalled)
})


test('http.isTransientNetworkError: dropped downloads are transient, bugs are not', () => {
  assert.ok(http.isTransientNetworkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })))
  assert.ok(http.isTransientNetworkError(Object.assign(new Error('request to https://bucket/x failed, reason: socket hang up'), { name: 'FetchError' })))
  assert.ok(!http.isTransientNetworkError(new TypeError('Cannot read properties of undefined')))
  assert.ok(!http.isTransientNetworkError(null))
})
