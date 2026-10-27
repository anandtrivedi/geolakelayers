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
const listeners: { [gateway: string]: Set<(t: GatewayToken | null) => void> } = {}
const jimuConfig = (window as any).jimuConfig || {}
const inBuilder = !!(jimuConfig.isBuilder || jimuConfig.isInBuilder)
const channel: BroadcastChannel | null = inBuilder && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('databricks-gateway-token') : null

// Why the last sign-in for a gateway ended, so the UI can say "expired" rather than just "not signed in"
const ended: { [gateway: string]: 'expired' } = {}

/** 'expired' when the sign-in lapsed or the gateway rejected the token; null otherwise. */
export function signInNotice (gateway: string): 'expired' | null {
  return tokens[gateway] ? null : ended[gateway] || null
}

function setToken (gateway: string, t: GatewayToken, share: boolean): void {
  delete ended[gateway]
  tokens[gateway] = t
  if (share) channel?.postMessage({ type: 'token', gateway, token: t })
  listeners[gateway]?.forEach(fn => fn(t))
}

// Databricks OAuth tokens are JWTs; their exp claim says when the sign-in lapses (about an hour)
function expiresAt (token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : Infinity
  } catch {
    return Infinity
  }
}

/** Forget a gateway's token; listeners get null. expired: it lapsed or the gateway rejected it. */
export function signOut (gateway: string, expired = false): void {
  if (!tokens[gateway]) return
  delete tokens[gateway]
  if (expired) ended[gateway] = 'expired'
  for (const k of Array.from(lookups.keys())) if (k.startsWith(`${gateway}|`)) lookups.delete(k)
  listeners[gateway]?.forEach(fn => fn(null))
}

// Expired tokens are dropped a minute early, so requests don't start with a token about to lapse
setInterval(() => {
  for (const g of Object.keys(tokens)) if (expiresAt(tokens[g].token) - 60000 < Date.now()) signOut(g, true)
}, 30000)

channel?.addEventListener('message', (e: MessageEvent) => {
  const d = e.data || {}
  if (d.type === 'token' && d.gateway && d.token && !tokens[d.gateway]) setToken(d.gateway, d.token, false)
  if (d.type === 'ask' && d.gateway && tokens[d.gateway]) channel.postMessage({ type: 'token', gateway: d.gateway, token: tokens[d.gateway] })
})

export function getToken (gateway: string): GatewayToken | undefined {
  const t = tokens[gateway]
  if (t && expiresAt(t.token) - 60000 < Date.now()) { signOut(gateway, true); return undefined }
  return t
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

// Lookups shared by the settings panel and the runtime in this window (and repeated tree expands):
// the same request within CACHE_MS returns the same promise
const CACHE_MS = 5 * 60 * 1000
const lookups = new Map<string, { at: number, promise: Promise<any> }>()
function memo<T> (key: string, fn: () => Promise<T>): Promise<T> {
  const hit = lookups.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise
  const promise = fn().catch(err => { lookups.delete(key); throw err })
  lookups.set(key, { at: Date.now(), promise })
  return promise
}
const memoKey = (gateway: string, path: string) => `${gateway}|${warehouses[gateway] || ''}|${tokens[gateway]?.user || ''}|${path}`

async function getJson (gateway: string, path: string): Promise<any> {
  if (!tokens[gateway]) throw new Error('Not signed in')
  let r: Response
  try {
    r = await fetch(`${gateway}${path}`, { headers: gatewayHeaders(gateway) })
  } catch {
    // A rejected/expired token comes back as a cross-origin login redirect, which fetch reports this way
    throw new Error('The gateway did not answer. If this keeps happening, sign in again.')
  }
  if (r.status === 401) { signOut(gateway, true); throw new Error('Your Databricks sign-in expired. Sign in again.') }
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error?.message || d.error || `HTTP ${r.status}`)
  return d
}

/** realtime: a Lakehouse//RT warehouse (map reads there; metadata and edits stay on the gateway's bound warehouse) */
export interface WarehouseInfo { id: string, name: string, state: string, size: string, serverless: boolean, realtime?: boolean }

/** Allow-listed warehouses the signed-in user can use, and the gateway's default. */
export async function fetchWarehouses (gateway: string): Promise<{ default: string | null, warehouses: WarehouseInfo[] }> {
  return memo(memoKey(gateway, '/api/warehouses'), () => getJson(gateway, '/api/warehouses'))
}

/** Other GeoLakeLayers gateways this gateway knows about (its workspace directory). */
export async function fetchDirectory (gateway: string): Promise<Array<{ name: string, url: string }>> {
  return (await memo(memoKey(gateway, '/api/info'), () => getJson(gateway, '/api/info'))).directory || []
}

/** Whether this gateway's editing master switch is on. */
export async function fetchEditing (gateway: string): Promise<boolean> {
  return !!(await memo(memoKey(gateway, '/api/info'), () => getJson(gateway, '/api/info'))).editing
}

/** Catalogs the signed-in user can see. */
export async function fetchCatalogNames (gateway: string): Promise<string[]> {
  return (await memo(memoKey(gateway, '/api/catalogs'), () => getJson(gateway, '/api/catalogs'))).catalogs
}

/** Open the sign-in popup. false when the browser blocked it (the caller should say so). */
export function signIn (gateway: string): boolean {
  const popup = window.open(`${gateway}/auth/handoff?origin=${encodeURIComponent(window.location.origin)}`, 'dbx-signin', 'width=520,height=640')
  return !!popup && !popup.closed
}

/**
 * Calls onToken when a token for this gateway arrives (from the handoff popup or another same-origin
 * builder window), and with null when it expires or is rejected. Returns an unsubscribe function.
 */
export function listenForToken (gateway: string, onToken: (t: GatewayToken | null) => void): () => void {
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
  return (await memo(memoKey(gateway, `/api/catalog${q}`), () => getJson(gateway, `/api/catalog${q}`))).tables
}

/** catalog.schema.table -> a minimal CatalogTable for layers saved in config */
export function tableRef (table: string): CatalogTable {
  const [catalog, schema, name] = table.split('.')
  return { table, catalog, schema, name, idField: '', geometry: '' }
}
