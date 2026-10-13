import type { ImmutableObject } from 'jimu-core'

export interface Config {
  /** Databricks feature gateway app URL, no trailing slash */
  gatewayUrl: string
  /** Optional prefix, e.g. "main.ais", to narrow the table list */
  catalogFilter: string
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
