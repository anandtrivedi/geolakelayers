import { useEffect, useState } from 'react'
import { api } from './api'
import type { GatewayInfo, Warehouse } from './api'
import { Architecture } from './components/Architecture'
import { Explorer } from './components/Explorer'
import { OgcServices } from './components/OgcServices'

type Tab = 'overview' | 'explore' | 'ogc' | 'workspaces'
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', explore: 'Explore data', ogc: 'OGC services', workspaces: 'Workspaces' }

const Mark = () => (
  <svg width='26' height='29' viewBox='0 0 300 331' aria-hidden='true'>
    <path fill='#FF3621' d='M283.923 136.449L150.144 213.624L6.88995 131.168L0 134.982V194.844L150.144 281.115L283.923 204.234V235.926L150.144 313.1L6.88995 230.644L0 234.458V244.729L150.144 331L300 244.729V184.867L293.11 181.052L150.144 263.215L16.0766 186.334V154.643L150.144 231.524L300 145.253V86.2713L292.536 81.8697L150.144 163.739L22.9665 90.9663L150.144 17.8998L254.641 78.055L263.828 72.773V65.4371L150.144 0L0 86.2713V95.6613L150.144 181.933L283.923 104.758V136.449Z' />
  </svg>
)

export function App () {
  const [tab, setTab] = useState<Tab>(() => { const h = location.hash.slice(1) as Tab; return h in TAB_LABELS ? h : 'overview' })
  const [info, setInfo] = useState<GatewayInfo | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [error, setError] = useState('')

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
            <div className='brand-name'>ArcGateway</div>
            <div className='brand-sub'>Databricks for ArcGIS</div>
          </div>
        </div>
        {info && (
          <div className='topbar-meta'>
            <span className='chip'><span className='dot' />{here?.name || info.workspaceHost}</span>
            <span className='muted small'>{info.user}</span>
          </div>
        )}
      </header>

      <nav className='tabs' role='tablist'>
        {(Object.keys(TAB_LABELS) as Tab[]).map(t => (
          <button key={t} role='tab' aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      <main className='content'>
        {error && <div className='card error'>Could not reach the gateway: {error}</div>}
        {tab === 'overview' && info && <Overview info={info} warehouses={warehouses} />}
        {tab === 'explore' && <Explorer />}
        {tab === 'ogc' && info && <OgcServices info={info} />}
        {tab === 'workspaces' && info && <Workspaces info={info} />}
      </main>

      <footer className='footer muted small'>
        {info ? `${info.name} ${info.version}` : 'ArcGateway'} · Unity Catalog tables as ArcGIS FeatureServer layers and OGC API – Features · Powered by Databricks
      </footer>
    </div>
  )
}

function Overview ({ info, warehouses }: { info: GatewayInfo, warehouses: Warehouse[] }) {
  const wh = (id: string) => warehouses.find(w => w.id === id)
  const def = info.defaultWarehouse ? wh(info.defaultWarehouse) : undefined
  return (
    <>
      <section className='hero card'>
        <h1>Unity Catalog tables, live on ArcGIS maps</h1>
        <p>
          ArcGateway serves any Unity Catalog table with geometry as an ArcGIS FeatureServer layer. Every
          query runs on a Databricks SQL warehouse as the person viewing the map, so Unity Catalog decides
          what they see. Nothing is copied into ArcGIS.
        </p>
      </section>

      <section className='stats'>
        <Stat label='Signed in' value={info.user || 'unknown'} sub={info.runAs === 'user' ? 'queries run with your permissions' : 'queries run as the app'} />
        <Stat label='Workspace' value={info.workspaceHost || '—'} sub='this gateway serves this workspace only' />
        <Stat label='Default warehouse' value={def?.name || info.defaultWarehouse || '—'} sub={def ? `${def.serverless ? 'serverless · ' : ''}${def.size} · ${def.state.toLowerCase()}` : ''} />
        <Stat label='Warehouses apps may use' value={String(info.allowedWarehouses.length)} sub={info.allowedWarehouses.map(id => wh(id)?.name || id).join(', ')} />
      </section>

      <section className='card'>
        <h2>How it fits</h2>
        <Architecture />
      </section>

      <section className='two-col'>
        <div className='card'>
          <h2>Use it in Experience Builder</h2>
          <ol className='steps'>
            <li>Add the <b>Databricks Data</b> widget, ideally in a Widget Controller on the map.</li>
            <li>In its settings, add this workspace with the gateway URL <code>{info.gatewayUrl}</code> and sign in.</li>
            <li>Pick the SQL warehouse, the catalogs viewers can browse and the layers that load when the app opens.</li>
            <li>Add Map Layers and Legend; Databricks layers show up there like any other layer.</li>
          </ol>
        </div>
        <div className='card'>
          <h2>Browser access</h2>
          <p className='muted'>Only these Portal / Experience Builder addresses can call this gateway from a browser:</p>
          <ul className='plain'>
            {info.allowedOrigins.length ? info.allowedOrigins.map(o => <li key={o}><code>{o}</code></li>) : <li className='muted'>none configured</li>}
          </ul>
          <p className='muted small'>Allowed origins and warehouses are set by a Databricks admin in the gateway's bundle (<code>allowed_origins</code>, <code>allowed_warehouses</code>).</p>
        </div>
      </section>
    </>
  )
}

function Stat ({ label, value, sub }: { label: string, value: string, sub?: string }) {
  return (
    <div className='card stat'>
      <div className='stat-label'>{label}</div>
      <div className='stat-value' title={value}>{value}</div>
      {sub && <div className='stat-sub' title={sub}>{sub}</div>}
    </div>
  )
}

function Workspaces ({ info }: { info: GatewayInfo }) {
  return (
    <>
      <section className='card'>
        <h2>Workspace directory</h2>
        <p className='muted'>
          A Databricks sign-in belongs to one workspace, so each workspace runs its own ArcGateway (the same
          code, deployed from one bundle). Workspaces that share a metastore see the same catalogs and can
          share a gateway. The Databricks Data widget offers this list when an author adds a workspace.
        </p>
        <div className='ws-grid'>
          {info.directory.map(d => {
            const current = d.url === info.gatewayUrl
            return (
              <div key={d.url} className={`ws-card${current ? ' current' : ''}`}>
                <div className='ws-name'>{d.name}{current && <span className='chip small'>this gateway</span>}</div>
                <code className='ws-url'>{d.url}</code>
                {!current && <a className='button ghost' href={d.url} target='_blank' rel='noreferrer'>Open</a>}
              </div>
            )
          })}
          {!info.directory.length && <p className='muted'>No other workspaces listed.</p>}
        </div>
      </section>
      <section className='card'>
        <h2>Adding a workspace</h2>
        <ol className='steps'>
          <li>Add a target to <code>gateway/databricks.yml</code> with the workspace host, a SQL warehouse and the allowed Portal origins.</li>
          <li>Deploy it: <code>databricks bundle deploy -t &lt;target&gt;</code> and <code>databricks bundle run gateway -t &lt;target&gt;</code>.</li>
          <li>Add the new gateway to <code>directory</code> in every target so it shows up here and in the widget.</li>
        </ol>
      </section>
    </>
  )
}
