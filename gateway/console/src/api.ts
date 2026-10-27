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
  overrides: { enabled: boolean, table: string | null }
  ogc: { enabled: boolean, table: string | null }
  widgetSource: string | null
  /** Where to get the ArcGIS Custom Data Feed provider (feature services in ArcGIS Enterprise); null = don't mention it */
  cdfSource: string | null
  /** Tables read as the app for anyone who signs in */
  openTables: string[]
}

export interface Warehouse { id: string, name: string, state: string, size: string, serverless: boolean, realtime?: boolean }

export interface CatalogTable {
  table: string
  catalog: string
  schema: string
  name: string
  idField: string
  geometry: string
  detectedBy?: 'type' | 'content' | 'override'
}

export interface LayerSpec {
  objectId: string
  idSource: 'override' | 'primary key' | 'derived'
  geometryColumn: string | null
  geometrySource: string
  geometryType: string
  geometryDetectedBy: 'type' | 'content' | 'override'
  geometryCandidates: string[]
  syntheticIdFrom?: string
  bboxColumns?: boolean
  columns: { name: string, type: string }[]
}

export interface LayerOverride { geometryColumn: string | null, srid: number | null, lonColumn: string | null, latColumn: string | null, idColumn: string | null }
export interface ScanResult { schema: string, checked: number, skipped: number, found: (CatalogTable & { geometrySource: string })[], failed: { table: string, error: string }[] }

export interface OgcCollection { id: string, table: string, title: string, description?: string, timeField: string | null }
export interface OgcService {
  name: string
  title: string
  description: string
  collections: OgcCollection[]
  /** Engine: warehouse id for reads ('' = the gateway's bound warehouse) */
  warehouse?: string
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
  /** 'preflight' = stopped because no grant was found (can be retried with force); 'permission'; 'not_found' */
  code?: string
  /** What the grant check found missing, e.g. "CREATE TABLE on schema main.geo" */
  missing?: string[]
  constructor (message: string, status: number, setup = false, code?: string, missing?: string[]) { super(message); this.status = status; this.setup = setup; this.code = code; this.missing = missing }
}

/** What the caller's grants allow (ok null = couldn't tell) */
export interface Access { ok: boolean | null, missing?: string[], reason?: string }
/** Result of creating a settings table: the read grant may fail separately */
export interface SetupResult { ready: boolean, granted?: boolean, grant?: string, warning?: string }

export interface OptimizeJob { id: string, state: 'running' | 'done' | 'failed', source: string, target: string, startedAt: number, finishedAt?: number, rows?: number, error?: string }

async function get<T> (path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(d?.error?.message || d?.error || d?.description || `HTTP ${r.status}`, r.status, !!d?.setup, d?.code)
  return d as T
}

async function send<T> (method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(d?.error || `HTTP ${r.status}`, r.status, !!d?.setup, d?.code, d?.missing)
  return d as T
}

export const api = {
  info: () => get<GatewayInfo>('/api/info'),
  token: () => send<{ token: string, expiresAt: number | null }>('POST', '/api/token'),
  load: () => get<ServerLoad>('/api/load'),
  health: () => get<{ checks: { name: string, table: string, ok: boolean, detail?: string }[] }>('/api/health').then(d => d.checks),
  warehouses: () => get<{ default: string | null, warehouses: Warehouse[] }>('/api/warehouses'),
  catalogs: () => get<{ catalogs: string[] }>('/api/catalogs').then(d => d.catalogs),
  tables: (catalog: string) => get<{ tables: CatalogTable[] }>(`/api/catalog?catalogs=${encodeURIComponent(catalog)}`).then(d => d.tables),
  spec: (table: string) => get<{ spec: LayerSpec | null }>(`/api/spec/${encodeURIComponent(table)}`).then(d => d.spec),
  specDetail: (table: string) => get<{ spec: LayerSpec | null, columns: { name: string, type: string }[], override: (LayerOverride & { updatedBy?: string }) | null }>(`/api/spec/${encodeURIComponent(table)}`),
  optimize: (table: string, target: string, name: string, force = false) => send<OptimizeJob>('POST', '/api/optimize', { table, target, name, force }),
  access: (action: 'SELECT' | 'MODIFY' | 'CREATE_TABLE', name: string) => get<Access>(`/api/access?action=${action}&name=${encodeURIComponent(name)}`),
  job: (id: string) => get<OptimizeJob>(`/api/optimize/${id}`),
  ogcServices: () => get<{ table: string, services: OgcService[] }>('/api/ogc/services').then(d => d.services),
  ogcSave: (s: OgcService, isNew: boolean) => isNew
    ? send<OgcService>('POST', '/api/ogc/services', s)
    : send<OgcService>('PUT', `/api/ogc/services/${encodeURIComponent(s.name)}`, s),
  ogcDelete: (name: string) => send<void>('DELETE', `/api/ogc/services/${encodeURIComponent(name)}`),
  ogcSetup: (force = false) => send<SetupResult>('POST', '/api/ogc/setup', { force }),
  ogcColumns: (table: string) => get<OgcColumns>(`/api/ogc/columns/${encodeURIComponent(table)}`),
  overridesInfo: () => get<{ enabled: boolean, table: string | null, missing: boolean }>('/api/overrides'),
  overridesSetup: (force = false) => send<SetupResult>('POST', '/api/overrides/setup', { force }),
  saveOverride: (table: string, o: LayerOverride) => send<{ spec: LayerSpec | null }>('PUT', `/api/overrides/${encodeURIComponent(table)}`, o),
  clearOverride: (table: string) => send<void>('DELETE', `/api/overrides/${encodeURIComponent(table)}`),
  scan: (schema: string) => get<ScanResult>(`/api/scan?schema=${encodeURIComponent(schema)}`),
  count: (table: string) => get<{ count: number }>(`${layerPath(table)}/query?f=json&where=1%3D1&returnCountOnly=true`).then(d => d.count)
}

export function layerPath (table: string): string {
  return `/databricks/rest/services/${table}/FeatureServer/0`
}

export interface ServerLoad { heapUsed: number, heapLimit: number, rss: number, memoryLimit: number | null, inFlight: number, cpu: number, cores: number, uptime: number }
