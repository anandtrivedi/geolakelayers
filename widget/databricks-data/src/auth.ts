/*
  Databricks sign-in and catalog, shared by the runtime and the settings panel.

  Sign-in opens <gateway>/auth/handoff in a popup. The Databricks login happens there
  (first-party), and the page posts the user's token back to this window's origin.
  Tokens are kept in memory only. In the builder, its settings panel and live-view canvas are separate
  windows; they share the token over a BroadcastChannel so one sign-in covers both. Published apps don't
  use the channel: every app on a Portal shares one origin, and any of them could listen to it.
*/
import type { CatalogTable } from './config'

export interface GatewayToken { token: string, user: string }

const tokens: { [gateway: string]: GatewayToken } = {}
const listeners: { [gateway: string]: Set<(t: GatewayToken) => void> } = {}
const jimuConfig = (window as any).jimuConfig || {}
const inBuilder = !!(jimuConfig.isBuilder || jimuConfig.isInBuilder)
const channel: BroadcastChannel | null = inBuilder && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('databricks-gateway-token') : null

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

// Warehouse the app author picked for each gateway (the gateway accepts only its allow-listed ones)
const warehouses: { [gateway: string]: string } = {}

export function setWarehouse (gateway: string, warehouseId: string): void {
  if (warehouseId) warehouses[gateway] = warehouseId
  else delete warehouses[gateway]
}

/** Headers for a gateway request: the user's token and, if one is picked, the warehouse. */
export function gatewayHeaders (gateway: string): { [k: string]: string } {
  const h: { [k: string]: string } = {}
  const t = tokens[gateway]
  if (t) h.Authorization = `Bearer ${t.token}`
  if (warehouses[gateway]) h['X-Databricks-Warehouse'] = warehouses[gateway]
  return h
}

async function getJson (gateway: string, path: string): Promise<any> {
  if (!tokens[gateway]) throw new Error('Not signed in')
  const r = await fetch(`${gateway}${path}`, { headers: gatewayHeaders(gateway) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error?.message || d.error || `HTTP ${r.status}`)
  return d
}

export interface WarehouseInfo { id: string, name: string, state: string, size: string, serverless: boolean }

/** Allow-listed warehouses the signed-in user can use, and the gateway's default. */
export async function fetchWarehouses (gateway: string): Promise<{ default: string | null, warehouses: WarehouseInfo[] }> {
  return getJson(gateway, '/api/warehouses')
}

/** Catalogs the signed-in user can see. */
export async function fetchCatalogNames (gateway: string): Promise<string[]> {
  return (await getJson(gateway, '/api/catalogs')).catalogs
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

/** Map-ready tables in the given catalogs (empty = the gateway's default scope). */
export async function fetchCatalog (gateway: string, catalogs: string[]): Promise<CatalogTable[]> {
  const q = catalogs.length ? `?catalogs=${encodeURIComponent(catalogs.join(','))}` : ''
  return (await getJson(gateway, `/api/catalog${q}`)).tables
}

/** catalog.schema.table -> a minimal CatalogTable for layers saved in config */
export function tableRef (table: string): CatalogTable {
  const [catalog, schema, name] = table.split('.')
  return { table, catalog, schema, name, idField: '', geometry: '' }
}
