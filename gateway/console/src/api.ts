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

export interface OptimizeJob { id: string, state: 'running' | 'done' | 'failed', source: string, target: string, startedAt: number, finishedAt?: number, rows?: number, error?: string }

async function get<T> (path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.error?.message || d?.error || `HTTP ${r.status}`)
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
  count: (table: string) => get<{ count: number }>(`${layerPath(table)}/query?f=json&where=1%3D1&returnCountOnly=true`).then(d => d.count)
}

export function layerPath (table: string): string {
  return `/databricks/rest/services/${table}/FeatureServer/0`
}
