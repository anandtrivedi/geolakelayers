import { useEffect, useMemo, useState } from 'react'
import { api, layerPath } from '../api'
import type { CatalogTable, LayerSpec, OptimizeJob } from '../api'
import { MapPreview } from './MapPreview'

// Catalog ▸ schema ▸ table explorer. A catalog's map-ready tables load when it is opened; picking a
// table shows how the gateway reads it, its layer URL and a live map.
type Loaded = { state: 'loading' | 'ready' | 'failed', tables: CatalogTable[], error?: string }

export function Explorer () {
  const [catalogs, setCatalogs] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [selected, setSelected] = useState<CatalogTable | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => { api.catalogs().then(setCatalogs).catch(e => setError(e.message)) }, [])

  const toggle = (key: string, catalog?: string) => {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else {
        next.add(key)
        if (catalog && !loaded[catalog]) {
          setLoaded(l => ({ ...l, [catalog]: { state: 'loading', tables: [] } }))
          api.tables(catalog)
            .then(tables => setLoaded(l => ({ ...l, [catalog]: { state: 'ready', tables } })))
            .catch(e => setLoaded(l => ({ ...l, [catalog]: { state: 'failed', tables: [], error: e.message } })))
        }
      }
      return next
    })
  }

  const q = filter.trim().toLowerCase()
  const shownCatalogs = (catalogs || []).filter(c => !q || c.toLowerCase().includes(q) || loaded[c]?.tables.some(t => t.table.toLowerCase().includes(q)))

  return (
    <div className='explorer'>
      <div className='explorer-tree card'>
        <input className='search' placeholder='Filter catalogs and loaded tables' value={filter} onChange={e => setFilter(e.target.value)} aria-label='Filter catalogs and tables' />
        {error && <p className='error'>Could not list catalogs: {error}</p>}
        {!catalogs && !error && <p className='muted'>Loading catalogs…</p>}
        <div role='tree' aria-label='Unity Catalog'>
          {shownCatalogs.map(c => {
            const cOpen = open.has(c)
            const st = loaded[c]
            const tables = (st?.tables || []).filter(t => !q || t.table.toLowerCase().includes(q) || c.toLowerCase().includes(q))
            const schemas = Array.from(new Set(tables.map(t => t.schema))).sort()
            return (
              <div key={c} role='treeitem' aria-expanded={cOpen}>
                <button className='node catalog' onClick={() => toggle(c, c)}>
                  <span className={`caret${cOpen ? ' open' : ''}`} aria-hidden>▸</span>
                  <span className='node-name'>{c}</span>
                  {st?.state === 'ready' && <span className='badge'>{st.tables.length}</span>}
                </button>
                {cOpen && (
                  <div role='group' className='children'>
                    {st?.state === 'loading' && <p className='muted small'>Scanning for map-ready tables…</p>}
                    {st?.state === 'failed' && <p className='error small'>{st.error}</p>}
                    {st?.state === 'ready' && !st.tables.length && <p className='muted small'>No map-ready tables</p>}
                    {schemas.map(s => {
                      const sKey = `${c}.${s}`
                      const sOpen = open.has(sKey) || schemas.length === 1 || !!q
                      return (
                        <div key={sKey} role='treeitem' aria-expanded={sOpen}>
                          <button className='node schema' onClick={() => toggle(sKey)}>
                            <span className={`caret${sOpen ? ' open' : ''}`} aria-hidden>▸</span>
                            <span className='node-name'>{s}</span>
                            <span className='badge'>{tables.filter(t => t.schema === s).length}</span>
                          </button>
                          {sOpen && (
                            <div role='group' className='children'>
                              {tables.filter(t => t.schema === s).map(t => (
                                <button key={t.table} role='treeitem' className={`node table${selected?.table === t.table ? ' active' : ''}`} onClick={() => setSelected(t)}>
                                  <span className='node-name'>{t.name}</span>
                                  <span className='geom-chip'>{t.geometry}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
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
