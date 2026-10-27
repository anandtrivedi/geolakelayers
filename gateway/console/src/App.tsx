import { useEffect, useState } from 'react'
import { api } from './api'
import type { GatewayInfo, Warehouse } from './api'
import { Explorer } from './components/Explorer'
import { ArcGIS } from './components/ArcGIS'
import { OgcServices } from './components/OgcServices'
import { Admin } from './components/Admin'
import { Help } from './components/Help'
import { LoadGauge } from './components/LoadGauge'

type Tab = 'map' | 'arcgis' | 'ogc' | 'admin'
const TAB_LABELS: Record<Tab, string> = { map: 'Map', arcgis: 'ArcGIS', ogc: 'OGC / QGIS', admin: 'Admin' }
// Links to the console from before the Map tab (#overview, #explore, #guide, #workspaces) still land somewhere sensible
const OLD_HASHES: Record<string, Tab> = { overview: 'map', explore: 'map', guide: 'map', workspaces: 'admin' }
const tabFromHash = (h: string): Tab => h in TAB_LABELS ? h as Tab : OLD_HASHES[h] || 'map'

// GeoLakeLayers mark: a map pin standing in lake water (same drawing as public/favicon.svg)
const Mark = () => (
  <svg width='30' height='30' viewBox='0 0 32 32' fill='none' aria-hidden='true'>
    <path fillRule='evenodd' clipRule='evenodd' fill='#FF6B4A' d='M16 2.5C10.8 2.5 7 6.4 7 11.3C7 17.2 16 24.5 16 24.5C16 24.5 25 17.2 25 11.3C25 6.4 21.2 2.5 16 2.5ZM16 14.8C17.9 14.8 19.4 13.3 19.4 11.4C19.4 9.5 17.9 8 16 8C14.1 8 12.6 9.5 12.6 11.4C12.6 13.3 14.1 14.8 16 14.8Z' />
    <path stroke='#4FC3E8' strokeWidth='2' strokeLinecap='round' d='M3.5 26.2C5.6 24.8 7.7 24.8 9.8 26.2C11.9 27.6 14 27.6 16.1 26.2C18.2 24.8 20.3 24.8 22.4 26.2C24.5 27.6 26.6 27.6 28.5 26.2' />
    <path stroke='#4FC3E8' strokeWidth='2' strokeLinecap='round' opacity='0.6' d='M6.5 30C8.3 28.8 10.1 28.8 11.9 30C13.7 31.2 15.5 31.2 17.3 30C19.1 28.8 20.9 28.8 22.7 30C24 30.8 25 30.9 25.6 30.6' />
  </svg>
)

export function App () {
  const [tab, setTab] = useState<Tab>(() => tabFromHash(location.hash.slice(1)))
  const [help, setHelp] = useState(() => location.hash === '#guide')
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [error, setError] = useState('')
  const [ogcStart, setOgcStart] = useState<string | undefined>()
  const [mapRequest, setMapRequest] = useState<string | undefined>()

  useEffect(() => {
    api.info().then(setInfo).catch(e => setError(e.message))
    api.warehouses().then(d => setWarehouses(d.warehouses)).catch(() => {})
  }, [])
  useEffect(() => { history.replaceState(null, '', `#${tab}`) }, [tab])

  const here = info?.directory.find(d => d.url === info.gatewayUrl)

  return (
    <div className='app'>
      <header className='topbar'>
        <div className='brand'>
          <Mark />
          <div>
            <div className='brand-name'>GeoLakeLayers</div>
            <div className='brand-sub'>Databricks geospatial gateway for ArcGIS and OGC</div>
          </div>
        </div>
        <div className='topbar-meta'>
          {info && <span className='chip'><span className='dot' />{here?.name || info.workspaceHost}</span>}
          <LoadGauge />
          {info && <span className='muted small'>{info.user}</span>}
          <button className='help-link' onClick={() => setHelp(true)}>Help</button>
          <span className='built-by'>Built on Databricks Apps by Anand Trivedi</span>
        </div>
      </header>

      <nav className='tabs' role='tablist'>
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button key={t} role='tab' aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      <main className={`content${tab === 'map' ? ' wide' : ''}`}>
        {error && <div className='card error'>Could not reach the gateway: {error}</div>}
        {tab === 'map' && info && <Explorer info={info} request={mapRequest} onRequestDone={() => setMapRequest(undefined)} onHelp={() => setHelp(true)} onGo={setTab}
          onAddToOgc={table => { setOgcStart(table); setTab('ogc') }} />}
        {tab === 'arcgis' && info && <ArcGIS info={info} onHelp={() => setHelp(true)} />}
        {tab === 'ogc' && info && <OgcServices info={info} startWith={ogcStart} onStarted={() => setOgcStart(undefined)} onOpenOnMap={table => { setMapRequest(table); setTab('map') }} />}
        {tab === 'admin' && info && <Admin info={info} warehouses={warehouses} />}
      </main>

      <Help open={help} onClose={() => setHelp(false)} widgetSource={info?.widgetSource} />

      <footer className='footer muted small'>
        {info ? `GeoLakeLayers ${info.version}` : 'GeoLakeLayers'} · Unity Catalog tables as ArcGIS FeatureServer layers and OGC API – Features · Built on Databricks Apps by Anand Trivedi
      </footer>
    </div>
  )
}
