/*
  Databricks Data — runtime

  1. Sign in: opens <gateway>/auth/handoff in a popup. The Databricks login happens there
     (first-party), and the page posts the user's token back to this origin.
  2. A request interceptor adds that token to every SDK request to the gateway.
  3. Picking a table adds FeatureLayer(<gateway>/databricks/rest/services/<table>/FeatureServer/0)
     to the selected map, so paging, extent and filtering are the SDK's normal FeatureServer path.
*/
import { React } from 'jimu-core'
import type { AllWidgetProps } from 'jimu-core'
import { JimuMapViewComponent } from 'jimu-arcgis'
import type { JimuMapView } from 'jimu-arcgis'
import { Button, TextInput } from 'jimu-ui'
import esriConfig from 'esri/config'
import FeatureLayer from 'esri/layers/FeatureLayer'
import * as reactiveUtils from 'esri/core/reactiveUtils'
import type { IMConfig, CatalogTable } from '../config'
import defaultMessages from './translations/default'

// Shared by every instance of the widget in the app
const tokens: { [gateway: string]: { token: string, user: string } } = {}
const interceptorFor = new Set<string>()

function ensureInterceptor (gateway: string): void {
  if (interceptorFor.has(gateway)) return
  interceptorFor.add(gateway)
  // Only the first matching interceptor runs, and Experience Builder registers a catch-all one at startup,
  // so ours has to go first or gateway requests go out without the token (and fall back to the Portal proxy)
  esriConfig.request.interceptors.unshift({
    urls: gateway,
    before: (params: any) => {
      const t = tokens[gateway]
      if (!t) return
      params.requestOptions.headers = { ...(params.requestOptions.headers || {}), Authorization: `Bearer ${t.token}` }
    }
  })
}

// Distinct color per added layer, symbol by geometry type
const PALETTE = ['#e4572e', '#2e86ab', '#3bb273', '#7768ae', '#f3a712', '#d1495b', '#00798c', '#8d6a9f']
function rendererFor (geometryType, n) {
  const c = PALETTE[n % PALETTE.length]
  const symbol = geometryType === 'polygon'
    ? { type: 'simple-fill', color: c + '55', outline: { color: c, width: 1 } }
    : geometryType === 'polyline'
      ? { type: 'simple-line', color: c, width: 2 }
      : { type: 'simple-marker', color: c + 'cc', size: 6, outline: { color: '#ffffff', width: 0.5 } }
  return { type: 'simple', symbol }
}

type AddState = 'adding' | 'drawing' | 'ready' | 'failed'
interface Added { table: string, layer: __esri.FeatureLayer, state: AddState, info: string }

const STATE_LABEL: { [k in AddState]: string } = { adding: 'Adding…', drawing: 'Drawing…', ready: 'On map', failed: 'Failed' }
const STATE_COLOR: { [k in AddState]: string } = { adding: '#8a6d00', drawing: '#8a6d00', ready: '#00796b', failed: '#b00020' }

// Official Databricks symbol (Brandfolder "Databricks Symbol", databricks-symbol-color.svg)
const DatabricksMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size * 331 / 300} viewBox='0 0 300 331' aria-hidden='true' style={{ flex: 'none' }}>
    <path fill='#FF3621' d='M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z' />
  </svg>
)

