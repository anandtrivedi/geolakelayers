/*
  Databricks sign-in and catalog, shared by the runtime and the settings panel.

  Sign-in opens <gateway>/auth/handoff in a popup. The Databricks login happens there
  (first-party), and the page posts the user's token back to this window's origin.
  Tokens are kept in memory only. Same-origin windows (the builder's settings panel and its
  live-view canvas, or several app tabs) share them over a BroadcastChannel, so one sign-in covers all.
*/
import type { CatalogTable } from './config'

export interface GatewayToken { token: string, user: string }

const tokens: { [gateway: string]: GatewayToken } = {}
const listeners: { [gateway: string]: Set<(t: GatewayToken) => void> } = {}
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('databricks-gateway-token') : null

function setToken (gateway: string, t: GatewayToken, share: boolean): void {
  tokens[gateway] = t
  if (share) channel?.postMessage({ type: 'token', gateway, token: t })
  listeners[gateway]?.forEach(fn => fn(t))
}

channel?.addEventListener('message', (e: MessageEvent) => {
  const d = e.data || {}
  if (d.type === 'token' && d.gateway && d.token && !tokens[d.gateway]) setToken(d.gateway, d.token, false)
  if (d.type === 'ask' && d.gateway && tokens[d.gateway]) channel.postMessage({ type: 'token', gateway: d.gateway, token: tokens[d.gateway] })
})

export function getToken (gateway: string): GatewayToken | undefined {
  return tokens[gateway]
}

export function signIn (gateway: string): void {
  window.open(`${gateway}/auth/handoff?origin=${encodeURIComponent(window.location.origin)}`, 'dbx-signin', 'width=520,height=640')
}

/**
 * Calls onToken when a token for this gateway arrives, from the handoff popup or from another
 * same-origin window that already signed in. Returns an unsubscribe function.
 */
export function listenForToken (gateway: string, onToken: (t: GatewayToken) => void): () => void {
  if (!gateway) return () => {}
  ;(listeners[gateway] = listeners[gateway] || new Set()).add(onToken)
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== new URL(gateway).origin) return
    if (!e.data || e.data.type !== 'databricks-gateway-token') return
    if (tokens[gateway]?.token === e.data.token) return
    setToken(gateway, { token: e.data.token, user: e.data.user }, true)
  }
  window.addEventListener('message', onMessage)
  if (!tokens[gateway]) channel?.postMessage({ type: 'ask', gateway })
  return () => {
    listeners[gateway]?.delete(onToken)
    window.removeEventListener('message', onMessage)
  }
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
