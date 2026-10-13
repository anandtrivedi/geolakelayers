import type { ImmutableObject } from 'jimu-core'

export interface Config {
  /** Databricks feature gateway app URL, no trailing slash */
  gatewayUrl: string
  /** SQL warehouse to query with (one of the gateway's allowed warehouses); empty = gateway default */
  warehouseId: string
  /** Catalogs whose tables are offered */
  catalogs: string[]
  /** @deprecated replaced by `catalogs` in 1.20.2; kept so old configs can be migrated */
  catalogFilter?: string
  /** Tables (catalog.schema.table) added to the map when the app opens, in order */
  layers: string[]
  /** Let viewers browse the catalog and add more tables (default true) */
  allowBrowse: boolean
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
