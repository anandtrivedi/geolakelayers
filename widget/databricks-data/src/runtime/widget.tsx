/** @jsx jsx */
/*
  Databricks Data — runtime

  1. Sign in: opens <gateway>/auth/handoff in a popup. The Databricks login happens there
     (first-party), and the page posts the user's token back to this origin.
  2. A request interceptor adds that token to every SDK request to the gateway.
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
import type { IMConfig, CatalogTable } from '../config'
import { getToken, signIn as openSignIn, listenForToken, fetchCatalog, tableRef } from '../auth'
import { announceLayer } from '../sync'
import { addGatewayLayer, removeGatewayLayer } from './layers'
import type { GatewayLayer } from './layers'
import { versionManager } from '../version-manager'
import defaultMessages from './translations/default'

// Shared by every instance of the widget in the app
const interceptorFor = new Set<string>()

function ensureInterceptor (gateway: string): void {
  if (interceptorFor.has(gateway)) return
  interceptorFor.add(gateway)
  // Only the first matching interceptor runs, and Experience Builder registers a catch-all one at startup,
  // so ours has to go first or gateway requests go out without the token (and fall back to the Portal proxy)
  esriConfig.request.interceptors.unshift({
    urls: gateway,
    before: (params: any) => {
      const t = getToken(gateway)
      if (!t) return
      params.requestOptions.headers = { ...(params.requestOptions.headers || {}), Authorization: `Bearer ${t.token}` }
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
interface Added { table: string, gl: GatewayLayer | null, state: AddState, info: string }

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
  const gateway = (props.config.gatewayUrl || '').replace(/\/$/, '')
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)

  const [jmv, setJmv] = React.useState<JimuMapView>(null)
  const [user, setUser] = React.useState<string>(getToken(gateway)?.user || null)
  const [tables, setTables] = React.useState<CatalogTable[]>([])
  const [filter, setFilter] = React.useState('')
  const [catalogState, setCatalogState] = React.useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [catalogError, setCatalogError] = React.useState('')
  const [added, setAdded] = React.useState<Added[]>([])
  const addedRef = React.useRef<Added[]>([])
  const colorIndex = React.useRef(0)

  const allowBrowse = props.config.allowBrowse !== false
  const savedLayers: string[] = props.config.layers ? props.config.layers.asMutable() : []
  const prevSaved = React.useRef<string[]>([])
  // In the builder, layers the author adds or removes here are saved to the widget's settings
  const inBuilder = !!getAppStore().getState()?.appContext?.isInBuilder

  const isCurrent = (entry: Added) => addedRef.current.includes(entry)
  const update = (entry: Added, patch: Partial<Added>) => {
    if (!isCurrent(entry)) return
    Object.assign(entry, patch)
    setAdded([...addedRef.current])
  }

  React.useEffect(() => {
    if (gateway) ensureInterceptor(gateway)
  }, [gateway])

  const loadCatalog = React.useCallback(async () => {
    if (!getToken(gateway) || !allowBrowse) return
    setCatalogState('loading')
    try {
      setTables(await fetchCatalog(gateway, props.config.catalogFilter))
      setCatalogState('ready')
    } catch (err) {
      setCatalogError(err.message)
      setCatalogState('failed')
    }
  }, [gateway, props.config.catalogFilter, allowBrowse])

  React.useEffect(() => {
    if (!gateway) return
    const off = listenForToken(gateway, t => { setUser(t.user); loadCatalog() })
    if (getToken(gateway)) loadCatalog()
    return off
  }, [gateway, loadCatalog])

  const signIn = () => openSignIn(gateway)

  const remove = (entry: Added, fromConfig = false) => {
    addedRef.current = addedRef.current.filter(x => x !== entry)
    setAdded(addedRef.current)
    if (entry.gl) removeGatewayLayer(props.id, jmv, entry.gl)
    if (inBuilder && !fromConfig) announceLayer(props.id, 'remove', entry.table)
  }

  const addTable = async (t: CatalogTable, fromConfig = false) => {
    const token = getToken(gateway)
    if (!jmv || !token) return
    // Already on the map: zoom to it; still loading: ignore the click; failed: try again
    const existing = addedRef.current.find(a => a.table === t.table)
    if (existing) {
      if (existing.state === 'ready' && existing.gl?.layer.fullExtent) {
        jmv.view.goTo(existing.gl.layer.fullExtent.expand(1.2)).catch(() => {})
        return
      }
      if (existing.state !== 'failed') return
      remove(existing, true)
    }
    const title = t.name || t.table.split('.').pop()
    const entry: Added = { table: t.table, gl: null, state: 'adding', info: '' }
    addedRef.current = [entry, ...addedRef.current]
    setAdded(addedRef.current)
    if (inBuilder && !fromConfig) announceLayer(props.id, 'add', t.table)
    const t0 = performance.now()
    try {
      const gl = await addGatewayLayer({ widgetId: props.id, jmv, gateway, token: token.token, table: t.table, title })
      // Removed while it was being created: undo the add
      if (!isCurrent(entry)) { removeGatewayLayer(props.id, jmv, gl); return }
      entry.gl = gl
      const layer = gl.layer
      await layer.load()
      layer.renderer = rendererFor(layer.geometryType, colorIndex.current++) as any
      layer.outFields = ['*']
      layer.popupTemplate = { title, content: [{ type: 'fields' }] } as any
      const summary = nls('layerSummary', { type: layer.geometryType, n: String(layer.fields.length) })
      update(entry, { state: 'drawing', info: summary })
      const lv = await jmv.view.whenLayerView(layer)
      if (isCurrent(entry) && layer.fullExtent) await jmv.view.goTo(layer.fullExtent.expand(1.2)).catch(() => {})
      await reactiveUtils.whenOnce(() => !lv.updating)
      update(entry, { state: 'ready', info: `${summary}, ${((performance.now() - t0) / 1000).toFixed(1)} s` })
    } catch (err) {
      update(entry, { state: 'failed', info: err.message })
    }
  }

  // Keep the map in step with the layers saved in settings: saved layers load once the viewer is
  // signed in; in the builder, unticking a layer in settings also takes it off the map
  React.useEffect(() => {
    if (!jmv || !user) return
    const prev = prevSaved.current
    prevSaved.current = savedLayers
    if (inBuilder) {
      for (const t of prev) {
        const entry = savedLayers.includes(t) ? null : addedRef.current.find(a => a.table === t)
        if (entry) remove(entry, true)
      }
    }
    ;(async () => {
      for (const t of savedLayers) {
        if (!addedRef.current.some(a => a.table === t)) await addTable(tableRef(t), true)
      }
    })()
  }, [jmv, user, savedLayers.join('|')])

  const mapId = props.useMapWidgetIds?.[0]
  const shown = tables.filter(t => t.table.toLowerCase().includes(filter.toLowerCase())).slice(0, 200)
  const stateOf = (table: string) => added.find(a => a.table === table)?.state

  return (
    <div className='widget-databricks-data jimu-widget' css={style}>
      {mapId && <JimuMapViewComponent useMapWidgetId={mapId} onActiveViewChange={setJmv} />}
      <div className='dbx-header'>
        <DatabricksMark />
        <span className='dbx-title'>{nls('_widgetLabel')}</span>
      </div>

      {!gateway && <Alert className='dbx-alert' type='warning' withIcon text={nls('noGateway')} />}
      {!mapId && <Alert className='dbx-alert' type='info' withIcon text={nls('chooseMap')} />}

      {gateway && !user && (
        <div className='dbx-signin'>
          {savedLayers.length > 0 && <p className='dbx-hint'>{nls('savedLayersWaiting', { n: String(savedLayers.length) })}</p>}
          <Button type='primary' onClick={signIn}>{nls('signInDatabricks')}</Button>
        </div>
      )}
      {user && <p className='dbx-hint'>{nls('signedInAs', { user })}</p>}

      <div aria-live='polite'>
        {catalogState === 'loading' && <Loading type={LoadingType.Donut} width={18} height={18} text={nls('loadingCatalog')} />}
        {catalogState === 'ready' && allowBrowse && <p className='dbx-hint'>{nls('tableCount', { n: String(tables.length) })}</p>}
        {catalogState === 'failed' && (
          <Alert className='dbx-alert' type='error' withIcon closable={false} text={nls('catalogFailed', { error: catalogError })} />
        )}
      </div>

      {added.length > 0 && (
        <section className='dbx-onmap' aria-label={nls('onTheMap')}>
          <h6>{nls('onTheMap')}</h6>
          {added.map(a => (
            <div key={a.table} className='dbx-onmap-row'>
              <span className='dbx-onmap-text'>
                <b>{a.table.split('.').pop()}</b>{' '}
                <small className={`dbx-state dbx-state-${a.state}`}>{nls(STATE_MESSAGE[a.state])}</small>{' '}
                <small className='dbx-hint'>{a.info}</small>
              </span>
              <Button size='sm' type='tertiary' aria-label={nls('removeLayer', { table: a.table })} onClick={() => remove(a)}>{nls('remove')}</Button>
            </div>
          ))}
        </section>
      )}

      {allowBrowse && tables.length > 0 && (
        <TextInput size='sm' className='dbx-filter' placeholder={nls('filterTables')} aria-label={nls('filterTables')}
          value={filter} onChange={e => setFilter(e.target.value)} />
      )}
      {allowBrowse && (
        <div role='list' aria-label={nls('tableListLabel')}>
          {shown.map(t => {
            const st = stateOf(t.table)
            const label = st === 'ready' ? nls('zoomToLayer') : st === 'failed' ? nls('retryLayer') : st ? nls(STATE_MESSAGE[st]) : nls('addToMap')
            return (
              <div key={t.table} role='listitem'>
                <div role='button' tabIndex={0} title={label} aria-label={`${t.table}: ${label}`}
                  className={`dbx-table${st ? ' dbx-table-added' : ''}${st && st !== 'ready' && st !== 'failed' ? ' dbx-table-busy' : ''}`}
                  onClick={() => addTable(t)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && addTable(t)}>
                  <div className='dbx-table-name'>
                    <span>{t.schema}.<b>{t.name}</b></span>
                    {st && <small className={`dbx-state dbx-state-${st}`}>{nls(STATE_MESSAGE[st])}</small>}
                  </div>
                  <small className='dbx-hint'>{nls('tableDetail', { id: t.idField, geometry: t.geometry })}</small>
                </div>
              </div>
            )
          })}
        </div>
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
  .dbx-alert { margin-bottom: 8px; width: 100%; }
  .dbx-signin { margin-bottom: 8px; }
  .dbx-filter { margin: 6px 0; }

  .dbx-onmap {
    margin: 4px 0 10px;
    padding: 6px 8px;
    border-radius: 4px;
    background-color: var(--sys-color-surface-background);
    h6 { margin: 0 0 4px; font-size: 0.8125rem; font-weight: 600; }
  }
  .dbx-onmap-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 2px 0; }
  .dbx-onmap-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

  .dbx-table {
    padding: 4px 6px;
    cursor: pointer;
    border-bottom: 1px solid var(--sys-color-divider-secondary);
    &:hover { background-color: var(--sys-color-action-hover); }
    &:focus-visible { outline: 2px solid var(--sys-color-primary-main); outline-offset: -2px; }
  }
  .dbx-table-added { background-color: var(--sys-color-action-selected); }
  .dbx-table-busy { cursor: progress; }
  .dbx-table-name { display: flex; justify-content: space-between; gap: 6px; }

  .dbx-state { white-space: nowrap; }
  .dbx-state-adding, .dbx-state-drawing { color: var(--sys-color-warning-dark); }
  .dbx-state-ready { color: var(--sys-color-success-main); }
  .dbx-state-failed { color: var(--sys-color-error-main); }
`
