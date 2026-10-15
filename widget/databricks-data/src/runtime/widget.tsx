/** @jsx jsx */
/*
  Databricks Data — runtime

  1. Sign in: one popup per workspace opens <gateway>/auth/handoff. The Databricks login happens there
     (first-party), and the page posts the user's token back to this origin.
  2. A request interceptor per gateway adds that token (and the chosen warehouse) to every SDK request.
  3. Picking a table creates a FEATURE_LAYER data source for
     <gateway>/databricks/rest/services/<table>/FeatureServer/0 and adds its layer to the selected map
     (see layers.ts), so other widgets (Legend, Layer List, Table, Filter) can use it.
*/
import { React, jsx, css, getAppStore } from 'jimu-core'
import type { AllWidgetProps } from 'jimu-core'
import { JimuMapViewComponent } from 'jimu-arcgis'
import type { JimuMapView } from 'jimu-arcgis'
import { Alert, Button, Loading, LoadingType, TextInput } from 'jimu-ui'
import esriConfig from 'esri/config'
import * as reactiveUtils from 'esri/core/reactiveUtils'
import type { IMConfig, CatalogTable, Workspace } from '../config'
import { getToken, signIn as openSignIn, signInNotice, listenForToken, fetchCatalog, tableRef, setWarehouse, gatewayHeaders } from '../auth'
import { workspacesOf, layerKey, parseLayerKey } from '../workspaces'
import { TableTree } from '../table-tree'
import { announceLayer } from '../sync'
import { addGatewayLayer, removeGatewayLayer, forgetGatewayLayer } from './layers'
import type { GatewayLayer } from './layers'
import { versionManager } from '../version-manager'
import defaultMessages from './translations/default'

function soleMapWidgetId (): string | undefined {
  const widgets = getAppStore().getState()?.appConfig?.widgets || {}
  const maps = Object.keys(widgets).filter(id => widgets[id].uri === 'widgets/arcgis/arcgis-map/')
  return maps.length === 1 ? maps[0] : undefined
}

// Shared by every instance of the widget in the app
const interceptorFor = new Set<string>()
// Layers each widget added, kept across remounts (e.g. a Widget Controller panel closed and reopened),
// so saved layers aren't added a second time to the same map
const addedByWidget = new Map<string, Added[]>()

function ensureInterceptor (gateway: string): void {
  if (interceptorFor.has(gateway)) return
  interceptorFor.add(gateway)
  // Only the first matching interceptor runs, and Experience Builder registers a catch-all one at startup,
  // so ours has to go first or gateway requests go out without the token (and fall back to the Portal proxy)
  esriConfig.request.interceptors.unshift({
    urls: gateway,
    before: (params: any) => {
      if (!getToken(gateway)) return
      params.requestOptions.headers = { ...(params.requestOptions.headers || {}), ...gatewayHeaders(gateway) }
    }
  })
}

// Distinct color per added layer, symbol by geometry type
const PALETTE = ['#e4572e', '#2e86ab', '#3bb273', '#7768ae', '#f3a712', '#d1495b', '#00798c', '#8d6a9f']
function rendererFor (geometryType: string, n: number) {
  const c = PALETTE[n % PALETTE.length]
  const symbol = geometryType === 'polygon'
    ? { type: 'simple-fill', color: c + '55', outline: { color: c, width: 1 } }
    : geometryType === 'polyline'
      ? { type: 'simple-line', color: c, width: 2 }
      : { type: 'simple-marker', color: c + 'cc', size: 6, outline: { color: '#ffffff', width: 0.5 } }
  return { type: 'simple', symbol }
}

type AddState = 'adding' | 'drawing' | 'ready' | 'failed'
interface Added { key: string, workspaceId: string, table: string, gl: GatewayLayer | null, state: AddState, info: string }

const STATE_MESSAGE: { [k in AddState]: keyof typeof defaultMessages } = {
  adding: 'stateAdding', drawing: 'stateDrawing', ready: 'stateReady', failed: 'stateFailed'
}

// Official Databricks symbol (Brandfolder "Databricks Symbol", databricks-symbol-color.svg)
const DatabricksMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size * 331 / 300} viewBox='0 0 300 331' aria-hidden='true' style={{ flex: 'none' }}>
    <path fill='#FF3621' d='M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z' />
  </svg>
)

