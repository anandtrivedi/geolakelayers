import { useEffect, useMemo, useState } from 'react'
import { api, layerPath } from '../api'
import type { CatalogTable, GatewayInfo, LayerSpec, OgcService, OptimizeJob, ScanResult } from '../api'
import { CopyToken, UrlField } from './Copy'
import { MapPreview } from './MapPreview'
import { CatalogTree } from './CatalogTree'
import { LayerSettings } from './LayerSettings'
import { AccessHint, WriteError } from './Access'
import { Drawer } from './Drawer'

const LAST_TABLE = 'geolakelayers.explore.lastTable'

const tableOf = (name: string): CatalogTable => {
  const [catalog, schema, n] = name.split('.')
  return { table: name, catalog, schema, name: n, idField: '', geometry: '' }
}
const remembered = (): CatalogTable | null => {
  try { const t = JSON.parse(localStorage.getItem(LAST_TABLE) || 'null'); return t && typeof t.table === 'string' ? t : null } catch (_) { return null }
}

// The landing view: catalog tree | the table on a map | how to use it. Opens the last table picked here, else the
// first open table the person can read, so a first visit starts with a map.
export function Explorer ({ info, request, onRequestDone, onAddToOgc, onHelp, onGo }: {
  info: GatewayInfo
  /** A table another tab asked to show (OGC "Open on Map") */
  request?: string
  onRequestDone?: () => void
  onAddToOgc: (table: string) => void
  onHelp: () => void
  onGo: (tab: 'arcgis' | 'ogc') => void
}) {
  const [services, setServices] = useState<OgcService[]>([])
  useEffect(() => { if (info.ogc.enabled) api.ogcServices().then(setServices).catch(() => {}) }, [info.ogc.enabled])
  const [selected, setSelected] = useState<CatalogTable | null>(null)
  // Set when the table on show is an open table nobody picked
  const [shownOpen, setShownOpen] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const pick = (t: CatalogTable | null) => {
    setSelected(t); setShownOpen(null)
    try { if (t) localStorage.setItem(LAST_TABLE, JSON.stringify(t)) } catch (_) {}
  }

  // First table to show: the remembered one, else an open table; only one whose spec loads (access can change)
  useEffect(() => {
    if (request) { setStarting(false); return }
    let cancelled = false
    const last = remembered()
    const candidates = [...new Set([last?.table, ...info.openTables].filter((t): t is string => !!t))]
    ;(async () => {
      for (const t of candidates) {
        const spec = await api.spec(t).catch(() => null)
        if (cancelled) return
        if (spec) {
          setSelected(last?.table === t ? last : tableOf(t))
          setShownOpen(last?.table === t ? null : t)
          break
        }
      }
      if (!cancelled) setStarting(false)
    })()
    return () => { cancelled = true }
  }, [])
  useEffect(() => { if (request) { pick(tableOf(request)); onRequestDone?.() } }, [request])

  const [reloadKey, setReloadKey] = useState(0)
  const [byName, setByName] = useState('')
  const [scanSchema, setScanSchema] = useState('')
  const [scan, setScan] = useState<{ busy: boolean, result?: ScanResult, error?: string }>({ busy: false })

  const open = () => {
    const name = byName.trim()
    if (/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(name)) pick(tableOf(name))
  }
  const runScan = async () => {
    setScan({ busy: true })
    try {
      const result = await api.scan(scanSchema.trim())
      setScan({ busy: false, result })
      setReloadKey(k => k + 1)
    } catch (e: any) { setScan({ busy: false, error: e.message }) }
  }

  return (
    <>
      <p className='map-intro muted'>
        Live Unity Catalog tables on a map, queried as you. <button className='link' onClick={onHelp}>How it works</button>
      </p>
      <div className='map-layout'>
        <aside className='map-rail card'>
          <CatalogTree isActive={t => selected?.table === t.table} onPick={pick} reloadKey={reloadKey} reveal={shownOpen ? undefined : selected?.table} />
          <details className='find-more'>
            <summary>Can't find your table?</summary>
            <p className='muted small'>
              Listed: tables with a GEOMETRY or GEOGRAPHY column, and tables with an override. Geometry stored as
              text or binary (WKT, WKB, GeoJSON) is found by scanning a schema; tables it finds are added to this list for you.
            </p>
            <div className='inline-form'>
              <input value={scanSchema} onChange={e => setScanSchema(e.target.value)} placeholder='catalog.schema' aria-label='Schema to scan' />
              <button className='button ghost' disabled={scan.busy || !/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(scanSchema.trim())} onClick={runScan}>{scan.busy ? 'Scanning…' : 'Scan schema'}</button>
            </div>
            {scan.error && <p className='error small'>{scan.error}</p>}
            {scan.result && (
              <p className='small'>
                Checked {scan.result.checked} tables{scan.result.skipped ? ` (${scan.result.skipped} more not checked)` : ''}: {scan.result.found.length ? scan.result.found.map(f => f.name).join(', ') : 'no text or binary geometry found'}.
                {scan.result.failed.length > 0 && <span className='muted'> {scan.result.failed.length} could not be read.</span>}
              </p>
            )}
            <div className='inline-form'>
              <input value={byName} onChange={e => setByName(e.target.value)} onKeyDown={e => e.key === 'Enter' && open()} placeholder='catalog.schema.table' aria-label='Open a table by name' />
              <button className='button ghost' onClick={open}>Open table</button>
            </div>
          </details>
        </aside>
        <div className='map-main'>
          {selected
            ? <TableDetail key={selected.table} t={selected} info={info} services={services} shownOpen={shownOpen === selected.table} onAddToOgc={onAddToOgc} onGo={onGo} onChanged={() => setReloadKey(k => k + 1)} />
            : (
              <div className='map-body'>
                <div className='map-frame'><div className='map-overlay'>{starting ? 'Loading…' : 'Pick a table on the left to see it on the map.'}</div></div>
                <UsePanel info={info} services={services} onAddToOgc={onAddToOgc} onGo={onGo} />
              </div>
              )}
        </div>
      </div>
    </>
  )
}

