import type { ImmutableObject } from 'jimu-core'

/** One Databricks workspace, reached through its feature gateway (a sign-in is per workspace). */
export interface Workspace {
  /** Stable id used in saved layer keys */
  id: string
  /** Name shown to authors and viewers, e.g. "prod" */
  label: string
  /** Feature gateway app URL, no trailing slash */
  gatewayUrl: string
  /** SQL warehouse to query with (one of the gateway's allowed warehouses); empty = gateway default */
  warehouseId: string
  /** Catalogs whose tables viewers can browse */
  catalogs: string[]
}

export interface Config {
  workspaces: Workspace[]
  /** Layers added when the app opens, in order, as "<workspaceId>::<catalog.schema.table>" */
  layers: string[]
  /** Let viewers browse the catalog and add more tables (default true) */
  allowBrowse: boolean

  /** @deprecated single-workspace settings before 1.20.3; migrated into `workspaces` */
  gatewayUrl?: string
  /** @deprecated see gatewayUrl */
  warehouseId?: string
  /** @deprecated see gatewayUrl */
  catalogs?: string[]
  /** @deprecated replaced by `catalogs` in 1.20.2 */
  catalogFilter?: string
}

export type IMConfig = ImmutableObject<Config>

export interface CatalogTable {
  table: string
  catalog: string
  schema: string
  name: string
  idField: string
  geometry: string
}