const Widget = (props: AllWidgetProps<IMConfig>) => {
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)

  const workspaces = workspacesOf(props.config)
  const multi = workspaces.length > 1
  const allowBrowse = props.config.allowBrowse !== false
  const savedLayers: string[] = props.config.layers ? props.config.layers.asMutable() : []
  // The configured map, or the app's only Map widget when none is picked (e.g. right after the widget is
  // moved into a Widget Controller, which creates a fresh instance with empty settings)
  const mapId = props.useMapWidgetIds?.[0] || soleMapWidgetId()
  // In the builder, layers the author adds or removes here are saved to the widget's settings
  const inBuilder = !!getAppStore().getState()?.appContext?.isInBuilder

  // Before any request goes out: one interceptor per gateway and the warehouse the author picked
  for (const ws of workspaces) {
    setWarehouse(ws.gatewayUrl, ws.warehouseId)
    ensureInterceptor(ws.gatewayUrl)
  }

  const [jmv, setJmv] = React.useState<JimuMapView>(null)
  // Signed-in user per gateway URL (keyed by URL so editing a workspace's URL can't show a stale sign-in)
  // Sign-in problems to show next to each workspace's button: a blocked popup
  const [blocked, setBlocked] = React.useState<{ [gatewayUrl: string]: boolean }>({})
  const startSignIn = (url: string) => setBlocked(b => ({ ...b, [url]: !openSignIn(url) }))
  const [users, setUsers] = React.useState<{ [gatewayUrl: string]: string }>(() => {
    const u = {}
    for (const ws of workspaces) if (getToken(ws.gatewayUrl)) u[ws.gatewayUrl] = getToken(ws.gatewayUrl).user
    return u
  })
  const userOf = (ws: Workspace) => users[ws.gatewayUrl]
  const [filter, setFilter] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [added, setAddedState] = React.useState<Added[]>(() => addedByWidget.get(props.id) || [])
  const addedRef = React.useRef<Added[]>(addedByWidget.get(props.id) || [])
  const setAdded = (list: Added[]) => { addedByWidget.set(props.id, list); setAddedState(list) }
  const savedRef = React.useRef<string[]>([])
  const loadGeneration = React.useRef(0)
  const colorIndex = React.useRef(0)
  const prevSaved = React.useRef<string[]>([])

  const isCurrent = (entry: Added) => addedRef.current.includes(entry)
  const update = (entry: Added, patch: Partial<Added>) => {
    if (!isCurrent(entry)) return
    Object.assign(entry, patch)
    setAdded([...addedRef.current])
  }

  const wsKey = workspaces.map(w => w.id + '=' + w.gatewayUrl).join('|')
  React.useEffect(() => {
    const offs = workspaces.map(ws => listenForToken(ws.gatewayUrl, t => setUsers(u => {
      const next = { ...u }
      if (t) next[ws.gatewayUrl] = t.user
      else delete next[ws.gatewayUrl]
      return next
    })))
    return () => offs.forEach(off => off())
  }, [wsKey])

  const remove = (entry: Added, fromConfig = false) => {
    addedRef.current = addedRef.current.filter(x => x !== entry)
    setAdded(addedRef.current)
    if (entry.gl) removeGatewayLayer(props.id, jmv, entry.gl)
    if (inBuilder && !fromConfig) announceLayer(props.id, 'remove', entry.key)
  }

  // A Databricks layer removed elsewhere (e.g. from Map Layers) drops out of the widget too
  React.useEffect(() => {
    if (!jmv) return
    const handle = jmv.view.map.layers.on('change', (e: any) => {
      for (const layer of e.removed || []) {
        const entry = addedRef.current.find(a => a.gl?.layer === layer)
        if (!entry) continue
        addedRef.current = addedRef.current.filter(x => x !== entry)
        setAdded(addedRef.current)
        forgetGatewayLayer(props.id, entry.gl)
        if (inBuilder) announceLayer(props.id, 'remove', entry.key)
      }
    })
    return () => handle.remove()
  }, [jmv])

  const addTable = async (ws: Workspace, t: CatalogTable, fromConfig = false) => {
    if (!getToken(ws.gatewayUrl)) return
    if (!jmv) {
      if (!fromConfig) setNotice(mapId ? nls('mapLoading') : nls('chooseMap'))
      return
    }
    setNotice('')
    const key = layerKey(ws.id, t.table)
    // Already on the map: zoom to it; still loading: ignore the click; failed: try again
    const existing = addedRef.current.find(a => a.key === key)
    if (existing) {
      if (existing.state === 'ready' && existing.gl?.layer.fullExtent) {
        jmv.view.goTo(existing.gl.layer.fullExtent.expand(1.2)).catch(() => {})
        return
      }
      if (existing.state !== 'failed') return
      remove(existing, true)
    }
    const name = t.name || t.table.split('.').pop()
    const title = multi ? `${name} · ${ws.label}` : name
    const entry: Added = { key, workspaceId: ws.id, table: t.table, gl: null, state: 'adding', info: '' }
    addedRef.current = [entry, ...addedRef.current]
    setAdded(addedRef.current)
    if (inBuilder && !fromConfig) announceLayer(props.id, 'add', key)
    const t0 = performance.now()
    try {
      const gl = await addGatewayLayer({ widgetId: props.id, jmv, gateway: ws.gatewayUrl, key, table: t.table, title })
      // Removed while it was being created: undo the add
      if (!isCurrent(entry)) { removeGatewayLayer(props.id, jmv, gl); return }
      entry.gl = gl
      const layer = gl.layer
      await layer.load()
      layer.renderer = rendererFor(layer.geometryType, colorIndex.current++) as any
      layer.outFields = ['*']
      layer.popupTemplate = { title, content: [{ type: 'fields' }] } as any
      // Editing needs both: the app allows it, and the gateway advertises it for this table
      const editable = props.config.allowEditing === true && !!(layer as any).capabilities?.operations?.supportsEditing
      layer.editingEnabled = editable
      // Big tables come with a minScale from the gateway: say so instead of looking empty when zoomed out
      const zoomHint = (layer.minScale > 0 ? ` · ${nls('zoomInToSee')}` : '') + (gl.fallbackReason ? ` · ${nls('notInLayerList')}` : '') +
        (editable ? ` · ${nls('editable')}` : '')
      const summary = nls('layerSummary', { type: layer.geometryType, n: String(layer.fields.length) }) + zoomHint
      update(entry, { state: 'drawing', info: summary })
      const lv = await jmv.view.whenLayerView(layer)
      // Zooming to the whole extent of a zoom-limited layer would hide it; leave the view where it is
      if (isCurrent(entry) && layer.fullExtent && !(layer.minScale > 0)) await jmv.view.goTo(layer.fullExtent.expand(1.2)).catch(() => {})
      await reactiveUtils.whenOnce(() => !lv.updating)
      update(entry, { state: 'ready', info: `${summary}, ${((performance.now() - t0) / 1000).toFixed(1)} s` })
    } catch (err) {
      update(entry, { state: 'failed', info: err.message })
    }
  }

  // Keep the map in step with the layers saved in settings: each loads once its workspace is signed in;
  // in the builder, unticking a layer in settings also takes it off the map
  const signedIn = workspaces.filter(ws => userOf(ws))
  savedRef.current = savedLayers
  React.useEffect(() => {
    if (!jmv) return
    const prev = prevSaved.current
    prevSaved.current = savedLayers
    if (inBuilder) {
      for (const k of prev) {
        const entry = savedLayers.includes(k) ? null : addedRef.current.find(a => a.key === k)
        if (entry) remove(entry, true)
      }
    }
    // A newer run (config changed, someone signed in) supersedes this one
    const generation = ++loadGeneration.current
    ;(async () => {
      for (const k of savedLayers) {
        if (generation !== loadGeneration.current || !savedRef.current.includes(k)) return
        const { workspaceId, table } = parseLayerKey(k)
        const ws = workspaces.find(w => w.id === workspaceId)
        if (!ws || !getToken(ws.gatewayUrl) || addedRef.current.some(a => a.key === k)) continue
        await addTable(ws, tableRef(table), true)
      }
    })()
  }, [jmv, signedIn.map(w => w.gatewayUrl).join(','), savedLayers.join('|')])

  const entryOf = (ws: Workspace, table: string) => added.find(a => a.key === layerKey(ws.id, table))
  const savedFor = (ws: Workspace) => savedLayers.filter(k => parseLayerKey(k).workspaceId === ws.id).length
  const browsable = signedIn.filter(ws => ws.catalogs.length)
  const failures = added.filter(a => a.state === 'failed')
  // Failures of saved layers whose workspace offers no browse tree to show them in
  const hiddenFailures = failures.filter(a => !allowBrowse || !browsable.some(w => w.id === a.workspaceId))

  const renderTable = (ws: Workspace, t: CatalogTable) => {
    const entry = entryOf(ws, t.table)
    const st = entry?.state
    const label = st === 'ready' ? nls('zoomToLayer') : st === 'failed' ? nls('retryLayer') : st ? nls(STATE_MESSAGE[st]) : nls('addToMap')
    return (
      <div className={`dbx-table${st ? ' dbx-table-added' : ''}`} title={label} aria-label={`${t.table}: ${label}`}>
        <div className='dbx-table-name'>
          <span className='dbx-table-label'><b>{t.name}</b></span>
          {st && (
            <span className='dbx-table-status'>
              {(st === 'adding' || st === 'drawing') && <Loading type={LoadingType.Donut} width={12} height={12} />}
              <small className={`dbx-state dbx-state-${st}`}>{nls(STATE_MESSAGE[st])}</small>
              <Button size='sm' type='tertiary' icon className='dbx-remove' title={nls('remove')}
                aria-label={nls('removeLayer', { table: t.table })}
                onClick={e => { e.stopPropagation(); if (entry) remove(entry) }}>×</Button>
            </span>
          )}
        </div>
        <small className='dbx-hint'>{entry?.info || nls('tableDetail', { id: t.idField, geometry: t.geometry })}</small>
      </div>
    )
  }

  const loadTables = React.useCallback((ws: Workspace, catalog: string) => fetchCatalog(ws.gatewayUrl, [catalog]), [])

  return (
    <div className='widget-databricks-data jimu-widget' css={style}>
      {mapId && <JimuMapViewComponent useMapWidgetId={mapId} onActiveViewChange={setJmv} />}
      <div className='dbx-header'>
        <DatabricksMark />
        <span className='dbx-title'>{nls('_widgetLabel')}</span>
      </div>

      {!workspaces.length && <Alert className='dbx-alert' type='warning' withIcon text={nls('noGateway')} />}
      {!mapId && <Alert className='dbx-alert' type='warning' withIcon text={nls('chooseMap')} />}
      {notice && mapId && <Alert className='dbx-alert' type='info' withIcon text={notice} />}

      <div className='dbx-workspaces'>
        {workspaces.map(ws => userOf(ws)
          ? <p key={ws.id} className='dbx-hint'>{multi ? nls('signedInTo', { workspace: ws.label, user: userOf(ws) }) : nls('signedInAs', { user: userOf(ws) })}</p>
          : (
            <div key={ws.id} className='dbx-signin'>
              {savedFor(ws) > 0 && <p className='dbx-hint'>{nls('savedLayersWaitingIn', { n: String(savedFor(ws)), workspace: ws.label })}</p>}
              {signInNotice(ws.gatewayUrl) === 'expired' && <p className='dbx-hint'>{nls('signInExpired')}</p>}
              <Button type='primary' size='sm' onClick={() => startSignIn(ws.gatewayUrl)}>
                {multi ? nls('signInTo', { workspace: ws.label }) : nls('signInDatabricks')}
              </Button>
              {blocked[ws.gatewayUrl] && <p className='dbx-hint dbx-error' role='alert'>{nls('popupBlocked')}</p>}
            </div>
            ))}
      </div>

      {hiddenFailures.length > 0 && (
        <Alert className='dbx-alert' type='error' withIcon closable={false}
          text={nls('layersFailed', { tables: hiddenFailures.map(a => a.table.split('.').pop()).join(', ') })} />
      )}

      {allowBrowse && signedIn.length > 0 && !browsable.length && <p className='dbx-hint'>{nls('noCatalogs')}</p>}
      {allowBrowse && browsable.length > 0 && (
        <React.Fragment>
          <TextInput size='sm' className='dbx-filter' placeholder={nls('filterTables')} aria-label={nls('filterTables')}
            value={filter} onChange={e => setFilter(e.target.value)} />
          <TableTree
            workspaces={browsable}
            catalogsFor={ws => ws.catalogs}
            loadTables={loadTables}
            renderTable={renderTable}
            onTableClick={(ws, t) => addTable(ws, t)}
            filter={filter}
            autoExpandSingle
            messages={{
              loading: nls('loadingCatalog'),
              failed: error => nls('catalogFailed', { error }),
              empty: nls('noTablesInCatalog'),
              tablesIn: n => nls('tableCount', { n: String(n) })
            }}
          />
        </React.Fragment>
      )}
    </div>
  )
}

