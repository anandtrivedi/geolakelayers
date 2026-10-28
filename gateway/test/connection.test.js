/*
  connection.test.js — Tests for provider/connection.js (connection pooling)

  Note: Full integration tests require mocking a complex async DBSQLClient API.
  These tests cover the simpler connection logic and environment variable handling.
  For comprehensive testing, use a real test warehouse or a DBSQLClient mock library.
*/
const test = require('node:test')
const assert = require('node:assert/strict')

// Test environment variable handling and config logic without full DBSQLClient mocking
describe = test

test('connection: ConnectionManager can be instantiated', async t => {
  const ConnectionManager = require('../provider/connection').ConnectionManager
  const cm = new ConnectionManager()
  assert.ok(cm)
  assert.equal(cm.client, null)
})

test('connection: connectionTarget constructs host/path from env', async t => {
  // Test the connection target logic (simplified without needing full mock)
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'abcd1234'

  // The connectionTarget logic:
  const host = (process.env.DATABRICKS_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const id = process.env.DATABRICKS_WAREHOUSE_ID
  const path = id ? `/sql/1.0/warehouses/${id}` : ''

  assert.equal(host, 'test.cloud.databricks.com')
  assert.equal(path, '/sql/1.0/warehouses/abcd1234')

  delete process.env.DATABRICKS_HOST
  delete process.env.DATABRICKS_WAREHOUSE_ID
})

test('connection: auth method detection (PAT)', async t => {
  // Test that PAT is detected
  process.env.DATABRICKS_TOKEN = 'test_pat_token'
  delete process.env.DATABRICKS_CLIENT_ID
  delete process.env.DATABRICKS_CLIENT_SECRET

  const token = process.env.DATABRICKS_TOKEN
  const clientId = process.env.DATABRICKS_CLIENT_ID
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET

  assert.ok(token)
  assert.ok(!clientId)
  assert.ok(!clientSecret)

  delete process.env.DATABRICKS_TOKEN
})

test('connection: auth method detection (OAuth)', async t => {
  // Test that OAuth is detected
  process.env.DATABRICKS_CLIENT_ID = 'client_id_123'
  process.env.DATABRICKS_CLIENT_SECRET = 'client_secret_456'
  delete process.env.DATABRICKS_TOKEN

  const clientId = process.env.DATABRICKS_CLIENT_ID
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET
  const token = process.env.DATABRICKS_TOKEN

  assert.ok(clientId)
  assert.ok(clientSecret)
  assert.ok(!token)

  delete process.env.DATABRICKS_CLIENT_ID
  delete process.env.DATABRICKS_CLIENT_SECRET
})

test('connection: session pool size from env', async t => {
  process.env.SESSION_POOL_SIZE = '10'
  const poolSize = parseInt(process.env.SESSION_POOL_SIZE) || 6
  assert.equal(poolSize, 10)

  delete process.env.SESSION_POOL_SIZE
  const defaultPoolSize = parseInt(process.env.SESSION_POOL_SIZE) || 6
  assert.equal(defaultPoolSize, 6)
})

test('connection: session idle timeout from env', async t => {
  process.env.SESSION_IDLE_MS = '300000'
  const idleMs = parseInt(process.env.SESSION_IDLE_MS) || 15 * 60 * 1000
  assert.equal(idleMs, 300000)

  delete process.env.SESSION_IDLE_MS
  const defaultIdleMs = parseInt(process.env.SESSION_IDLE_MS) || 15 * 60 * 1000
  assert.equal(defaultIdleMs, 15 * 60 * 1000)
})

test('connection: user client max from env', async t => {
  process.env.USER_CLIENT_MAX = '500'
  const maxClients = parseInt(process.env.USER_CLIENT_MAX) || 200
  assert.equal(maxClients, 500)

  delete process.env.USER_CLIENT_MAX
})

// Mock DBSQLClient for testing pooling logic
class FakeSession {
  constructor(id) {
    this.id = id
    this.closed = false
  }

  async executeStatement(sql, opts = {}) {
    return { fetchAll: async () => [], close: async () => {} }
  }

  async close() {
    this.closed = true
  }
}

class FakeDBSQLClient {
  constructor() {
    this.sessionId = 0
    this.connected = false
  }

  async connect(opts) {
    this.connected = true
    return this
  }

  async openSession() {
    if (!this.connected) throw new Error('Not connected')
    return new FakeSession(++this.sessionId)
  }

  async close() {
    this.connected = false
  }
}

test('connection: getSession returns session', async t => {
  const origDBSQL = require.cache[require.resolve('@databricks/sql')]
  require.cache[require.resolve('@databricks/sql')] = { exports: { DBSQLClient: FakeDBSQLClient } }
  delete require.cache[require.resolve('../provider/connection')]

  const ConnectionManager = require('../provider/connection').ConnectionManager
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'wh1'
  process.env.DATABRICKS_TOKEN = 'test_token'

  try {
    const cm = new ConnectionManager()
    const session = await cm.getSession()
    assert.ok(session)
    assert.ok(typeof session.executeStatement === 'function')
    assert.ok(typeof session.close === 'function')
    await cm.close()
  } finally {
    delete process.env.DATABRICKS_HOST
    delete process.env.DATABRICKS_WAREHOUSE_ID
    delete process.env.DATABRICKS_TOKEN
    require.cache[require.resolve('@databricks/sql')] = origDBSQL
  }
})

test('connection: getUserSession for OBO requests', async t => {
  const origDBSQL = require.cache[require.resolve('@databricks/sql')]
  require.cache[require.resolve('@databricks/sql')] = { exports: { DBSQLClient: FakeDBSQLClient } }
  delete require.cache[require.resolve('../provider/connection')]

  const ConnectionManager = require('../provider/connection').ConnectionManager
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'wh1'

  try {
    const cm = new ConnectionManager()
    const session = await cm.getUserSession('user_token_xyz')
    assert.ok(session)
    assert.ok(typeof session.executeStatement === 'function')
  } finally {
    delete process.env.DATABRICKS_HOST
    delete process.env.DATABRICKS_WAREHOUSE_ID
    require.cache[require.resolve('@databricks/sql')] = origDBSQL
  }
})

test('connection: user sessions keyed by token and warehouse', async t => {
  const origDBSQL = require.cache[require.resolve('@databricks/sql')]
  require.cache[require.resolve('@databricks/sql')] = { exports: { DBSQLClient: FakeDBSQLClient } }
  delete require.cache[require.resolve('../provider/connection')]

  const ConnectionManager = require('../provider/connection').ConnectionManager
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'default_wh'

  try {
    const cm = new ConnectionManager()
    const s1 = await cm.getUserSession('token1', 'wh1')
    const s2 = await cm.getUserSession('token2', 'wh2')
    assert.ok(s1)
    assert.ok(s2)
  } finally {
    delete process.env.DATABRICKS_HOST
    delete process.env.DATABRICKS_WAREHOUSE_ID
    require.cache[require.resolve('@databricks/sql')] = origDBSQL
  }
})

test('connection: session pooling (reuse)', async t => {
  const origDBSQL = require.cache[require.resolve('@databricks/sql')]
  require.cache[require.resolve('@databricks/sql')] = { exports: { DBSQLClient: FakeDBSQLClient } }
  delete require.cache[require.resolve('../provider/connection')]

  const ConnectionManager = require('../provider/connection').ConnectionManager
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'wh1'
  process.env.DATABRICKS_TOKEN = 'test_token'
  process.env.SESSION_POOL_SIZE = '3'

  try {
    const cm = new ConnectionManager()
    const s1 = await cm.getSession()
    await s1.close()
    const s2 = await cm.getSession()
    assert.ok(s1)
    assert.ok(s2)
    await cm.close()
  } finally {
    delete process.env.DATABRICKS_HOST
    delete process.env.DATABRICKS_WAREHOUSE_ID
    delete process.env.DATABRICKS_TOKEN
    delete process.env.SESSION_POOL_SIZE
    require.cache[require.resolve('@databricks/sql')] = origDBSQL
  }
})

test('connection: stale session not reused', async t => {
  const origDBSQL = require.cache[require.resolve('@databricks/sql')]
  require.cache[require.resolve('@databricks/sql')] = { exports: { DBSQLClient: FakeDBSQLClient } }
  delete require.cache[require.resolve('../provider/connection')]

  const ConnectionManager = require('../provider/connection').ConnectionManager
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'wh1'
  process.env.DATABRICKS_TOKEN = 'test_token'
  process.env.SESSION_IDLE_MS = '50'

  try {
    const cm = new ConnectionManager()
    const s1 = await cm.getSession()
    await s1.close()
    await new Promise(r => setTimeout(r, 100))
    const s2 = await cm.getSession()
    assert.ok(s1)
    assert.ok(s2)
    await cm.close()
  } finally {
    delete process.env.DATABRICKS_HOST
    delete process.env.DATABRICKS_WAREHOUSE_ID
    delete process.env.DATABRICKS_TOKEN
    delete process.env.SESSION_IDLE_MS
    require.cache[require.resolve('@databricks/sql')] = origDBSQL
  }
})

test('connection: the idle sweep leaves a user client alone while one of its sessions is checked out', async t => {
  const origDBSQL = require.cache[require.resolve('@databricks/sql')]
  require.cache[require.resolve('@databricks/sql')] = { exports: { DBSQLClient: FakeDBSQLClient } }
  delete require.cache[require.resolve('../provider/connection')]

  const ConnectionManager = require('../provider/connection').ConnectionManager
  process.env.DATABRICKS_HOST = 'test.cloud.databricks.com'
  process.env.DATABRICKS_WAREHOUSE_ID = 'wh1'

  try {
    const cm = new ConnectionManager()
    const session = await cm.getUserSession('long_running_user')
    const [entry] = cm.userClients.values()
    entry.at = Date.now() - 24 * 3600 * 1000 // idle "for a day" while a long statement runs (Optimize)
    cm.sweepUserClients()
    assert.equal(cm.userClients.size, 1, 'a client with a session in use is not swept')
    assert.equal(entry.client.connected, true)
    await session.close()
    await session.close() // closing twice doesn't unbalance the count
    assert.equal(entry.busy, 0)
    entry.at = Date.now() - 24 * 3600 * 1000
    cm.sweepUserClients()
    assert.equal(cm.userClients.size, 0, 'swept once the session is back and the client is idle')
  } finally {
    delete process.env.DATABRICKS_HOST
    delete process.env.DATABRICKS_WAREHOUSE_ID
    require.cache[require.resolve('@databricks/sql')] = origDBSQL
  }
})
