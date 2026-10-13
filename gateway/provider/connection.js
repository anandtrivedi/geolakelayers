/*
  connection.js

  Singleton connection manager for Databricks SQL.
  Supports PAT (personal access token) and Service Principal (OAuth) authentication.
  Reuses a single client connection to enable connection pooling across requests.
*/

const { DBSQLClient } = require('@databricks/sql')
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

    this.client = new DBSQLClient()
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
      const client = new DBSQLClient()
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
    return {
      executeStatement: async (...args) => {
        try {
          return await session.executeStatement(...args)
        } catch (err) {
          broken = true
          throw err
        }
      },
      close: async () => {
        if (!broken && entry.idle.length < SESSION_POOL_SIZE && this.userClients && [...this.userClients.values()].includes(entry)) {
          entry.idle.push({ session, at: Date.now() })
        } else {
          await session.close().catch(() => {})
        }
      }
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
