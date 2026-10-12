import type { ImmutableObject } from 'jimu-core'

export interface Config {
  /** Databricks feature gateway app URL, no trailing slash */
  gatewayUrl: string
  /** Optional prefix, e.g. "main.ais", to narrow the table list */
  catalogFilter: string
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
