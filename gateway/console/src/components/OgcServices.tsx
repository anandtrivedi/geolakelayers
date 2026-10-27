import { useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { CatalogTable, GatewayInfo, OgcCollection, OgcColumns, OgcService, Warehouse } from '../api'
import { CatalogTree } from './CatalogTree'
import { Copy, CopyToken } from './Copy'
import { AccessHint, WriteError } from './Access'

// OGC services: named sets of tables served as OGC API – Features (/ogc/<name>), kept in a Unity Catalog table
// Engine label for a service: its warehouse, or the gateway's bound one
function engineOf (s: OgcService, warehouses: Warehouse[], info: GatewayInfo) {
  const w = warehouses.find(x => x.id === (s.warehouse || info.defaultWarehouse))
  return { name: w?.name || (s.warehouse ? s.warehouse : 'bound warehouse'), realtime: !!w?.realtime }
}

const LAST_OPEN = 'geolakelayers.ogc.lastOpen'

// startWith: a table from the Map tab to open a new service with; onOpenOnMap shows a collection's table on the Map tab
export function OgcServices ({ info, startWith, onStarted, onOpenOnMap }: { info: GatewayInfo, startWith?: string, onStarted?: () => void, onOpenOnMap: (table: string) => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  useEffect(() => { api.warehouses().then(d => setWarehouses(d.warehouses)).catch(() => {}) }, [])
  const [services, setServices] = useState<OgcService[] | null>(null)
  const [error, setError] = useState('')
  const [needsSetup, setNeedsSetup] = useState(false)
  const [draft, setDraft] = useState<{ service: OgcService, isNew: boolean } | null>(null)
  // The open service shows its endpoints and a map; start with the last one opened here, else the first
  const [open, setOpenState] = useState<string | null>(null)
  const setOpen = (name: string | null) => { setOpenState(name); if (name) try { localStorage.setItem(LAST_OPEN, name) } catch (_) {} }

  useEffect(() => {
    if (!startWith) return
    const [, , name] = startWith.split('.')
    api.warehouses().then(d => d.warehouses, () => [] as Warehouse[]).then(ws => {
      setDraft({ isNew: true, service: { name: '', title: '', description: '', collections: [{ id: name, table: startWith, title: name, timeField: null }], warehouse: ws.find(w => w.realtime)?.id || '' } })
      onStarted?.()
    })
  }, [startWith])

  const reload = () => {
    setError('')
    api.ogcServices()
      .then(s => {
        setServices(s)
        setNeedsSetup(false)
        setOpenState(cur => {
          if (cur && s.some(x => x.name === cur)) return cur
          let last: string | null = null
          try { last = localStorage.getItem(LAST_OPEN) } catch (_) {}
          return (s.find(x => x.name === last) || s[0])?.name || null
        })
      })
      .catch((e: ApiError) => { setServices([]); if (e.setup) setNeedsSetup(true); else setError(e.message) })
  }
  useEffect(() => { if (info.ogc.enabled) reload() }, [info.ogc.enabled])

  if (!info.ogc.enabled) {
    return (
      <section className='card'>
        <h2>OGC services</h2>
        <p className='muted'>
          OGC API – Features is off on this gateway. A Databricks admin turns it on by setting the bundle variable
          <code>ogc_services_table</code> to a Unity Catalog table name (for example <code>main.geolakelayers.ogc_services</code>) and redeploying.
        </p>
      </section>
    )
  }

  if (draft) {
    return <Editor info={info} warehouses={warehouses} draft={draft.service} isNew={draft.isNew} existing={services || []}
      onCancel={() => setDraft(null)}
      onSaved={s => { setDraft(null); setOpen(s.name); reload() }} />
  }

  const shown = services?.find(s => s.name === open)
  const newService = () => setDraft({ isNew: true, service: { name: '', title: '', description: '', collections: [], warehouse: warehouses.find(w => w.realtime)?.id || '' } })

  return (
    <div className='ogc-layout'>
      <section className='card ogc-list'>
        <div className='detail-head'>
          <h2>OGC services</h2>
          {!needsSetup && <button className='button' onClick={newService}>New service</button>}
        </div>
        <p className='muted small'>
          A service is a set of tables published as OGC API – Features: GeoJSON over HTTPS for QGIS, GDAL, OpenLayers,
          Leaflet, MapLibre and ArcGIS. Every request runs as the caller. Definitions are kept in <code>{info.ogc.table}</code>.
        </p>
        {needsSetup && <Setup table={info.ogc.table || ''} onDone={reload} />}
        {!needsSetup && services && <AccessHint action='MODIFY' name={info.ogc.table} doing='Creating, changing or deleting a service' />}
        {error && <p className='error'>Could not read services: {error}</p>}
        {!services && !error && <p className='muted'>Loading services…</p>}
        {services && !services.length && !needsSetup && !error && <p className='muted'>No services yet. Use New service to pick tables.</p>}
        <div className='service-list'>
          {(services || []).map(s => (
            <div key={s.name} className={`ws-card${open === s.name ? ' current' : ''}`}>
              <button className='service-pick' onClick={() => setOpen(s.name)} aria-pressed={open === s.name}>
                <span className='ws-name'>{s.title}<span className='chip small'>{s.collections.length} {s.collections.length === 1 ? 'table' : 'tables'}</span>{engineOf(s, warehouses, info).realtime && <span className='chip small rt'>Lakehouse//RT</span>}</span>
                <code className='ws-url'>/ogc/{s.name}</code>
                <span className='muted small'>{s.updatedBy || s.owner}{s.updatedAt ? ` · ${new Date(s.updatedAt).toLocaleString()}` : ''}</span>
              </button>
              <div className='card-actions'>
                <button className='button ghost' onClick={() => setDraft({ isNew: false, service: s })}>Edit</button>
                <Delete name={s.name} onDone={() => { if (open === s.name) setOpen(null); reload() }} />
              </div>
            </div>
          ))}
        </div>
      </section>
      {shown
        ? <Endpoints key={shown.name} info={info} service={shown} engine={engineOf(shown, warehouses, info)} onOpenOnMap={onOpenOnMap} />
        : (
          <section className='card ogc-empty'>
            <h3>Use in QGIS, GDAL and web maps</h3>
            <ol className='use-steps'>
              <li>Pick a service on the left, or make one with New service: tick the tables to publish.</li>
              <li>Give a client the service's landing page URL. In QGIS: Layer › Add WFS / OGC API – Features layer.</li>
              <li>Send a Databricks OAuth token as <code>Authorization: Bearer</code>; copy one from the service's page. It lasts about an hour.</li>
            </ol>
          </section>
          )}
    </div>
  )
}

function Setup ({ table, onDone }: { table: string, onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const create = async (force = false) => {
    setBusy(true); setError(null)
    try { await api.ogcSetup(force); onDone() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return (
    <div className='optimize'>
      <h4>Create the services table</h4>
      <p className='muted'>
        <code>{table}</code> doesn't exist yet. Creating it needs CREATE TABLE on its schema; it's created with your
        permissions. Afterwards, grant SELECT to the people and service principals that read services, and MODIFY to those
        who define them.
      </p>
      <AccessHint action='CREATE_TABLE' name={table.split('.').slice(0, 2).join('.')} doing='Creating it' />
      <button className='button' disabled={busy} onClick={() => create()}>{busy ? 'Creating…' : 'Create table'}</button>
      <WriteError error={error} onRetry={() => create(true)} />
    </div>
  )
}

function Delete ({ name, onDone }: { name: string, onDone: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  if (!confirm) return <button className='button ghost' onClick={() => setConfirm(true)}>Delete</button>
  return (
    <>
      <button className='button danger' onClick={() => api.ogcDelete(name).then(onDone, e => setError(e.message))}>Delete {name}</button>
      <button className='button ghost' onClick={() => setConfirm(false)}>Keep</button>
      {error && <span className='error small'>{error}</span>}
    </>
  )
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)

function collectionIdFor (table: string, picked: OgcCollection[]): string {
  const [, schema, name] = table.split('.')
  const taken = new Set(picked.map(c => c.id))
  if (!taken.has(name)) return name
  if (!taken.has(`${schema}_${name}`)) return `${schema}_${name}`
  let i = 2
  while (taken.has(`${name}_${i}`)) i++
  return `${name}_${i}`
}

function Editor ({ info, warehouses, draft, isNew, existing, onCancel, onSaved }: {
  info: GatewayInfo, warehouses: Warehouse[], draft: OgcService, isNew: boolean, existing: OgcService[], onCancel: () => void, onSaved: (s: OgcService) => void
}) {
  const [s, setS] = useState<OgcService>(draft)
  const [columns, setColumns] = useState<Record<string, OgcColumns | 'failed'>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [nameTouched, setNameTouched] = useState(!isNew)

  const loadColumns = (table: string) => {
    if (columns[table]) return
    api.ogcColumns(table).then(c => setColumns(m => ({ ...m, [table]: c })), () => setColumns(m => ({ ...m, [table]: 'failed' })))
  }
  useEffect(() => { s.collections.forEach(c => loadColumns(c.table)) }, [])

  const picked = (t: CatalogTable) => s.collections.some(c => c.table === t.table)
  const togglePick = (t: CatalogTable) => {
    setS(prev => {
      if (prev.collections.some(c => c.table === t.table)) return { ...prev, collections: prev.collections.filter(c => c.table !== t.table) }
      return { ...prev, collections: [...prev.collections, { id: collectionIdFor(t.table, prev.collections), table: t.table, title: t.name, timeField: null }] }
    })
    loadColumns(t.table)
  }
  const setCollection = (table: string, patch: Partial<OgcCollection>) =>
    setS(prev => ({ ...prev, collections: prev.collections.map(c => c.table === table ? { ...c, ...patch } : c) }))
  const move = (i: number, d: number) => setS(prev => {
    const list = [...prev.collections]
    const j = i + d
    if (j < 0 || j >= list.length) return prev
    ;[list[i], list[j]] = [list[j], list[i]]
    return { ...prev, collections: list }
  })

  const nameTaken = isNew && existing.some(e => e.name === s.name)
  const nameOk = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(s.name)
  const ids = s.collections.map(c => c.id)
  const idsOk = ids.every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)) && new Set(ids).size === ids.length
  const canSave = nameOk && !nameTaken && idsOk && s.collections.length > 0 && !saving

  const save = async () => {
    setSaving(true); setError('')
    try { onSaved(await api.ogcSave({ ...s, title: s.title || s.name }, isNew)) } catch (e: any) { setError(e.message) } finally { setSaving(false) }
  }

  return (
    <section className='card'>
      <button className='link small back' onClick={onCancel}>← OGC services</button>
      <div className='detail-head'>
        <div>
          <div className='muted small'>{isNew ? 'New OGC service' : 'Edit OGC service'}</div>
          <h3>{s.title || s.name || 'Untitled service'}</h3>
        </div>
        <div className='card-actions'>
          <button className='button ghost' onClick={onCancel}>Cancel</button>
          <button className='button' disabled={!canSave} onClick={save}>{saving ? 'Saving…' : 'Save service'}</button>
        </div>
      </div>
      <div className='ogc-fields'>
        <label>Title
          <input value={s.title} placeholder='Harbor operations' onChange={e => {
            const title = e.target.value
            setS(prev => ({ ...prev, title, name: isNew && !nameTouched ? slug(title) : prev.name }))
          }} />
        </label>
        <label>Name (in the URL)
          <input value={s.name} disabled={!isNew} placeholder='harbor-ops' onChange={e => { setNameTouched(true); setS(prev => ({ ...prev, name: e.target.value })) }} />
          <span className={`small ${nameOk && !nameTaken ? 'muted' : 'error'}`}>
            {nameTaken ? 'A service with this name exists' : nameOk ? `${info.gatewayUrl}/ogc/${s.name}` : 'Lowercase letters, digits, - and _'}
          </span>
        </label>
        <label>Engine
          <select value={s.warehouse || ''} onChange={e => setS(prev => ({ ...prev, warehouse: e.target.value }))}>
            <option value=''>{`Bound warehouse${warehouses.find(w => w.id === info.defaultWarehouse) ? ` (${warehouses.find(w => w.id === info.defaultWarehouse)!.name})` : ''}`}</option>
            {warehouses.filter(w => w.id !== info.defaultWarehouse).map(w => <option key={w.id} value={w.id}>{w.realtime ? `${w.name} (Lakehouse//RT, low-latency reads)` : `${w.name} (${w.size})`}</option>)}
          </select>
          <span className='small muted'>
            {warehouses.find(w => w.id === s.warehouse)?.realtime
              ? 'Reads run on Lakehouse//RT. Tables with row filters or column masks are read on the bound warehouse automatically.'
              : 'Where this service\u2019s queries run. Lakehouse//RT warehouses answer map-sized reads in about a tenth of the time.'}
          </span>
        </label>
        <label>Description
          <input value={s.description} placeholder='What these layers are for' onChange={e => setS(prev => ({ ...prev, description: e.target.value }))} />
        </label>
      </div>
      <div className='ogc-editor'>
        <div className='explorer-tree card'>
          <div className='muted small picker-hint'>Tick the tables to publish</div>
          <CatalogTree isActive={picked} onPick={togglePick}
            leafStart={t => <input type='checkbox' tabIndex={-1} readOnly checked={picked(t)} aria-hidden />} />
        </div>
        <div>
          <h4 className='picked-head'>Collections ({s.collections.length})</h4>
          {!s.collections.length && <p className='muted'>Nothing picked yet. Each table becomes one collection.</p>}
          <div className='picked-list'>
            {s.collections.map((c, i) => {
              const cols = columns[c.table]
              const idOk = /^[A-Za-z0-9_-]{1,64}$/.test(c.id) && ids.indexOf(c.id) === i
              return (
                <div key={c.table} className='picked'>
                  <div className='picked-top'>
                    <code className='picked-table' title={c.table}>{c.table}</code>
                    <span className='muted small'>{cols && cols !== 'failed' ? `${cols.count.toLocaleString()} features` : cols === 'failed' ? 'not readable' : '…'}</span>
                    <button className='icon-button' aria-label='Move up' disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                    <button className='icon-button' aria-label='Move down' disabled={i === s.collections.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button className='icon-button' aria-label={`Remove ${c.table}`} onClick={() => setS(prev => ({ ...prev, collections: prev.collections.filter(x => x.table !== c.table) }))}>×</button>
                  </div>
                  <div className='picked-fields'>
                    <label>Collection id
                      <input className={idOk ? '' : 'invalid'} value={c.id} onChange={e => setCollection(c.table, { id: e.target.value })} />
                    </label>
                    <label>Title
                      <input value={c.title} onChange={e => setCollection(c.table, { title: e.target.value })} />
                    </label>
                    <label>Time field
                      <select value={c.timeField || ''} onChange={e => setCollection(c.table, { timeField: e.target.value || null })}>
                        <option value=''>None</option>
                        {cols && cols !== 'failed' && cols.timeFields.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
          {error && <p className='error'>{error}</p>}
        </div>
      </div>
    </section>
  )
}

function Endpoints ({ info, service, engine, onOpenOnMap }: { info: GatewayInfo, service: OgcService, engine: { name: string, realtime: boolean }, onOpenOnMap: (table: string) => void }) {
  const base = `${info.gatewayUrl}/ogc/${service.name}`
  const first = service.collections[0]
  const host = info.workspaceHost ? `https://${info.workspaceHost}` : '<workspace URL>'
  const snippet = [
    '# A Databricks OAuth token for you (or a service principal); personal access tokens are not accepted',
    `TOKEN=$(databricks auth token --host ${host} | jq -r .access_token)`,
    '',
    `curl -H "Authorization: Bearer $TOKEN" "${base}/collections/${first?.id}/items?limit=10"`,
    '',
    '# GDAL / OGR: list the layers, then copy one to a GeoPackage',
    `GDAL_HTTP_HEADERS="Authorization: Bearer $TOKEN" ogrinfo -ro -so "OAPIF:${base}"`,
    `GDAL_HTTP_HEADERS="Authorization: Bearer $TOKEN" ogr2ogr -f GPKG ${first?.id || 'out'}.gpkg "OAPIF:${base}" ${first?.id || ''}`
  ].join('\n')
  const rows: [string, string][] = [
    ['Landing page', base],
    ['Conformance', `${base}/conformance`],
    ['OpenAPI', `${base}/api`],
    ['Collections', `${base}/collections`]
  ]
  return (
    <section className='card'>
      <div className='detail-head'>
        <div>
          <div className='muted small'>OGC API – Features</div>
          <h3>{service.title}</h3>
        </div>
        <a className='button ghost' href={base} target='_blank' rel='noreferrer'>Open landing page</a>
      </div>
      {service.description && <p className='muted'>{service.description}</p>}
      <p className='small muted'>Engine: <b>{engine.name}</b>{engine.realtime ? ' (Lakehouse//RT)' : ''}. Change it with Edit.</p>
      <div className='next-bar'>
        <span>
          Give a client the <b>landing page</b> URL; it finds the collections from there. Every request needs{' '}
          <code>Authorization: Bearer &lt;Databricks OAuth token&gt;</code>. In QGIS, add a WFS / OGC API – Features
          connection with an API Header authentication config. A token lasts about an hour; copy a new one when it expires.
        </span>
        <CopyToken />
      </div>
      <div className='endpoint-list'>
        {rows.map(([label, url]) => (
          <div key={label} className='endpoint'>
            <span className='endpoint-label'>{label}</span>
            <input className='url' readOnly value={url} title={url} aria-label={label} spellCheck={false} />
            <Copy text={url} />
          </div>
        ))}
      </div>
      <h4 className='picked-head'>Collections</h4>
      <div className='endpoint-list'>
        {service.collections.map(c => (
          <div key={c.id} className='endpoint'>
            <span className='endpoint-label' title={c.table}>{c.title}{c.timeField && <span className='geom-chip'>time: {c.timeField}</span>}</span>
            <input className='url' readOnly value={`${base}/collections/${c.id}/items`} title={`${base}/collections/${c.id}/items`} aria-label={`${c.title} items URL`} spellCheck={false} />
            <Copy text={`${base}/collections/${c.id}/items`} />
            <button className='button ghost' onClick={() => onOpenOnMap(c.table)}>Open on Map</button>
          </div>
        ))}
      </div>
      <h4 className='picked-head'>From a script or pipeline</h4>
      <div className='snippet-wrap'>
        <pre className='snippet'>{snippet}</pre>
        <Copy text={snippet} />
      </div>
      <p className='muted small'>
        Browser maps on an allowed origin ({info.allowedOrigins.join(', ') || 'none configured'}) sign in the same way as the
        Experience Builder widget and send the token as a Bearer header. Pages are capped per request; follow the <code>next</code> links.
      </p>
    </section>
  )
}