Widget.versionManager = versionManager

export default Widget

const style = css`
  padding: 10px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  background-color: var(--sys-color-surface-paper);
  color: var(--sys-color-surface-paper-text);

  p { margin: 0 0 6px; }
  .dbx-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .dbx-title { font-size: 0.9375rem; font-weight: 600; }
  .dbx-hint { color: var(--sys-color-surface-paper-hint); }
  .dbx-hint.dbx-error { color: var(--sys-color-error-main); }
  .dbx-alert { margin-bottom: 8px; width: 100%; }
  .dbx-workspaces { margin-bottom: 6px; }
  .dbx-signin { margin-bottom: 8px; }
  .dbx-filter { margin: 6px 0; }

  .dbx-table { flex: 1; min-width: 0; padding: 2px 0; }
  .dbx-table-added { background-color: var(--sys-color-action-selected); }
  .dbx-table-name { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .dbx-table-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dbx-table-status { display: inline-flex; align-items: center; gap: 4px; flex: none; }
  .dbx-remove { padding: 0 4px; min-width: 0; line-height: 1; }

  .dbx-state { white-space: nowrap; }
  .dbx-state-adding, .dbx-state-drawing { color: var(--sys-color-warning-dark); }
  .dbx-state-ready { color: var(--sys-color-success-main); }
  .dbx-state-failed { color: var(--sys-color-error-main); }
`