export default function Widget (props: AllWidgetProps<IMConfig>) {
  const gateway = (props.config.gatewayUrl || '').replace(/\/$/, '')
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)

  const [jmv, setJmv] = React.useState<JimuMapView>(null)
  const [user, setUser] = React.useState<string>(tokens[gateway]?.user || null)
  const [tables, setTables] = React.useState<CatalogTable[]>([])
  const [filter, setFilter] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [added, setAdded] = React.useState<Added[]>([])
  const addedRef = React.useRef<Added[]>([])
  const colorIndex = React.useRef(0)

  const update = (entry: Added, patch: Partial<Added>) => {
    Object.assign(entry, patch)
    setAdded([...addedRef.current])
  }

  React.useEffect(() => {
    if (gateway) ensureInterceptor(gateway)
  }, [gateway])

  const loadCatalog = React.useCallback(async () => {
    const t = tokens[gateway]
    if (!t) return
    setStatus('Loading catalog…')
    try {
      const r = await fetch(`${gateway}/api/catalog`, { headers: { Authorization: `Bearer ${t.token}` } })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || String(r.status))
      const prefix = (props.config.catalogFilter || '').toLowerCase()
      const list: CatalogTable[] = d.tables.filter((x: CatalogTable) => !prefix || x.table.startsWith(prefix))
      setTables(list)
      setStatus(`${list.length} tables`)
    } catch (err) {
      setStatus(`Catalog failed: ${err.message}`)
    }
  }, [gateway, props.config.catalogFilter])

  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!gateway || e.origin !== new URL(gateway).origin) return
      if (!e.data || e.data.type !== 'databricks-gateway-token') return
      tokens[gateway] = { token: e.data.token, user: e.data.user }
      setUser(e.data.user)
      loadCatalog()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [gateway, loadCatalog])

  React.useEffect(() => {
    if (tokens[gateway]) loadCatalog()
  }, [gateway, loadCatalog])

  const signIn = () => {
    window.open(`${gateway}/auth/handoff?origin=${encodeURIComponent(window.location.origin)}`, 'dbx-signin', 'width=520,height=640')
  }

  const addTable = async (t: CatalogTable) => {
    if (!jmv) return
    // Already on the map: zoom to it instead of adding a duplicate; still loading: ignore the click
    const existing = addedRef.current.find(a => a.table === t.table)
    if (existing) {
      if (existing.state === 'ready' && existing.layer.fullExtent) jmv.view.goTo(existing.layer.fullExtent.expand(1.2)).catch(() => {})
      return
    }
    const layer = new FeatureLayer({
      url: `${gateway}/databricks/rest/services/${t.table}/FeatureServer/0`,
      title: t.name,
      outFields: ['*'],
      popupTemplate: { title: t.name, content: [{ type: 'fields' }] } as any
    })
    const entry: Added = { table: t.table, layer, state: 'adding', info: '' }
    addedRef.current = [entry, ...addedRef.current]
    setAdded(addedRef.current)
    jmv.view.map.add(layer)
    const t0 = performance.now()
    try {
      await layer.load()
      layer.renderer = rendererFor(layer.geometryType, colorIndex.current++) as any
      update(entry, { state: 'drawing', info: `${layer.geometryType}, ${layer.fields.length} fields` })
      const lv = await jmv.view.whenLayerView(layer)
      if (layer.fullExtent) await jmv.view.goTo(layer.fullExtent.expand(1.2)).catch(() => {})
      await reactiveUtils.whenOnce(() => !lv.updating)
      update(entry, { state: 'ready', info: `${layer.geometryType}, ${layer.fields.length} fields, ${((performance.now() - t0) / 1000).toFixed(1)} s` })
    } catch (err) {
      update(entry, { state: 'failed', info: err.message })
    }
  }

  const remove = (entry: Added) => {
    jmv?.view.map.remove(entry.layer)
    addedRef.current = addedRef.current.filter(x => x !== entry)
    setAdded(addedRef.current)
  }

  const mapId = props.useMapWidgetIds?.[0]
  const shown = tables.filter(t => t.table.toLowerCase().includes(filter.toLowerCase())).slice(0, 200)

  const stateOf = (table: string) => added.find(a => a.table === table)?.state

  return (
    <div className='widget-databricks-data jimu-widget' style={{ padding: 10, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {mapId && <JimuMapViewComponent useMapWidgetId={mapId} onActiveViewChange={setJmv} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <DatabricksMark />
        <b style={{ fontSize: 15 }}>{nls('_widgetLabel')}</b>
      </div>
      {!gateway && <p>{nls('noGateway')}</p>}
      {!mapId && <p>{nls('chooseMap')}</p>}
      {gateway && !user && <Button type='primary' onClick={signIn}>{nls('signInDatabricks')}</Button>}
      {user && <div style={{ marginBottom: 6 }}>{nls('signedInAs', { user })}</div>}
      {status && <div style={{ color: '#556', marginBottom: 6 }}>{status}</div>}
      {added.length > 0 && (
        <div style={{ marginBottom: 10, padding: 6, background: '#f6f7f8', borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{nls('onTheMap')}</div>
          {added.map(a => (
            <div key={a.table} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '2px 0' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <b>{a.table.split('.').pop()}</b>{' '}
                <small style={{ color: STATE_COLOR[a.state] }}>{STATE_LABEL[a.state]}</small>{' '}
                <small style={{ color: '#667' }}>{a.info}</small>
              </span>
              <Button size='sm' type='tertiary' onClick={() => remove(a)}>{nls('remove')}</Button>
            </div>
          ))}
        </div>
      )}
      {tables.length > 0 && (
        <TextInput size='sm' placeholder={nls('filterTables')} value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
      )}
      {shown.map(t => {
        const st = stateOf(t.table)
        return (
          <div key={t.table} role='button' tabIndex={0} onClick={() => addTable(t)} onKeyDown={e => e.key === 'Enter' && addTable(t)}
            title={st === 'ready' ? 'On the map: click to zoom to it' : st ? STATE_LABEL[st] : 'Add to map'}
            style={{ padding: '4px 6px', cursor: st && st !== 'ready' ? 'progress' : 'pointer', borderBottom: '1px solid #eee', background: st ? '#f1f8f7' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
              <span>{t.schema}.<b>{t.name}</b></span>
              {st && <small style={{ color: STATE_COLOR[st], whiteSpace: 'nowrap' }}>{STATE_LABEL[st]}</small>}
            </div>
            <small style={{ color: '#667' }}>id {t.idField} · {t.geometry}</small>
          </div>
        )
      })}
    </div>
  )
}
