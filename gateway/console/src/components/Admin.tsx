import { useEffect, useState } from 'react'
import { api } from '../api'
import type { GatewayInfo, Warehouse } from '../api'
import { OriginCheck } from './OriginCheck'

// What a gateway admin checks: is it working, may this Portal call it, what's set, which other gateways exist
export function Admin ({ info, warehouses }: { info: GatewayInfo, warehouses: Warehouse[] }) {
  const wh = (id: string) => warehouses.find(w => w.id === id)
  return (
    <>
      <section className='two-col'>
        <Health info={info} warehouses={warehouses} />
        <div className='card'>
          <h2>Can this Experience Builder call the gateway?</h2>
          <p className='muted small'>Only these Portal and Experience Builder addresses can call this gateway from a browser. Paste one to check it.</p>
          <OriginCheck allowedOrigins={info.allowedOrigins} />
          <ul className='plain'>
            {info.allowedOrigins.length ? info.allowedOrigins.map(o => <li key={o}><code>{o}</code></li>) : <li className='muted'>none configured</li>}
          </ul>
          <p className='muted small'>Set in the gateway's bundle (<code>allowed_origins</code>).</p>
        </div>
      </section>
      <section className='two-col'>
        <div className='card'>
          <h2>Settings in effect</h2>
          <dl className='settings-list'>
            <dt>Editing</dt><dd>{info.editing ? 'on: apps may turn it on; people still need MODIFY' : 'off: layers are read-only'}</dd>
            <dt>Catalogs the widget may list</dt><dd>{info.catalogCap.length ? info.catalogCap.join(', ') : 'any catalog the person can see'}</dd>
            <dt>Never listed</dt><dd>{info.excludeCatalogs.join(', ') || 'none'}</dd>
            <dt>Open tables</dt><dd>{info.openTables.length ? info.openTables.map(t => <code key={t}>{t} </code>) : 'none'}</dd>
            <dt>OGC services</dt><dd>{info.ogc.enabled ? <code>{info.ogc.table}</code> : 'off'}</dd>
            <dt>Layer overrides</dt><dd>{info.overrides.enabled ? <code>{info.overrides.table}</code> : 'off'}</dd>
            <dt>Widget link</dt><dd>{info.widgetSource ? <a href={info.widgetSource} target='_blank' rel='noreferrer'>{info.widgetSource.replace(/^https:\/\//, '')}</a> : 'not shown'}</dd>
            <dt>Custom Data Feed link</dt><dd>{info.cdfSource ? <a href={info.cdfSource} target='_blank' rel='noreferrer'>{info.cdfSource.replace(/^https:\/\//, '')}</a> : 'not shown'}</dd>
          </dl>
          <p className='muted small'>Set in the gateway's bundle (<code>gateway/databricks.yml</code>) and applied on deploy.</p>
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
      <details className='card fold'>
        <summary><b>Adding a workspace</b></summary>
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
      </details>
    </>
  )
}

// What a first-time admin needs to know is working: who queries run as, the warehouse, the settings tables
function Health ({ info, warehouses }: { info: GatewayInfo, warehouses: Warehouse[] }) {
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof api.health>> | null>(null)
  const [checkError, setCheckError] = useState('')
  useEffect(() => { api.health().then(setChecks).catch(e => setCheckError(e.message)) }, [])
  const def = warehouses.find(w => w.id === info.defaultWarehouse)
  const row = (ok: boolean | null, label: string, detail: React.ReactNode) => (
    <li className='health-row'>
      <span className={`health-dot ${ok === null ? 'wait' : ok ? 'ok' : 'bad'}`} aria-label={ok === null ? 'checking' : ok ? 'ok' : 'problem'} />
      <span><b>{label}</b> <span className='muted'>{detail}</span></span>
    </li>
  )
  return (
    <div className='card'>
      <h2>Health</h2>
      <ul className='plain health'>
        {row(info.runAs === 'user', 'Queries run as you', info.runAs === 'user' ? 'Unity Catalog grants decide what each person sees.' : 'User authorization is off, so queries run as the app.')}
        {row(def ? true : null, 'Default warehouse', def ? `${def.name}: ${def.size}, ${def.serverless ? 'serverless, ' : ''}${def.state.toLowerCase()}${def.state !== 'RUNNING' && def.serverless ? ' (starts on the first query)' : ''}` : (info.defaultWarehouse || 'none bound'))}
        {checks?.map(c => row(c.ok, c.name, c.ok ? <code>{c.table}</code> : <>can't read <code>{c.table}</code>. Everyone needs SELECT on it (and USE SCHEMA, USE CATALOG). {c.detail}</>))}
        {!checks && !checkError && row(null, 'Settings tables', 'checking…')}
        {checkError && row(false, 'Settings tables', checkError)}
      </ul>
      <p className='muted small'>Checked with your permissions. Someone with fewer grants can run into problems you don't.</p>
    </div>
  )
}