const changeTable = () => document.querySelector<HTMLInputElement>('.map-rail .search')?.focus()

function TableDetail ({ t, info, services, shownOpen, onAddToOgc, onGo, onChanged }: {
  t: CatalogTable, info: GatewayInfo, services: OgcService[], shownOpen: boolean, onAddToOgc: (table: string) => void, onGo: (tab: 'arcgis' | 'ogc') => void, onChanged: () => void
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.specDetail>> | null>(null)
  const [error, setError] = useState('')
  const [count, setCount] = useState<number | null>(null)
  const [version, setVersion] = useState(0)
  const [setup, setSetup] = useState(false)
  const spec = detail ? detail.spec : undefined

  useEffect(() => {
    setError('')
    api.specDetail(t.table).then(d => {
      setDetail(d)
      if (d.spec) api.count(t.table).then(setCount).catch(() => setCount(null))
      else setSetup(true)
    }).catch(e => { setError(e.message); setDetail({ spec: null, columns: [], override: null }) })
  }, [t.table, version])
  const changed = () => { setVersion(v => v + 1); onChanged() }

  return (
    <>
      <div className='map-strip'>
        <div className='strip-name'>
          <span className='muted small'>{t.catalog}.{t.schema}</span>
          <h3>{t.name}</h3>
        </div>
        {spec && (
          <div className='strip-facts'>
            <span className='fact'>{count === null ? '…' : count.toLocaleString()} features</span>
            <span className='fact'>{spec.geometryType.replace('esriGeometry', '')} <span className='muted'>from {spec.geometrySource}</span></span>
            <span className='fact' title={spec.idSource === 'derived' ? 'No integer id column, so an id is computed from each row. The layer is read-only; pick an id column in Table setup to allow editing.' : undefined}>
              id: {spec.idSource === 'derived' ? 'derived (read-only)' : <code>{spec.objectId}</code>}
            </span>
            {spec.bboxColumns && <span className='fact rt'>map-optimized</span>}
          </div>
        )}
        <div className='strip-actions'>
          <button className='button ghost' onClick={changeTable}>Change table</button>
          {detail && <button className='button ghost' onClick={() => setSetup(true)}>Table setup</button>}
          <a className='button ghost' href={`${layerPath(t.table)}?f=pjson`} target='_blank' rel='noreferrer'>Layer JSON</a>
        </div>
      </div>
      {shownOpen && <p className='open-note small'>Showing <code>{t.table}</code>, an open table. Pick any table on the left.</p>}
      <div className='map-body'>
        {spec
          ? <MapPreview key={version} table={t.table} optimized={!!spec.bboxColumns} />
          : (
            <div className='map-frame'>
              <div className='map-overlay'>
                {error || (spec === null
                  ? <>No geometry found in this table: it has no GEOMETRY or GEOGRAPHY column, and none of its text or binary columns hold WKT, WKB or GeoJSON. If its geometry is in two longitude/latitude columns, or in a column that is mostly empty, pick it in <button className='link' onClick={() => setSetup(true)}>Table setup</button>.</>
                  : 'Loading…')}
              </div>
            </div>
            )}
        <UsePanel info={info} t={spec ? t : undefined} services={services} onAddToOgc={onAddToOgc} onGo={onGo} />
      </div>
      {detail && (
        <Drawer open={setup} title={`Table setup: ${t.name}`} onClose={() => setSetup(false)}>
          <p className='muted small'>How the gateway reads <code>{t.table}</code>, and a faster copy for maps. Changes apply to everyone who uses this table through the gateway.</p>
          <LayerSettings key={version} table={t.table} spec={spec || null} columns={detail.columns} override={detail.override} onChanged={changed} />
          {spec && (spec.bboxColumns
            ? <p className='optimized-note'><span className='chip small'>Map-optimized</span> Tile queries skip files outside the map view.</p>
            : <Optimize t={t} spec={spec} count={count} />)}
        </Drawer>
      )}
    </>
  )
}

// Beside the map: the one string each kind of client needs for this table, and where the full steps are
function UsePanel ({ info, t, services, onAddToOgc, onGo }: {
  info: GatewayInfo, t?: CatalogTable, services: OgcService[], onAddToOgc: (table: string) => void, onGo: (tab: 'arcgis' | 'ogc') => void
}) {
  const inServices = t ? services.flatMap(s => s.collections.filter(c => c.table === t.table).map(c => ({ s, c }))) : []
  const url = useMemo(() => t ? `${location.origin}${layerPath(t.table)}` : '', [t?.table])
  return (
    <aside className='use-panel'>
      <div className='use-box'>
        <h4>Use in Experience Builder</h4>
        <p className='small muted'>Give the Databricks Data widget this gateway URL{t ? <>, sign in, then pick <b>{t.name}</b></> : ', sign in, then pick tables'}.</p>
        <UrlField url={info.gatewayUrl} label='Gateway URL' copyLabel='Copy' primary />
        <div className='card-actions'>
          {info.widgetSource && <a className='button ghost' href={info.widgetSource} target='_blank' rel='noreferrer'>Get the widget</a>}
          <button className='link small' onClick={() => onGo('arcgis')}>All the steps →</button>
        </div>
        {info.cdfSource && <p className='small muted teaser'>Map Viewer or ArcGIS Pro? <button className='link' onClick={() => onGo('arcgis')}>Use the Custom Data Feed</button>.</p>}
      </div>
      <div className='use-box'>
        <h4>Use in QGIS / OGC</h4>
        {!info.ogc.enabled && <p className='small muted'>OGC services are off on this gateway.</p>}
        {info.ogc.enabled && !t && <p className='small muted'>Pick a table to see its OGC URL.</p>}
        {info.ogc.enabled && t && inServices.map(({ s, c }) => (
          <div key={`${s.name}/${c.id}`}>
            <p className='small'>In <b>{s.title}</b>:</p>
            <UrlField url={`${info.gatewayUrl}/ogc/${s.name}/collections/${c.id}/items`} label={`${s.title} items URL`} copyLabel='Copy' />
          </div>
        ))}
        {info.ogc.enabled && t && !inServices.length && <p className='small muted'>Not in an OGC service yet. A service gives QGIS one URL for a set of tables.</p>}
        <div className='card-actions'>
          {info.ogc.enabled && t && <button className='button ghost' onClick={() => onAddToOgc(t.table)}>{inServices.length ? 'Add to a new service' : 'Add to an OGC service'}</button>}
          <button className='link small' onClick={() => onGo('ogc')}>OGC services →</button>
        </div>
      </div>
      {t && (
        <details className='use-box'>
          <summary>Layer URL for scripts</summary>
          <p className='small muted'>Esri FeatureServer REST. Send a Databricks OAuth token as <code>Authorization: Bearer</code>; personal access tokens aren't accepted.</p>
          <UrlField url={url} label='Layer URL' copyLabel='Copy' />
          <CopyToken />
        </details>
      )}
    </aside>
  )
}

// Write a map-optimized copy: native GEOMETRY + per-row bounding boxes, clustered on them
function Optimize ({ t, spec, count }: { t: CatalogTable, spec: LayerSpec, count: number | null }) {
  const [target, setTarget] = useState(`${t.catalog}.${t.schema}`)
  const [name, setName] = useState(`${t.name}_map`)
  const [job, setJob] = useState<OptimizeJob | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!job || job.state !== 'running') return
    const timer = setInterval(() => { api.job(job.id).then(setJob).catch(() => {}) }, 3000)
    return () => clearInterval(timer)
  }, [job?.id, job?.state])

  const start = async (force = false) => {
    setError(null)
    try { setJob(await api.optimize(t.table, target.trim(), name.trim(), force)) } catch (e) { setError(e) }
  }
  const why = spec.geometrySource?.includes('string') || spec.geometrySource?.includes('binary')
    ? `Its geometry is stored as ${spec.geometrySource}, so every map query parses it row by row.`
    : 'Its rows are not clustered by location, so every map query reads the whole table.'
  const seconds = job?.finishedAt ? Math.round((job.finishedAt - job.startedAt) / 1000) : null

  return (
    <div className='optimize'>
      <h4>Optimize for maps</h4>
      <p className='muted'>
        {why} An optimized copy stores native GEOMETRY plus a bounding box per row and clusters the table on it,
        so a map view only reads the files that overlap it. {count && count > 250000 ? 'Recommended for a table this size.' : ''}
        The copy is written with your permissions; you need CREATE TABLE on the target schema. The original table is not changed.
      </p>
      <div className='optimize-form'>
        <label>Target schema<input value={target} onChange={e => setTarget(e.target.value)} placeholder='catalog.schema' /></label>
        <label>Table name<input value={name} onChange={e => setName(e.target.value)} /></label>
        <button className='button' disabled={job?.state === 'running'} onClick={() => start()}>
          {job?.state === 'running' ? 'Optimizing…' : 'Create optimized copy'}
        </button>
      </div>
      <AccessHint action='CREATE_TABLE' name={target.trim()} doing='Writing the copy' />
      <WriteError error={error} onRetry={() => start(true)} />
      {job?.state === 'running' && <p className='muted small'>Writing {job.target}. Large tables take a few minutes.</p>}
      {job?.state === 'done' && <p className='small'>Done in {seconds} s: <code>{job.target}</code> ({job.rows?.toLocaleString()} rows). Use it in place of the original; it appears in this catalog after a refresh.</p>}
      {job?.state === 'failed' && <p className='error small'>Failed: {job.error}</p>}
    </div>
  )
}
