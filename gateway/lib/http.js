/*
  http.js — small request helpers shared by server.js and the OGC routes (kept here so they can be tested)
*/

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/
const THREE_PART = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/

// Comma-separated setting; '-' means none (Databricks Apps refuses empty env values)
const list = v => (v || '').split(',').map(s => s.trim()).filter(s => s && s !== '-')

// An origin as browsers send it: scheme://host[:port], lower case, no path or trailing slash; '' if invalid
function normalizeOrigin (value) {
  try {
    const u = new URL(String(value || '').trim())
    return /^https?:$/.test(u.protocol) ? u.origin : ''
  } catch (_) { return '' }
}

// Other LakeGate gateways (one per workspace): "name=url;name=url", https only
function parseDirectory (value) {
  return (value || '').split(';').map(s => s.trim()).filter(s => s && s !== '-')
    .map(entry => { const i = entry.indexOf('='); return i > 0 ? { name: entry.slice(0, i).trim(), url: entry.slice(i + 1).trim().replace(/\/$/, '') } : null })
    .filter(e => e && /^https:\/\//.test(e.url))
}

// Catalog scope for one request: the widget's choice (?catalogs=a,b), limited to the gateway's own
// CATALOGS cap when one is set. Names must be plain identifiers.
function requestedCatalogs (req, cap) {
  const asked = list(req.query.catalogs).filter(c => PLAIN.test(c))
  if (!cap.length) return asked
  return asked.length ? asked.filter(c => cap.includes(c)) : cap
}

// Forwarded user token, so queries run with the caller's Unity Catalog permissions
const obo = req => (process.env.USE_OBO !== 'false' && req.headers['x-forwarded-access-token']) || null

// This gateway's own origin, as the browser sees it
const selfOrigin = req => `https://${req.headers['x-forwarded-host'] || req.headers.host}`

// Console-only writes: same-origin JSON. A cross-site form post can't send application/json without a CORS
// preflight, and these routes never approve one.
function consoleOnly (message) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return res.status(403).end()
    if (req.method === 'GET' || req.method === 'HEAD') return next()
    if (!String(req.headers['content-type'] || '').startsWith('application/json') || (req.headers.origin && req.headers.origin !== selfOrigin(req))) {
      return res.status(403).json({ error: message })
    }
    next()
  }
}

// Network failures the SQL driver can leak as uncaught exceptions (a results download from cloud storage
// dropping mid-transfer). The query that owned it has already failed; the process is fine.
function isTransientNetworkError (err) {
  const code = err && (err.code || err.errno)
  return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code) ||
    (err && err.name === 'FetchError' && /socket hang up|network timeout|ECONNRESET/i.test(err.message || ''))
}

// The popup page that hands the signed-in user's token to the window that opened it. The browser delivers
// each message only when the opener is at that origin, so the token never reaches anyone else.
function handoffPage (message, origins) {
  // Escaped for an inline <script>: no '</script>' or line-separator breakouts from any field
  const safe = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<p style="font:14px system-ui">Signed in to Databricks. You can close this window.</p>
<script>
  if (window.opener) { for (const o of ${safe(origins)}) window.opener.postMessage(${safe(message)}, o); window.close() }
</script>`
}

module.exports = { normalizeOrigin, handoffPage, isTransientNetworkError, PLAIN, THREE_PART, list, parseDirectory, requestedCatalogs, obo, selfOrigin, consoleOnly }
