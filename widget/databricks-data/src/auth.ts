/*
  Databricks sign-in and catalog, shared by the runtime and the settings panel.

  Sign-in opens <gateway>/auth/handoff in a popup. The Databricks login happens there
  (first-party), and the page posts the user's token back to this window's origin.
  Tokens are kept in memory only, per window.
*/
import type { CatalogTable } from './config'

export interface GatewayToken { token: string, user: string }

const tokens: { [gateway: string]: GatewayToken } = {}

export function getToken (gateway: string): GatewayToken | undefined {
  return tokens[gateway]
}

export function signIn (gateway: string): void {
  window.open(`${gateway}/auth/handoff?origin=${encodeURIComponent(window.location.origin)}`, 'dbx-signin', 'width=520,height=640')
}

/** Calls onToken when the handoff popup posts a token for this gateway. Returns an unsubscribe function. */
export function listenForToken (gateway: string, onToken: (t: GatewayToken) => void): () => void {
  const onMessage = (e: MessageEvent) => {
    if (!gateway || e.origin !== new URL(gateway).origin) return
    if (!e.data || e.data.type !== 'databricks-gateway-token') return
    tokens[gateway] = { token: e.data.token, user: e.data.user }
    onToken(tokens[gateway])
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/** Tables the signed-in user can see that the gateway can serve, optionally limited to a catalog/schema prefix. */
export async function fetchCatalog (gateway: string, prefix: string): Promise<CatalogTable[]> {
  const t = tokens[gateway]
  if (!t) throw new Error('Not signed in')
  const r = await fetch(`${gateway}/api/catalog`, { headers: { Authorization: `Bearer ${t.token}` } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || String(r.status))
  const p = (prefix || '').toLowerCase()
  return d.tables.filter((x: CatalogTable) => !p || x.table.startsWith(p))
}

/** catalog.schema.table -> a minimal CatalogTable for layers saved in config */
export function tableRef (table: string): CatalogTable {
  const [catalog, schema, name] = table.split('.')
  return { table, catalog, schema, name, idField: '', geometry: '' }
}
