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
import type { IMConfig, CatalogTable } from '../config'
import defaultMessages from './translations/default'

// Shared by every instance of the widget in the app
const tokens: { [gateway: string]: { token: string, user: string } } = {}
const interceptorFor = new Set<string>()

function ensureInterceptor (gateway: string): void {
  if (interceptorFor.has(gateway)) return
  interceptorFor.add(gateway)
  esriConfig.request.interceptors.push({
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

interface Added { table: string, layer: __esri.FeatureLayer, info: string }

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
    const layer = new FeatureLayer({
      url: `${gateway}/databricks/rest/services/${t.table}/FeatureServer/0`,
      title: t.name,
      outFields: ['*'],
      popupTemplate: { title: t.name, content: [{ type: 'fields' }] } as any
    })
    jmv.view.map.add(layer)
    const entry: Added = { table: t.table, layer, info: 'loading…' }
    setAdded(a => [...a, entry])
    const t0 = performance.now()
    try {
      await layer.load()
      layer.renderer = rendererFor(layer.geometryType, added.length) as any
      await jmv.view.whenLayerView(layer)
      if (layer.fullExtent) await jmv.view.goTo(layer.fullExtent.expand(1.2)).catch(() => {})
      entry.info = `${layer.geometryType}, ${layer.fields.length} fields, ${Math.round(performance.now() - t0)} ms`
    } catch (err) {
      entry.info = `failed: ${err.message}`
    }
    setAdded(a => [...a])
  }

  const remove = (entry: Added) => {
    jmv?.view.map.remove(entry.layer)
    setAdded(a => a.filter(x => x !== entry))
  }

  const mapId = props.useMapWidgetIds?.[0]
  const shown = tables.filter(t => t.table.toLowerCase().includes(filter.toLowerCase())).slice(0, 200)

  return (
    <div className='widget-databricks-data jimu-widget' style={{ padding: 10, overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      {mapId && <JimuMapViewComponent useMapWidgetId={mapId} onActiveViewChange={setJmv} />}
      {!gateway && <p>{nls('noGateway')}</p>}
      {!mapId && <p>{nls('chooseMap')}</p>}
      {gateway && !user && <Button type='primary' onClick={signIn}>{nls('signIn')}</Button>}
      {user && <div style={{ marginBottom: 6 }}>{nls('signedInAs', { user })}</div>}
      {status && <div style={{ color: '#556', marginBottom: 6 }}>{status}</div>}
      {tables.length > 0 && (
        <TextInput size='sm' placeholder={nls('filterTables')} value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
      )}
      {shown.map(t => (
        <div key={t.table} role='button' tabIndex={0} onClick={() => addTable(t)} onKeyDown={e => e.key === 'Enter' && addTable(t)}
          style={{ padding: '4px 6px', cursor: 'pointer', borderBottom: '1px solid #eee' }}>
          <div>{t.schema}.<b>{t.name}</b></div>
          <small style={{ color: '#667' }}>id {t.idField} · {t.geometry}</small>
        </div>
      ))}
      {added.length > 0 && <h6 style={{ marginTop: 12 }}>{nls('onTheMap')}</h6>}
      {added.map(a => (
        <div key={a.table} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '2px 0' }}>
          <span><b>{a.table.split('.').pop()}</b> <small>{a.info}</small></span>
          <Button size='sm' type='tertiary' onClick={() => remove(a)}>{nls('remove')}</Button>
        </div>
      ))}
    </div>
  )
}
