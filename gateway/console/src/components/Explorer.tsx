import { useEffect, useMemo, useState } from 'react'
import { api, layerPath } from '../api'
import type { CatalogTable, GatewayInfo, LayerSpec, OgcService, OptimizeJob, ScanResult } from '../api'
import { Copy, UrlField } from './Copy'
import { MapPreview } from './MapPreview'
import { CatalogTree } from './CatalogTree'
import { LayerSettings } from './LayerSettings'

// Catalog ▸ schema ▸ table explorer. Picking a table shows how the gateway reads it, its layer URL and a live map.
export function Explorer ({ info, onAddToOgc, onGuide }: { info: GatewayInfo, onAddToOgc: (table: string) => void, onGuide: () => void }) {
  const [services, setServices] = useState<OgcService[]>([])
  useEffect(() => { if (info.ogc.enabled) api.ogcServices().then(setServices).catch(() => {}) }, [info.ogc.enabled])
  const [selected, setSelected] = useState<CatalogTable | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [byName, setByName] = useState('')
  const [scanSchema, setScanSchema] = useState('')
  const [scan, setScan] = useState<{ busy: boolean, result?: ScanResult, error?: string }>({ busy: false })

  const open = () => {
    const name = byName.trim()
    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(name)) return
    const [catalog, schema, n] = name.split('.')
    setSelected({ table: name, catalog, schema, name: n, idField: '', geometry: '' })
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
    <p className='page-intro'>
      Preview Databricks tables the way they will look in ArcGIS Experience Builder and OGC clients. Pick a table on the left to see
      it on a map, check how its geometry and id are read, and copy the URLs for Experience Builder, OGC clients and
      scripts. Only tables you can read in Unity Catalog are listed.
    </p>
    <div className='explorer'>
      <div className='explorer-tree card'>
        <CatalogTree isActive={t => selected?.table === t.table} onPick={setSelected} reloadKey={reloadKey} />
        <div className='tree-tools'>
          <p className='muted small'>
            Listed: tables with a GEOMETRY or GEOGRAPHY column, and tables with an override. Geometry stored as
            text or binary (WKT, WKB, GeoJSON) is found by scanning a schema.
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
        </div>
      </div>
      <div className='explorer-detail'>
        {selected ? <TableDetail key={selected.table} t={selected} info={info} services={services} onAddToOgc={onAddToOgc} onGuide={onGuide} onChanged={() => setReloadKey(k => k + 1)} /> : (
          <div className='card empty-detail'>
            <h3>Pick a table</h3>
            <p className='muted'>Open a catalog on the left. Tables with geometry are listed. Pick one to see it on a map and where it can be used: as a layer in Experience Builder through the Databricks Data widget, as a collection in an OGC service for QGIS, GDAL and web maps, or from scripts.</p>
          </div>
        )}
      </div>
    </div>
    </>
  )
}

