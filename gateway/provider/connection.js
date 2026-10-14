/*
  connection.js

  Singleton connection manager for Databricks SQL.
  Supports PAT (personal access token) and Service Principal (OAuth) authentication.
  Reuses a single client connection to enable connection pooling across requests.
*/

// Looked up on each connect (not destructured) so tests can swap in a fake client
const dbsql = require('@databricks/sql')
const logger = require('./logger')
const crypto = require('crypto')
const { version } = require('../package.json')

// On-behalf-of-user clients, keyed by a hash of the forwarded user token. Tokens from
// the Apps front door last about an hour; idle clients are closed after USER_CLIENT_TTL_MS.
const USER_CLIENT_TTL_MS = parseInt(process.env.USER_CLIENT_TTL_MS) || 15 * 60 * 1000
const USER_CLIENT_MAX = 200
// Idle sessions kept per user + warehouse, and how long one may sit idle before it's retired
const SESSION_POOL_SIZE = parseInt(process.env.SESSION_POOL_SIZE) || 6
const SESSION_IDLE_MS = parseInt(process.env.SESSION_IDLE_MS) || 10 * 60 * 1000

// Lakehouse//RT warehouses, reached over the Statement Execution API. '-' = none.
const realtimeWarehouses = () => (process.env.REALTIME_WAREHOUSES || '').split(',').map(s => s.trim()).filter(s => s && s !== '-')
// After Lakehouse//RT refuses a table's query (an unsupported function or type), that table is read on the
// regular warehouse for this long
const REALTIME_FALLBACK_MS = parseInt(process.env.REALTIME_FALLBACK_MS) || 10 * 60 * 1000
// Statements Lakehouse//RT can't run: anything but a read, and metadata (DESCRIBE, SHOW, system tables)
const READ = /^\s*(\(\s*)*(SELECT|WITH)\b/i
const METADATA = /^\s*(DESCRIBE|SHOW)\b|information_schema|\bsystem\./i
// Errors that are the caller's (permissions, missing table): retrying elsewhere wouldn't help
const CALLER_ERROR = /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|TABLE_OR_VIEW_NOT_FOUND|UNRESOLVED_COLUMN|PARSE_SYNTAX_ERROR|does not have .* privilege/i
const tableOf = sql => (/\bFROM\s+(?:\(\s*SELECT\b[\s\S]*?\bFROM\s+)?([A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+)/i.exec(sql) || [])[1] || null

// Workspace host and warehouse: explicit settings win; inside Databricks Apps the runtime injects
// DATABRICKS_HOST (no scheme) and the bundle maps the sql-warehouse resource to DATABRICKS_WAREHOUSE_ID.
// A specific warehouse id (already checked against the gateway's allow-list) overrides the default.
function connectionTarget (warehouseId) {
  const host = process.env.DATABRICKS_SERVER_HOSTNAME ||
    (process.env.DATABRICKS_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const id = warehouseId || process.env.DATABRICKS_WAREHOUSE_ID
  const path = warehouseId ? `/sql/1.0/warehouses/${warehouseId}`
    : process.env.DATABRICKS_HTTP_PATH || (id ? `/sql/1.0/warehouses/${id}` : '')
  return { host, path }
}

class ConnectionManager {
  constructor () {
    this.client = null
    this.connectPromise = null
    this.cleanupRegistered = false
  }

  /**
   * Lazily connect to Databricks. Reuses the same connection across calls.
   * Detects auth method from environment variables.
   * @returns {Promise<DBSQLClient>}
   */
  async connect () {
    // Return existing connection promise to prevent race conditions
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = this._doConnect()

    try {
      return await this.connectPromise
    } catch (err) {
      // Reset on failure so next call retries
      this.connectPromise = null
      throw err
    }
  }

  async _doConnect () {
    const { host: serverHostname, path: httpPath } = connectionTarget()

    if (!serverHostname || !httpPath) {
      throw new Error(
        'Missing required connection settings. ' +
        'Set DATABRICKS_HOST (or DATABRICKS_SERVER_HOSTNAME) and DATABRICKS_WAREHOUSE_ID (or DATABRICKS_HTTP_PATH).'
      )
    }

    const connectOptions = {
      host: serverHostname,
      path: httpPath,
      userAgentEntry: `esri_databricks-koop-provider/${version}`
    }

    // Detect auth method
    const clientId = process.env.DATABRICKS_CLIENT_ID
    const clientSecret = process.env.DATABRICKS_CLIENT_SECRET
    const token = process.env.DATABRICKS_TOKEN

    if (clientId && clientSecret) {
      // Service Principal OAuth
      logger.info('Connecting with Service Principal (OAuth) authentication')
      connectOptions.authType = 'databricks-oauth'
      connectOptions.oauthClientId = clientId
      connectOptions.oauthClientSecret = clientSecret
    } else if (token) {
      // Personal Access Token
      logger.info('Connecting with Personal Access Token authentication')
      connectOptions.token = token
    } else {
      throw new Error(
        'No authentication credentials found. ' +
        'Set DATABRICKS_TOKEN for PAT auth, or ' +
        'DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET for Service Principal auth.'
      )
    }

    this.client = new dbsql.DBSQLClient()
    await this.client.connect(connectOptions)

    // Register cleanup handlers once
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true
      const cleanup = () => this.close()
      process.once('SIGTERM', cleanup)
      process.once('SIGINT', cleanup)
    }

    logger.info('Successfully connected to Databricks SQL')
    return this.client
  }

  /**
   * Get a new session from the shared client connection.
   * If the cached connection has gone stale (warehouse restart, network drop),
   * reset it and retry once with a fresh connection.
   * @returns {Promise<IDBSQLSession>}
   */
  async getSession (userToken, warehouseId) {
    if (warehouseId && realtimeWarehouses().includes(warehouseId)) return this.realtimeSession(userToken, warehouseId)
    if (userToken) return this.getUserSession(userToken, warehouseId)
    const client = await this.connect()
    try {
      return await client.openSession()
    } catch (err) {
      logger.warn(`openSession failed (${err.message}); reconnecting and retrying once`)
      await this.close()
      const freshClient = await this.connect()
      return freshClient.openSession()
    }
  }

  /**
   * Session that runs as the calling user (their Unity Catalog permissions apply).
   * @param {string} userToken - x-forwarded-access-token from the Databricks Apps front door
   * @param {string} [warehouseId] - allow-listed warehouse for this request (default: the bound one)
   */
  async getUserSession (userToken, warehouseId) {
    if (!this.userClients) {
      this.userClients = new Map()
      setInterval(() => this.sweepUserClients(), 60000).unref()
    }
    const key = crypto.createHash('sha256').update(userToken).digest('hex') + '|' + (warehouseId || '')
    let entry = this.userClients.get(key)
    if (!entry) {
      if (this.userClients.size >= USER_CLIENT_MAX) this.sweepUserClients(true)
      const client = new dbsql.DBSQLClient()
      const connected = client.connect({
        ...connectionTarget(warehouseId),
        token: userToken,
        userAgentEntry: `esri_databricks-koop-provider/${version}`
      })
      entry = { client, connected, at: Date.now(), idle: [] }
      this.userClients.set(key, entry)
    }
    entry.at = Date.now()
    try {
      await entry.connected
      // Reuse an idle session: opening one costs a round trip to the warehouse on every request
      while (entry.idle.length) {
        const pooled = entry.idle.pop()
        if (Date.now() - pooled.at < SESSION_IDLE_MS) return this.pooledSession(entry, pooled.session)
        pooled.session.close().catch(() => {})
      }
      return this.pooledSession(entry, await entry.client.openSession())
    } catch (err) {
      this.userClients.delete(key)
      entry.client.close().catch(() => {})
      throw err
    }
  }

  /** A session whose close() hands it back to the pool; one that failed a statement is discarded. */
  pooledSession (entry, session) {
    let broken = false
    let open = 0 // operations not yet closed; a session with one still open is never reused
    return {
      executeStatement: async (...args) => {
        let op
        try {
          op = await session.executeStatement(...args)
        } catch (err) {
          broken = true
          throw err
        }
        open++
        const close = op.close.bind(op)
        const fetchAll = op.fetchAll.bind(op)
        op.fetchAll = async (...a) => { try { return await fetchAll(...a) } catch (err) { broken = true; throw err } }
        op.close = async (...a) => { try { return await close(...a) } finally { open-- } }
        return op
      },
      close: async () => {
        if (!broken && open === 0 && entry.idle.length < SESSION_POOL_SIZE && this.userClients && [...this.userClients.values()].includes(entry)) {
          entry.idle.push({ session, at: Date.now() })
        } else {
          await session.close().catch(() => {})
        }
      }
    }
  }

  /**
   * A session on a Lakehouse//RT warehouse: reads go there over the Statement Execution API; metadata and
   * writes go to the regular (bound) warehouse, and so does any read Lakehouse//RT refuses, for that table,
   * for REALTIME_FALLBACK_MS. Counters are kept for the console (realtimeStatus).
   */
  async realtimeSession (userToken, warehouseId) {
    if (!userToken) throw new Error('Lakehouse//RT warehouses need the caller\'s token (USE_OBO)')
    const { host } = connectionTarget()
    const rt = require('./sea').seaSession({ host, token: userToken, warehouseId })
    const stats = this.rt || (this.rt = { queries: 0, fallbacks: 0, routed: 0, errors: [], skip: new Map() })
    let regular = null
    const onRegular = async (...args) => {
      if (!regular) regular = await this.getSession(userToken, undefined)
      return regular.executeStatement(...args)
    }
    return {
      executeStatement: async (sql, opts) => {
        const table = tableOf(sql)
        const skipUntil = table && stats.skip.get(table)
        if (!READ.test(sql) || METADATA.test(sql) || (skipUntil && skipUntil > Date.now())) {
          stats.routed++
          return onRegular(sql, opts)
        }
        try {
          const op = await rt.executeStatement(sql, opts)
          stats.queries++
          return op
        } catch (err) {
          if (CALLER_ERROR.test(err.message)) throw err
          stats.fallbacks++
          stats.errors.unshift({ at: new Date().toISOString(), table, error: err.message.split('\n')[0].slice(0, 300) })
          stats.errors.length = Math.min(stats.errors.length, 20)
          if (table) stats.skip.set(table, Date.now() + REALTIME_FALLBACK_MS)
          logger.warn(`Lakehouse//RT refused a query${table ? ` on ${table}` : ''}; using the regular warehouse: ${err.message.split('\n')[0]}`)
          return onRegular(sql, opts)
        }
      },
      close: async () => { if (regular) await regular.close() }
    }
  }

  /** What Lakehouse//RT has done since the gateway started (console diagnostics). */
  realtimeStatus () {
    const s = this.rt || { queries: 0, fallbacks: 0, routed: 0, errors: [], skip: new Map() }
    const now = Date.now()
    return {
      warehouses: realtimeWarehouses(),
      queries: s.queries,
      fallbacks: s.fallbacks,
      routedToRegular: s.routed,
      tablesOnRegular: [...s.skip].filter(([, until]) => until > now).map(([table, until]) => ({ table, until: new Date(until).toISOString() })),
      recentErrors: s.errors
    }
  }

  sweepUserClients (evictOldest = false) {
    const now = Date.now()
    let oldest = null
    for (const [key, entry] of this.userClients) {
      if (now - entry.at > USER_CLIENT_TTL_MS) {
        this.userClients.delete(key)
        for (const p of entry.idle || []) p.session.close().catch(() => {})
        entry.client.close().catch(() => {})
      } else if (!oldest || entry.at < oldest[1].at) {
        oldest = [key, entry]
      }
    }
    if (evictOldest && oldest && this.userClients.size >= USER_CLIENT_MAX) {
      this.userClients.delete(oldest[0])
      oldest[1].client.close().catch(() => {})
    }
  }

  /**
   * Close the client connection and reset state.
   */
  async close () {
    if (this.client) {
      try {
        await this.client.close()
        logger.info('Databricks connection closed')
      } catch (err) {
        logger.error('Error closing Databricks connection:', err)
      }
      this.client = null
      this.connectPromise = null
    }
  }
}

module.exports = new ConnectionManager()
module.exports.ConnectionManager = ConnectionManager
module.exports.realtimeWarehouses = realtimeWarehouses
module.exports._routing = { READ, METADATA, CALLER_ERROR, tableOf }
