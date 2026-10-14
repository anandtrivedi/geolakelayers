// Same-origin calls to the gateway; the Databricks Apps session cookie authenticates them.

export interface GatewayInfo {
  name: string
  version: string
  user: string | null
  workspaceHost: string | null
  gatewayUrl: string
  runAs: 'user' | 'app'
  defaultWarehouse: string | null
  allowedWarehouses: string[]
  allowedOrigins: string[]
  catalogCap: string[]
  excludeCatalogs: string[]
  directory: { name: string, url: string }[]
  editing: boolean
  ogc: { enabled: boolean, table: string | null }
}

export interface Warehouse { id: string, name: string, state: string, size: string, serverless: boolean }

export interface CatalogTable {
  table: string
  catalog: string
  schema: string
  name: string
  idField: string
  geometry: string
}

export interface LayerSpec {
  objectId: string
  geometrySource: string
  geometryType: string
  syntheticIdFrom?: string
  bboxColumns?: boolean
}

export interface OgcCollection { id: string, table: string, title: string, description?: string, timeField: string | null }
export interface OgcService {
  name: string
  title: string
  description: string
  collections: OgcCollection[]
  owner?: string | null
  updatedBy?: string | null
  updatedAt?: string | null
  version?: number
}
export interface OgcColumns { table: string, idField: string, count: number, timeFields: string[], queryables: string[] }

/** Error from the gateway; setup = the OGC services table doesn't exist yet */
export class ApiError extends Error {
  status: number
  setup: boolean
  constructor (message: string, status: number, setup = false) { super(message); this.status = status; this.setup = setup }
}

export interface OptimizeJob { id: string, state: 'running' | 'done' | 'failed', source: string, target: string, startedAt: number, finishedAt?: number, rows?: number, error?: string }

async function get<T> (path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(d?.error?.message || d?.error || d?.description || `HTTP ${r.status}`, r.status, !!d?.setup)
  return d as T
}

async function send<T> (method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(d?.error || `HTTP ${r.status}`, r.status, !!d?.setup)
  return d as T
}

export const api = {
  info: () => get<GatewayInfo>('/api/info'),
  warehouses: () => get<{ default: string | null, warehouses: Warehouse[] }>('/api/warehouses'),
  catalogs: () => get<{ catalogs: string[] }>('/api/catalogs').then(d => d.catalogs),
  tables: (catalog: string) => get<{ tables: CatalogTable[] }>(`/api/catalog?catalogs=${encodeURIComponent(catalog)}`).then(d => d.tables),
  spec: (table: string) => get<{ spec: LayerSpec | null }>(`/api/spec/${encodeURIComponent(table)}`).then(d => d.spec),
  optimize: async (table: string, target: string, name: string): Promise<OptimizeJob> => {
    const r = await fetch('/api/optimize', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table, target, name }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`)
    return d
  },
  job: (id: string) => get<OptimizeJob>(`/api/optimize/${id}`),
  ogcServices: () => get<{ table: string, services: OgcService[] }>('/api/ogc/services').then(d => d.services),
  ogcSave: (s: OgcService, isNew: boolean) => isNew
    ? send<OgcService>('POST', '/api/ogc/services', s)
    : send<OgcService>('PUT', `/api/ogc/services/${encodeURIComponent(s.name)}`, s),
  ogcDelete: (name: string) => send<void>('DELETE', `/api/ogc/services/${encodeURIComponent(name)}`),
  ogcSetup: () => send<{ ready: boolean }>('POST', '/api/ogc/setup'),
  ogcColumns: (table: string) => get<OgcColumns>(`/api/ogc/columns/${encodeURIComponent(table)}`),
  count: (table: string) => get<{ count: number }>(`${layerPath(table)}/query?f=json&where=1%3D1&returnCountOnly=true`).then(d => d.count)
}

export function layerPath (table: string): string {
  return `/databricks/rest/services/${table}/FeatureServer/0`
}
