/*
  The widget's output data sources: one FEATURE_LAYER per start-up layer, saved in the app by the
  settings panel. That is what lets authors connect other widgets (Filter, Select, List, Chart, Table,
  message actions) to Databricks layers in the builder. Viewers' own adds stay runtime-only.

  The schema is saved too, so other widgets' settings can list fields without fetching the layer.
  Experience Builder still fetches the layer definition when it creates the data source, and that request
  doesn't carry the gateway token, so the definition we fetched is handed to it first (as in layers.ts).
*/
import { dataSourceUtils, ServiceManager, DataSourceManager, getAppStore } from 'jimu-core'
import type { DataSourceJson } from 'jimu-core'
import { gatewayHeaders } from './auth'
import { parseLayerKey } from './workspaces'
import type { Workspace } from './config'

export function layerUrl (gateway: string, table: string): string {
  return `${gateway}/databricks/rest/services/${table}/FeatureServer/0`
}

/** Stable id of the output data source for a start-up layer (same in the builder and every app load). */
export function outputDataSourceId (widgetId: string, key: string): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return `${widgetId}_dbx_${key.split('.').pop().replace(/[^A-Za-z0-9_]/g, '_')}_${h.toString(36)}`
}

/** Output data source JSON for a layer, from its definition (fetched with the author's token). */
export function outputDataSourceJson (id: string, url: string, title: string, definition: any): DataSourceJson {
  const fields: { [name: string]: any } = {}
  for (const f of definition.fields || []) fields[f.name] = dataSourceUtils.convertFieldToJimuField(f, null, null)
  return {
    id,
    type: 'FEATURE_LAYER',
    url,
    label: title,
    sourceLabel: title,
    geometryType: definition.geometryType,
    isOutputFromWidget: true,
    schema: { label: title, idField: definition.objectIdField, fields }
  } as DataSourceJson
}

/**
 * Popup field infos from a data source schema: each field's title, and for numbers the format set in the
 * app's data settings (e.g. an MMSI without thousands separators), so popups read like the Table widget.
 */
export function popupFieldInfos (schemaFields: { [name: string]: any } | undefined, layerFields: Array<{ name: string, alias?: string }>): any[] {
  return layerFields.map(f => {
    const s = schemaFields?.[f.name]
    const info: any = { fieldName: f.name, label: s?.alias || f.alias || f.name, visible: true }
    const fmt = s?.fieldFormat
    if (s?.type === 'NUMBER' && fmt) {
      info.format = { digitSeparator: fmt.useGrouping !== 'never' && fmt.useGrouping !== false }
      if (Number.isInteger(fmt.maximumFractionDigits)) info.format.places = fmt.maximumFractionDigits
    }
    return info
  })
}

/**
 * Output data sources for the start-up layers. A layer whose workspace isn't signed in keeps the JSON
 * already saved for it (if any), so opening the settings without signing in changes nothing.
 */
export async function buildOutputDataSources (opts: {
  widgetId: string
  workspaces: Workspace[]
  layers: string[]
  titleOf: (ws: Workspace, table: string) => string
  saved: (id: string) => DataSourceJson | undefined
  signedIn: (ws: Workspace) => boolean
}): Promise<DataSourceJson[]> {
  const { widgetId, workspaces, layers, titleOf, saved, signedIn } = opts
  const out = await Promise.all(layers.map(async key => {
    const { workspaceId, table } = parseLayerKey(key)
    const ws = workspaces.find(w => w.id === workspaceId)
    const id = outputDataSourceId(widgetId, key)
    if (!ws || !signedIn(ws)) return saved(id) || null
    const url = layerUrl(ws.gatewayUrl, table)
    try {
      const r = await fetch(`${url}?f=json`, { headers: gatewayHeaders(ws.gatewayUrl) })
      const definition = await r.json()
      if (!r.ok || definition.error) return saved(id) || null
      ServiceManager.getInstance().setServiceInfo(url, { definition, isHostedInSamePortal: false })
      return outputDataSourceJson(id, url, titleOf(ws, table), definition)
    } catch {
      return saved(id) || null
    }
  }))
  return out.filter(Boolean)
}

/** Create again the output data sources Experience Builder failed to create before the sign-in. */
export function retryFailedOutputs (ids: string[]): void {
  const info = (getAppStore().getState() as any).appStateInBuilder?.dataSourcesInfo || getAppStore().getState().dataSourcesInfo || {}
  const manager = DataSourceManager.getInstance()
  for (const id of ids) {
    if (info[id]?.instanceStatus !== 'CREATE_ERROR') continue
    manager.destroyDataSource(id)
    manager.createDataSource(id).catch(() => {})
  }
}
