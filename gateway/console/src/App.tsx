import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { GatewayInfo, Warehouse } from './api'
import { Architecture } from './components/Architecture'
import { Explorer } from './components/Explorer'
import { OgcServices } from './components/OgcServices'
import { Guide } from './components/Guide'
import { UrlField } from './components/Copy'

type Tab = 'overview' | 'explore' | 'ogc' | 'guide' | 'workspaces'
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', explore: 'Explore data', ogc: 'OGC services', guide: 'Guide', workspaces: 'Admin' }

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
  const [ogcStart, setOgcStart] = useState<string | undefined>()

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
            <div className='brand-name'>LakeGate</div>
            <div className='brand-sub'>Databricks geospatial gateway for ArcGIS and OGC</div>
          </div>
        </div>
        <div className='topbar-meta'>
          {info && <span className='chip'><span className='dot' />{here?.name || info.workspaceHost}</span>}
          {info && <span className='muted small'>{info.user}</span>}
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

      <main className='content'>
        {error && <div className='card error'>Could not reach the gateway: {error}</div>}
        {tab === 'overview' && info && <Overview info={info} warehouses={warehouses} go={setTab} />}
        {tab === 'explore' && info && <Explorer info={info} onGuide={() => setTab('guide')} onAddToOgc={table => { setOgcStart(table); setTab('ogc') }} />}
        {tab === 'ogc' && info && <OgcServices info={info} startWith={ogcStart} onStarted={() => setOgcStart(undefined)} />}
        {tab === 'guide' && <Guide widgetSource={info?.widgetSource} />}
        {tab === 'workspaces' && info && <Workspaces info={info} warehouses={warehouses} />}
      </main>

      <footer className='footer muted small'>
        {info ? `LakeGate ${info.version}` : 'LakeGate'} · Unity Catalog tables as ArcGIS FeatureServer layers and OGC API – Features · Built on Databricks Apps by Anand Trivedi
      </footer>
    </div>
  )
}