function TableDetail ({ t, info, services, onAddToOgc, onGuide, onChanged }: {
  t: CatalogTable, info: GatewayInfo, services: OgcService[], onAddToOgc: (table: string) => void, onGuide: () => void, onChanged: () => void
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.specDetail>> | null>(null)
  const [error, setError] = useState('')
  const [count, setCount] = useState<number | null>(null)
  const [version, setVersion] = useState(0)
  const url = useMemo(() => `${location.origin}${layerPath(t.table)}`, [t.table])
  const spec = detail ? detail.spec : undefined

  useEffect(() => {
    setError('')
    api.specDetail(t.table).then(d => {
      setDetail(d)
      if (d.spec) api.count(t.table).then(setCount).catch(() => setCount(null))
    }).catch(e => { setError(e.message); setDetail({ spec: null, columns: [], override: null }) })
  }, [t.table, version])
  const changed = () => { setVersion(v => v + 1); onChanged() }

  return (
    <div className='card detail'>
      <div className='detail-head'>
        <div>
          <div className='muted small'>{t.catalog}.{t.schema}</div>
          <h3>{t.name}</h3>
        </div>
        <a className='button ghost' href={`${layerPath(t.table)}?f=pjson`} target='_blank' rel='noreferrer'>Layer JSON</a>
      </div>
      {error && <p className='error'>{error}</p>}
      {spec === null && !error && (
        <p className='muted'>No geometry found in this table: it has no GEOMETRY or GEOGRAPHY column, and none of its text or binary columns hold WKT, WKB or GeoJSON. If its geometry is in two longitude/latitude columns, or in a column that is mostly empty, pick it below.</p>
      )}
      {spec && (
        <>
          <dl className='facts'>
            <div><dt>Features</dt><dd>{count === null ? '…' : count.toLocaleString()}</dd></div>
            <div><dt>Geometry</dt><dd>{spec.geometryType.replace('esriGeometry', '')} <span className='muted'>from {spec.geometrySource}</span></dd></div>
            <div><dt>Object id</dt><dd>{spec.idSource === 'derived' ? 'derived (read-only)' : <code>{spec.objectId}</code>}</dd></div>
          </dl>
          <MapPreview key={version} table={t.table} />
          <UseThisTable t={t} info={info} url={url} services={services} onAddToOgc={onAddToOgc} onGuide={onGuide} />
        </>
      )}
      {detail && (
        <details className='author-tools' open={spec === null}>
          <summary>How this table is read{spec && !spec.bboxColumns ? ', and optimizing it for maps' : ''}</summary>
          <LayerSettings key={version} table={t.table} spec={spec || null} columns={detail.columns} override={detail.override} onChanged={changed} />
          {spec && (spec.bboxColumns
            ? <p className='optimized-note'><span className='chip small'>Map-optimized</span> Tile queries skip files outside the map view.</p>
            : <Optimize t={t} spec={spec} count={count} />)}
        </details>
      )}
    </div>
  )
}

// Where this table can be used, one row per kind of client
function UseThisTable ({ t, info, url, services, onAddToOgc, onGuide }: {
  t: CatalogTable, info: GatewayInfo, url: string, services: OgcService[], onAddToOgc: (table: string) => void, onGuide: () => void
}) {
  const inServices = services.flatMap(s => s.collections.filter(c => c.table === t.table).map(c => ({ s, c })))
  return (
    <div className='use-table'>
      <h4>Use this table</h4>
      <div className='use-row'>
        <div className='use-what'><b>Experience Builder</b><span className='muted small'>through the Databricks Data widget</span></div>
        <div className='use-how'>
          <p className='small'>Give the widget this gateway's URL, sign in, then pick <code>{t.table}</code> as a start-up layer, or let viewers add it themselves.</p>
          <UrlField url={info.gatewayUrl} label='Gateway URL' copyLabel='Copy gateway URL' />
        </div>
      </div>
      <div className='use-row'>
        <div className='use-what'><b>QGIS, GDAL, web maps</b><span className='muted small'>OGC API – Features</span></div>
        <div className='use-how'>
          {!info.ogc.enabled && <p className='small muted'>OGC services are off on this gateway.</p>}
          {info.ogc.enabled && inServices.map(({ s, c }) => (
            <div key={`${s.name}/${c.id}`}>
              <p className='small'>In the <b>{s.title}</b> service as <code>{c.id}</code>:</p>
              <UrlField url={`${info.gatewayUrl}/ogc/${s.name}/collections/${c.id}/items`} label={`${s.title} items URL`} />
            </div>
          ))}
          {info.ogc.enabled && (
            <div className='use-actions'>
              <span className='small muted'>{inServices.length ? 'Or publish it in a new service.' : 'Not in an OGC service yet. A service gives OGC clients one URL for a set of tables.'}</span>
              <button className='button ghost' onClick={() => onAddToOgc(t.table)}>Add to a new OGC service</button>
            </div>
          )}
        </div>
      </div>
      <div className='use-row'>
        <div className='use-what'><b>Scripts and notebooks</b><span className='muted small'>Esri FeatureServer REST</span></div>
        <div className='use-how'>
          <p className='small'>Send a Databricks OAuth token as <code>Authorization: Bearer</code>. Personal access tokens aren't accepted.</p>
          <div className='url-row'>
            <input className='url' readOnly value={url} title={url} aria-label='Layer URL' spellCheck={false} />
            <Copy text={url} label='Copy layer URL' />
          </div>
        </div>
      </div>
      <p className='small muted'>
        ArcGIS Map Viewer and ArcGIS Pro can't use the layer URL directly yet: "add layer from URL" doesn't send a
        Databricks sign-in. <button className='link' onClick={onGuide}>See the guide</button> for every client.
      </p>
    </div>
  )
}

// Write a map-optimized copy: native GEOMETRY + per-row bounding boxes, clustered on them
function Optimize ({ t, spec, count }: { t: CatalogTable, spec: LayerSpec, count: number | null }) {
  const [target, setTarget] = useState(`${t.catalog}.${t.schema}`)
  const [name, setName] = useState(`${t.name}_map`)
  const [job, setJob] = useState<OptimizeJob | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!job || job.state !== 'running') return
    const timer = setInterval(() => { api.job(job.id).then(setJob).catch(() => {}) }, 3000)
    return () => clearInterval(timer)
  }, [job?.id, job?.state])

  const start = async () => {
    setError('')
    try { setJob(await api.optimize(t.table, target.trim(), name.trim())) } catch (e: any) { setError(e.message) }
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
        <button className='button' disabled={job?.state === 'running'} onClick={start}>
          {job?.state === 'running' ? 'Optimizing…' : 'Create optimized copy'}
        </button>
      </div>
      {error && <p className='error small'>{error}</p>}
      {job?.state === 'running' && <p className='muted small'>Writing {job.target}. Large tables take a few minutes.</p>}
      {job?.state === 'done' && <p className='small'>Done in {seconds} s: <code>{job.target}</code> ({job.rows?.toLocaleString()} rows). Use it in place of the original; it appears in this catalog after a refresh.</p>}
      {job?.state === 'failed' && <p className='error small'>Failed: {job.error}</p>}
    </div>
  )
}
