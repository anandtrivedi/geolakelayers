import { useEffect, useMemo, useState } from 'react'
import { api, layerPath } from '../api'
import type { CatalogTable, LayerSpec } from '../api'
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
    </div>
  )
}