function Overview ({ info, warehouses, go }: { info: GatewayInfo, warehouses: Warehouse[], go: (t: Tab) => void }) {
  const wh = (id: string) => warehouses.find(w => w.id === id)
  const def = info.defaultWarehouse ? wh(info.defaultWarehouse) : undefined
  return (
    <>
      <section className='hero card'>
        <h1>Geospatial data from Databricks, on ArcGIS and OGC maps</h1>
        <p>
          LakeGate connects Unity Catalog tables to two mapping worlds: ArcGIS Experience Builder apps, through the
          Databricks Data widget, and anything that speaks OGC API – Features, such as QGIS, GDAL, OpenLayers, Leaflet
          and Python. The data stays in Databricks: maps query it live, and each person sees only what Unity Catalog
          lets them see.
        </p>
      </section>

      <section className='start-grid'>
        <div className='card start'>
          <div className='start-num'>1</div>
          <h3>Preview a table</h3>
          <p className='muted'>See a table on a map the way ArcGIS and OGC clients will get it, check that its geometry is read correctly, and copy its URLs.</p>
          <button className='button' onClick={() => go('explore')}>Explore data</button>
        </div>
        <div className='card start'>
          <div className='start-num'>2</div>
          <h3>Use it in ArcGIS</h3>
          <p className='muted'>Add the Databricks Data widget to an Experience Builder app and give it the gateway URL below. You pick tables inside the widget. Map Viewer and ArcGIS Pro can't add these layers by URL yet.</p>
          <div className='card-actions'>
            <button className='button ghost' onClick={() => go('guide')}>Read the guide</button>
            {info.widgetSource && <a className='button ghost' href={info.widgetSource} target='_blank' rel='noreferrer'>Get the widget</a>}
          </div>
        </div>
        <div className='card start'>
          <div className='start-num'>3</div>
          <h3>Use it in OGC clients</h3>
          <p className='muted'>Group tables into an OGC service and give its URL to QGIS, GDAL, web maps or scripts.</p>
          <button className='button ghost' onClick={() => go('ogc')}>OGC services</button>
        </div>
      </section>

      <section className='card gateway-url'>
        <div>
          <h2>Gateway URL</h2>
          <p className='muted small'>The address of this gateway. The Databricks Data widget in Experience Builder asks for it; OGC service URLs start with it.</p>
        </div>
        <UrlField url={info.gatewayUrl} label='Gateway URL' copyLabel='Copy gateway URL' primary />
      </section>

      <section className='stats'>
        <Stat label='Signed in' value={info.user || 'unknown'} sub={info.runAs === 'user' ? 'queries run with your permissions' : 'queries run as the app'} />
        <Stat label='Workspace' value={info.workspaceHost || '—'} sub='hosts this gateway; workspaces on its metastore can use it' />
        <Stat label='Default warehouse' value={def?.name || info.defaultWarehouse || '—'} sub={def ? `${def.serverless ? 'serverless · ' : ''}${def.size} · ${def.state.toLowerCase()}` : ''} />
      </section>



      <section className='card'>
        <h2>How it fits</h2>
        <Architecture />
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

function Workspaces ({ info, warehouses }: { info: GatewayInfo, warehouses: Warehouse[] }) {
  const wh = (id: string) => warehouses.find(w => w.id === id)
  return (
    <>
      <Health info={info} warehouses={warehouses} />
      <section className='two-col'>
        <div className='card'>
          <h2>Browser access</h2>
          <p className='muted'>Only these Portal and Experience Builder addresses can call this gateway from a browser:</p>
          <ul className='plain'>
            {info.allowedOrigins.length ? info.allowedOrigins.map(o => <li key={o}><code>{o}</code></li>) : <li className='muted'>none configured</li>}
          </ul>
          <p className='muted small'>Set in the gateway's bundle (<code>allowed_origins</code>).</p>
        </div>
        <div className='card'>
          <h2>Warehouses apps may use</h2>
          <ul className='plain'>
            {info.allowedWarehouses.map(id => <li key={id}>{wh(id)?.name || <code>{id}</code>}{id === info.defaultWarehouse ? <span className='muted small'> (default)</span> : ''}{wh(id)?.realtime ? <span className='chip small rt'>Lakehouse//RT</span> : ''}</li>)}
          </ul>
          <p className='muted small'>Set in the gateway's bundle (<code>allowed_warehouses</code>). Users also need CAN USE on each warehouse.</p>
        </div>
      </section>
      <section className='card'>
        <h2>Workspace directory</h2>
        <p className='muted'>
          One gateway per Unity Catalog metastore is enough: workspaces that share a metastore use this one, as long
          as their catalogs are bound to this gateway's workspace. A workspace on another metastore (another region,
          or GovCloud) runs its own gateway from the same bundle. These are the gateways this one knows about; the
          Databricks Data widget offers the same list when an author adds a workspace.
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
        <p><b>On this gateway's metastore:</b> no new gateway. Bind the workspace's catalogs to this gateway's workspace,
          make sure its people can sign in here and use the warehouse, and add its Experience Builder address to
          <code>allowed_origins</code>.</p>
        <p><b>On another metastore</b> (another region, or GovCloud):</p>
        <ol className='steps'>
          <li>Add a target to <code>gateway/databricks.yml</code> with the workspace host, a SQL warehouse and the allowed Portal origins.</li>
          <li>Deploy it: <code>databricks bundle deploy -t &lt;target&gt;</code> and <code>databricks bundle run gateway -t &lt;target&gt;</code>.</li>
          <li>Add the new gateway to <code>directory</code> in every target so it shows up here and in the widget.</li>
          <li>Grant everyone SELECT on its settings tables; the Health card above shows if that's missing.</li>
        </ol>
      </section>
    </>
  )
}

// What a first-time admin needs to know is working: who queries run as, the warehouse, the settings tables,
// the settings in effect, and whether an Experience Builder address may call this gateway
function Health ({ info, warehouses }: { info: GatewayInfo, warehouses: Warehouse[] }) {
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)
  const [checkError, setCheckError] = useState('')
  const [origin, setOrigin] = useState('')
  useEffect(() => { api.health().then(setChecks).catch(e => setCheckError(e.message)) }, [])
  const def = warehouses.find(w => w.id === info.defaultWarehouse)
  const tested = useMemo(() => {
    const v = origin.trim()
    if (!v) return null
    try {
      const o = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).origin
      return { origin: o, ok: info.allowedOrigins.includes(o) }
    } catch (_) { return { origin: v, ok: false, invalid: true } }
  }, [origin, info.allowedOrigins])
  const row = (ok: boolean | null, label: string, detail: React.ReactNode) => (
    <li className='health-row'>
      <span className={`health-dot ${ok === null ? 'wait' : ok ? 'ok' : 'bad'}`} aria-label={ok === null ? 'checking' : ok ? 'ok' : 'problem'} />
      <span><b>{label}</b> <span className='muted'>{detail}</span></span>
    </li>
  )
  return (
    <section className='two-col'>
      <div className='card'>
        <h2>Health</h2>
        <ul className='plain health'>
          {row(info.runAs === 'user', 'Queries run as you', info.runAs === 'user' ? 'Unity Catalog grants decide what each person sees.' : 'User authorization is off, so queries run as the app.')}
          {row(def ? true : null, 'Default warehouse', def ? `${def.name}: ${def.state.toLowerCase()}${def.state !== 'RUNNING' && def.serverless ? ' (starts on the first query)' : ''}` : (info.defaultWarehouse || 'none bound'))}
          {checks?.map(c => row(c.ok, c.name, c.ok ? <code>{c.table}</code> : <>can't read <code>{c.table}</code>. Everyone needs SELECT on it (and USE SCHEMA, USE CATALOG). {c.detail}</>))}
          {!checks && !checkError && row(null, 'Settings tables', 'checking…')}
          {checkError && row(false, 'Settings tables', checkError)}
        </ul>
        <p className='muted small'>Checked with your permissions. Someone with fewer grants can run into problems you don't.</p>
      </div>
      <div className='card'>
        <h2>Settings in effect</h2>
        <dl className='settings-list'>
          <dt>Editing</dt><dd>{info.editing ? 'on: apps may turn it on; people still need MODIFY' : 'off: layers are read-only'}</dd>
          <dt>Catalogs the widget may list</dt><dd>{info.catalogCap.length ? info.catalogCap.join(', ') : 'any catalog the person can see'}</dd>
          <dt>Never listed</dt><dd>{info.excludeCatalogs.join(', ') || 'none'}</dd>
          <dt>OGC services</dt><dd>{info.ogc.enabled ? <code>{info.ogc.table}</code> : 'off'}</dd>
          <dt>Layer overrides</dt><dd>{info.overrides.enabled ? <code>{info.overrides.table}</code> : 'off'}</dd>
          <dt>Widget link</dt><dd>{info.widgetSource ? <a href={info.widgetSource} target='_blank' rel='noreferrer'>{info.widgetSource.replace(/^https:\/\//, '')}</a> : 'not shown'}</dd>
        </dl>
        <p className='muted small'>Set in the gateway's bundle (<code>gateway/databricks.yml</code>) and applied on deploy.</p>
        <h3>Can this Experience Builder call the gateway?</h3>
        <input className='url origin-test' value={origin} onChange={e => setOrigin(e.target.value)} placeholder='Paste its address, e.g. https://portal.example.com/portal/apps/experiencebuilder/' aria-label='Experience Builder address' spellCheck={false} />
        {tested && <p className={`small ${tested.ok ? '' : 'error'}`}>
          {tested.invalid ? 'That isn\'t a web address.' : tested.ok ? `Yes: ${tested.origin} is allowed.` : `No: add ${tested.origin} to allowed_origins in the bundle and redeploy. Until then its sign-in popup closes and nothing loads.`}
        </p>}
      </div>
    </section>
  )
}
