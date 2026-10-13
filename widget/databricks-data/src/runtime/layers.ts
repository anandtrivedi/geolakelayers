/*
  Gateway layers as Experience Builder data sources.

  Each table becomes a FEATURE_LAYER data source (the same recipe the built-in Add Data widget uses for
  a layer URL), its layer is created by the data source, and it is added through
  jimuMapView.addLayerAndCreateJimuLayerView so Legend, Layer List, Table and Filter see it like any
  other runtime layer. Create/remove are announced with DATA_SOURCES_CHANGE.
*/
import {
  Immutable, DataSourceManager, MessageManager, DataSourcesChangeMessage, DataSourcesChangeType,
  ServiceManager, dataSourceUtils
} from 'jimu-core'
import type { DataSource } from 'jimu-core'
import type { JimuMapView, JimuLayerView } from 'jimu-arcgis'
import FeatureLayer from 'esri/layers/FeatureLayer'
import { gatewayHeaders } from '../auth'

export interface GatewayLayer {
  layer: __esri.FeatureLayer
  dataSource: DataSource | null
  jimuLayerView: JimuLayerView | null
  /** Set when the data source couldn't be created and a plain layer was added instead */
  fallbackReason?: string
}

export function layerUrl (gateway: string, table: string): string {
  return `${gateway}/databricks/rest/services/${table}/FeatureServer/0`
}

// Unique per add attempt: a readable part, a hash of the full key (sanitizing alone can collide,
// e.g. a.b_c and a_b.c), and a counter so a late cleanup of an earlier attempt can't destroy a newer one
let attempt = 0
export function dataSourceId (widgetId: string, key: string): string {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0
  return `${widgetId}_dbx_${key.split('.').pop().replace(/[^A-Za-z0-9_]/g, '_')}_${h.toString(36)}_${++attempt}`
}

function publish (widgetId: string, type: DataSourcesChangeType, ds: DataSource): void {
  MessageManager.getInstance().publishMessage(new DataSourcesChangeMessage(widgetId, type, [ds]))
}

/**
 * Create the data source and layer for a table and add it to the map. Falls back to adding a plain
 * FeatureLayer if the data source can't be created, so the map still works without the integration.
 */
export async function addGatewayLayer (opts: {
  widgetId: string
  jmv: JimuMapView
  gateway: string
  /** Layer key (workspace + table), unique per widget */
  key: string
  table: string
  title: string
}): Promise<GatewayLayer> {
  const { widgetId, jmv, gateway, key, table, title } = opts
  const url = layerUrl(gateway, table)
  const id = dataSourceId(widgetId, key)
  let createdSource: DataSource | null = null
  let createdLayer: __esri.FeatureLayer | null = null
  try {
    // Layer definition via our own request, so the token doesn't depend on which code path ExB uses
    const r = await fetch(`${url}?f=json`, { headers: gatewayHeaders(gateway) })
    const definition = await r.json()
    if (!r.ok || definition.error) throw new Error(definition.error?.message || `HTTP ${r.status}`)

    // Hand Experience Builder the definition we fetched with the token. Some of its data-source code
    // fetches service info itself without going through the SDK interceptors, so that request would go
    // out unauthenticated and the data source would fail (the layer then only works as a plain layer).
    ServiceManager.getInstance().setServiceInfo(url, { definition, isHostedInSamePortal: false })

    const created = dataSourceUtils.dataSourceJsonCreator.createDataSourceJsonByLayerDefinition(id, definition, url)
    if (!created) throw new Error('Could not build a data source for this layer')
    const dsJson = created.asMutable({ deep: true })
    dsJson.label = title
    dsJson.sourceLabel = title

    const manager = DataSourceManager.getInstance()
    const ds = await manager.createDataSource({ id, dataSourceJson: Immutable(dsJson) })
    createdSource = ds
    const layer = (await (ds as any).createJSAPILayerByDataSource()) as __esri.FeatureLayer
    layer.title = title
    createdLayer = layer
    const jimuLayerView = await jmv.addLayerAndCreateJimuLayerView(layer, ds)
    publish(widgetId, DataSourcesChangeType.Create, ds)
    return { layer, dataSource: ds, jimuLayerView }
  } catch (err) {
    // Undo whatever got created before falling back, so nothing leaks or is drawn twice
    if (createdLayer) jmv.view.map.remove(createdLayer)
    if (createdSource) DataSourceManager.getInstance().destroyDataSource(createdSource.id)
    console.warn(`Databricks Data: ${table} added without a data source (${err.message})`)
    const layer = new FeatureLayer({ url, title, outFields: ['*'] })
    jmv.view.map.add(layer)
    return { layer, dataSource: null, jimuLayerView: null, fallbackReason: err.message }
  }
}

export function removeGatewayLayer (widgetId: string, jmv: JimuMapView | null, gl: GatewayLayer): void {
  if (gl.jimuLayerView && jmv) {
    jmv.removeJimuLayerView(gl.jimuLayerView)
  } else {
    jmv?.view.map.remove(gl.layer)
  }
  if (gl.dataSource) {
    publish(widgetId, DataSourcesChangeType.Remove, gl.dataSource)
    DataSourceManager.getInstance().destroyDataSource(gl.dataSource.id)
  }
}

/** The layer is already off the map (removed by another widget): just drop its data source. */
export function forgetGatewayLayer (widgetId: string, gl: GatewayLayer | null): void {
  if (!gl?.dataSource) return
  publish(widgetId, DataSourcesChangeType.Remove, gl.dataSource)
  DataSourceManager.getInstance().destroyDataSource(gl.dataSource.id)
}
