/*
  sea.js — sessions over the SQL Statement Execution API (REST), for Lakehouse//RT warehouses

  Lakehouse//RT accepts only the Statement Execution API, not the Thrift protocol the
  Node SQL driver uses by default. This gives model.js and server.js the same small session interface
  they already use (executeStatement -> { fetchAll, close }, close), running as the caller's token.
  Values come back as JSON text and are converted by column type, the way the driver returns them.
*/

/* global fetch */

const POLL_START_MS = 100
const POLL_MAX_MS = 1000

function toValue (v, type) {
  if (v === null || v === undefined) return null
  switch (String(type || '').toUpperCase()) {
    case 'BYTE': case 'SHORT': case 'INT': case 'LONG': case 'FLOAT': case 'DOUBLE': case 'DECIMAL':
      return Number(v)
    case 'BOOLEAN':
      return v === true || v === 'true'
    case 'TIMESTAMP': case 'TIMESTAMP_NTZ': case 'DATE': {
      const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`)
      return Number.isNaN(t) ? v : new Date(t)
    }
    case 'ARRAY': case 'STRUCT': case 'MAP':
      try { return JSON.parse(v) } catch { return v }
    case 'BINARY':
      return Buffer.from(String(v), 'base64')
    default:
      return v
  }
}

function rowsOf (columns, dataArray) {
  return (dataArray || []).map(r => {
    const o = {}
    columns.forEach((c, i) => { o[c.name] = toValue(r[i], c.type_name) })
    return o
  })
}

/** Named parameters as the API expects them; null/undefined become SQL NULL (no value). */
function parametersOf (named) {
  return Object.entries(named || {}).map(([name, value]) =>
    value === null || value === undefined ? { name } : { name, value: String(value) })
}

/**
 * A session on one warehouse for one caller. fetchImpl is injectable for tests.
 * host: workspace host without scheme; token: the caller's OAuth token.
 */
function seaSession ({ host, token, warehouseId, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const base = `https://${host}`
  const call = async (method, path, body) => {
    const r = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    const text = await r.text()
    let d = {}
    try { d = text ? JSON.parse(text) : {} } catch { d = { message: text.slice(0, 300) } }
    if (!r.ok) throw Object.assign(new Error(d.message || `Statement Execution API: HTTP ${r.status}`), { status: r.status, errorCode: d.error_code })
    return d
  }

  return {
    async executeStatement (statement, { queryTimeout = 60, namedParameters } = {}) {
      const deadline = Date.now() + queryTimeout * 1000
      let d = await call('POST', '/api/2.0/sql/statements', {
        warehouse_id: warehouseId,
        statement,
        parameters: parametersOf(namedParameters),
        disposition: 'INLINE',
        format: 'JSON_ARRAY',
        wait_timeout: '10s',
        on_wait_timeout: 'CONTINUE'
      })
      // Still running after the server-side wait: poll, then cancel if it outlives the query timeout
      let wait = POLL_START_MS
      while (['PENDING', 'RUNNING'].includes(d.status?.state)) {
        if (Date.now() > deadline) {
          await call('POST', `/api/2.0/sql/statements/${d.statement_id}/cancel`).catch(() => {})
          throw new Error(`Query timed out after ${queryTimeout} s`)
        }
        await sleep(wait)
        wait = Math.min(wait * 2, POLL_MAX_MS)
        d = await call('GET', `/api/2.0/sql/statements/${d.statement_id}`)
      }
      if (d.status?.state !== 'SUCCEEDED') {
        const e = d.status?.error || {}
        throw Object.assign(new Error(e.message || `Statement ${d.status?.state || 'failed'}`), { errorCode: e.error_code })
      }
      const columns = d.manifest?.schema?.columns || []
      return {
        async fetchAll () {
          let rows = rowsOf(columns, d.result?.data_array)
          let next = d.result?.next_chunk_internal_link
          while (next) {
            const chunk = await call('GET', next)
            rows = rows.concat(rowsOf(columns, chunk.data_array))
            next = chunk.next_chunk_internal_link
          }
          return rows
        },
        async close () {}
      }
    },
    async close () {}
  }
}

module.exports = { seaSession, toValue, rowsOf, parametersOf }
