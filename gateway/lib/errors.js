/*
  errors.js — Databricks errors in words a map author can act on

  Every query runs as the signed-in user, so a missing grant shows up as a SQL error. explain() turns the
  common ones into an HTTP status and a sentence that names what is missing and who can fix it; anything
  else keeps its first line. Used by the console API, the OGC routes and edits.
*/

const PERMISSION = /PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have .* (privilege|on )|not authorized|Forbidden/i
const WAREHOUSE = /warehouse|endpoint/i
const NOT_FOUND = /TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|NO_SUCH_CATALOG|CATALOG_NOT_FOUND|(Table|Schema|Catalog) '?[\w.`-]+'? does not exist/i
const SIGNED_OUT = /\b401\b|invalid access token|token (is )?expired|Unauthorized|UNAUTHENTICATED/i

class ExplainedError extends Error {
  constructor (status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const firstLine = err => (err?.message || String(err || '')).split('\n')[0].replace(/\s*SQLSTATE: \w+\s*$/, '').slice(0, 300)
// The rest of a Databricks message often names the object: "User does not have MODIFY on Table 'a.b.c'."
const whole = err => String(err?.message || err || '').replace(/\s+/g, ' ')

function explain (err) {
  if (err instanceof ExplainedError) return err
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) return new ExplainedError(err.status, firstLine(err), err.code)
  const text = whole(err)
  if (PERMISSION.test(text)) {
    const what = text.match(/does not have ([A-Z_ ,]+?(?: and [A-Z_ ]+?)*) (?:privileges? )?on ([A-Za-z ]+?) '?`?([\w.`-]+)`?'?(?:[.\s]|$)/)
    if (what) {
      const privileges = what[1].trim().replace(/_/g, ' ')
      return new ExplainedError(403, `You don't have ${privileges} on ${what[2].trim().toLowerCase()} ${what[3].replace(/`/g, '')}. Ask its owner or a Databricks admin to grant it.`, 'permission')
    }
    if (WAREHOUSE.test(text)) return new ExplainedError(403, 'You can\'t use this SQL warehouse. Ask a workspace admin for CAN USE on it, or pick another warehouse.', 'permission')
    return new ExplainedError(403, `Unity Catalog refused this for your account: ${firstLine(err)}`, 'permission')
  }
  if (NOT_FOUND.test(text)) {
    const name = (text.match(/`?([\w-]+`?\.`?[\w-]+(?:`?\.`?[\w-]+)?)`?/) || [])[1]
    return new ExplainedError(404, `${name ? `${name.replace(/`/g, '')} wasn't found` : 'Not found'}, or you can't see it. Reading a table needs USE CATALOG, USE SCHEMA and SELECT.`, 'not_found')
  }
  if (SIGNED_OUT.test(text)) return new ExplainedError(401, 'Your Databricks sign-in has expired. Sign in again.', 'signed_out')
  return new ExplainedError(500, firstLine(err) || 'Something went wrong', 'error')
}

// Express helper for JSON API routes: { error, code } with the explained status
function sendExplained (res, err) {
  const e = explain(err)
  res.status(e.status).json({ error: e.message, code: e.code })
}

module.exports = { explain, sendExplained, ExplainedError, PERMISSION }
