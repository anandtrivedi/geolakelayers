/*
  Gateway layers as Experience Builder data sources.

  Each table becomes a FEATURE_LAYER data source (the same recipe the built-in Add Data widget uses for
  a layer URL), its layer is created by the data source, and it is added through
  jimuMapView.addLayerAndCreateJimuLayerView so Legend, Layer List, Table and Filter see it like any
  other runtime layer. Create/remove are announced with DATA_SOURCES_CHANGE.

  Start-up layers are also the widget's output data sources (saved in the app by the settings panel,
  see outputs.ts), so other widgets can be connected to them in the builder: a Filter or Select narrows
  the data source, and Experience Builder applies that to the layer as its definitionExpression, which the
  gateway runs as SQL. Those data sources belong to the app: the widget reuses them, keeps them NOT_READY
  until the layer is on the map (other widgets wait instead of querying without a sign-in), and doesn't
  destroy them. Widgets connected to an output data source work on its "output" data view, so that view's
  filters are what the layer draws (the layer view stays on the main data source, which selection uses).
*/
import {
  Immutable, DataSourceManager, MessageManager, DataSourcesChangeMessage, DataSourcesChangeType,
  ServiceManager, dataSourceUtils, DataSourceStatus, getAppStore, appActions
} from 'jimu-core'
import type { DataSource } from 'jimu-core'
import type { JimuMapView, JimuLayerView } from 'jimu-arcgis'
import FeatureLayer from 'esri/layers/FeatureLayer'
import { gatewayHeaders } from '../auth'
import { layerUrl, outputDataSourceId } from '../outputs'

export interface GatewayLayer {
  layer: __esri.FeatureLayer
  dataSource: DataSource | null
  jimuLayerView: JimuLayerView | null
  /** Set when the data source couldn't be created and a plain layer was added instead */
  fallbackReason?: string
  /** The data source is one of the widget's saved output data sources */
  output?: boolean
  /** Stops applying the output view's filters to the layer */
  stopSync?: () => void
}

export { layerUrl }

// Unique per add attempt: a readable part, a hash of the full key (sanitizing alone can collide,
// e.g. a.b_c and a_b.c), and a counter so a late cleanup of an earlier attempt can't destroy a newer one
let attempt = 0
export function dataSourceId (widgetId: string, key: string): string {
  return `${outputDataSourceId(widgetId, key)}_${++attempt}`
}

function setStatus (id: string, status: DataSourceStatus): void {
  getAppStore().dispatch(appActions.dataSourceStatusChanged(id, status))
}

// Draw what the widgets connected to the output data source asked for: the where of its output view, and
// its time ([start, end] in ms, set by a Timeline) on a time-aware layer
function followOutputView (outputId: string, layer: __esri.FeatureLayer): () => void {
  let last = ''
  const apply = () => {
    const view: any = DataSourceManager.getInstance().getDataSource(`${outputId}-output`)
    const query = view?.getRealQueryParams?.({}, 'query') || {}
    const where = query.where || '1=1'
    const time: number[] | null = Array.isArray(query.time) && query.time.length === 2 ? query.time : null
    const key = `${where}|${time ? time.join(',') : ''}`
    if (key === last) return
    last = key
    layer.definitionExpression = where === '1=1' ? null : where
    if (layer.timeInfo) layer.timeExtent = (time ? { start: new Date(time[0]), end: new Date(time[1]) } : null) as any
  }
  apply()
  return getAppStore().subscribe(apply)
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
  /** Id of the widget's output data source for this layer, when it has one */
  outputId?: string
}): Promise<GatewayLayer> {
  const { widgetId, jmv, gateway, key, table, title, outputId } = opts
  const url = layerUrl(gateway, table)
  const id = outputId || dataSourceId(widgetId, key)
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

    const manager = DataSourceManager.getInstance()
    let ds: DataSource
    if (outputId) {
      // Other widgets may have tried to create it before the sign-in, when Experience Builder's fetch of the
      // definition had no token; that failure is cached, so drop it and create it again
      if (getAppStore().getState().dataSourcesInfo?.[outputId]?.instanceStatus === 'CREATE_ERROR') manager.destroyDataSource(outputId)
      ds = manager.getDataSource(outputId) || await manager.createDataSource(outputId)
    } else {
      const created = dataSourceUtils.dataSourceJsonCreator.createDataSourceJsonByLayerDefinition(id, definition, url)
      if (!created) throw new Error('Could not build a data source for this layer')
      const dsJson = created.asMutable({ deep: true })
      dsJson.label = title
      dsJson.sourceLabel = title
      ds = await manager.createDataSource({ id, dataSourceJson: Immutable(dsJson) })
      createdSource = ds
    }
    const layer = (await (ds as any).createJSAPILayerByDataSource()) as __esri.FeatureLayer
    layer.title = title
    createdLayer = layer
    const jimuLayerView = await jmv.addLayerAndCreateJimuLayerView(layer, ds)
    if (outputId) {
      setStatus(outputId, DataSourceStatus.Unloaded)
      return { layer, dataSource: ds, jimuLayerView, output: true, stopSync: followOutputView(outputId, layer) }
    }
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
  forgetGatewayLayer(widgetId, gl)
}

/** The layer is already off the map (removed by another widget): just drop its data source. */
export function forgetGatewayLayer (widgetId: string, gl: GatewayLayer | null): void {
  gl?.stopSync?.()
  if (!gl?.dataSource) return
  if (gl.output) { setStatus(gl.dataSource.id, DataSourceStatus.NotReady); return }
  publish(widgetId, DataSourcesChangeType.Remove, gl.dataSource)
  DataSourceManager.getInstance().destroyDataSource(gl.dataSource.id)
}
