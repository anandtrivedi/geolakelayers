import { useEffect, useMemo, useState } from 'react'
import { api, layerPath } from '../api'
import type { CatalogTable, LayerSpec, OptimizeJob } from '../api'
import { MapPreview } from './MapPreview'
import { CatalogTree } from './CatalogTree'

// Catalog ▸ schema ▸ table explorer. Picking a table shows how the gateway reads it, its layer URL and a live map.
export function Explorer () {
  const [selected, setSelected] = useState<CatalogTable | null>(null)

  return (
    <div className='explorer'>
      <div className='explorer-tree card'>
        <CatalogTree isActive={t => selected?.table === t.table} onPick={setSelected} />
      </div>
      <div className='explorer-detail'>
        {selected ? <TableDetail key={selected.table} t={selected} /> : (
          <div className='card empty-detail'>
            <h3>Pick a table</h3>
            <p className='muted'>Open a catalog on the left. Tables with geometry (GEOMETRY, GEOGRAPHY, WKT, WKB or longitude/latitude columns) and an id are listed. Each one is a FeatureServer layer you can add in Experience Builder, Map Viewer or ArcGIS Pro.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function TableDetail ({ t }: { t: CatalogTable }) {
  const [spec, setSpec] = useState<LayerSpec | null | undefined>(undefined)
  const [count, setCount] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const url = useMemo(() => `${location.origin}${layerPath(t.table)}`, [t.table])

  useEffect(() => {
    api.spec(t.table).then(setSpec).catch(() => setSpec(null))
    api.count(t.table).then(setCount).catch(() => setCount(null))
  }, [t.table])

  const copy = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className='card detail'>
      <div className='detail-head'>
        <div>
          <div className='muted small'>{t.catalog}.{t.schema}</div>
          <h3>{t.name}</h3>
        </div>
        <a className='button ghost' href={`${layerPath(t.table)}?f=pjson`} target='_blank' rel='noreferrer'>Layer JSON</a>
      </div>
      <dl className='facts'>
        <div><dt>Features</dt><dd>{count === null ? '…' : count.toLocaleString()}</dd></div>
        <div><dt>Geometry</dt><dd>{spec?.geometryType?.replace('esriGeometry', '') || '…'} <span className='muted'>from {spec?.geometrySource || t.geometry}</span></dd></div>
        <div><dt>Object id</dt><dd>{spec?.syntheticIdFrom ? <>derived from <code>{spec.syntheticIdFrom}</code></> : <code>{spec?.objectId || t.idField}</code>}</dd></div>
      </dl>
      <div className='url-row'>
        <code className='url' title={url}>{url}</code>
        <button className='button' onClick={copy}>{copied ? 'Copied' : 'Copy layer URL'}</button>
      </div>
      <MapPreview table={t.table} />
      {spec && (spec.bboxColumns
        ? <p className='optimized-note'><span className='chip small'>Map-optimized</span> Tile queries skip files outside the map view.</p>
        : <Optimize t={t} spec={spec} count={count} />)}
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
