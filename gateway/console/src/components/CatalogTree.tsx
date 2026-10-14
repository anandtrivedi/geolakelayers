import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import type { CatalogTable } from '../api'

// Catalog ▸ schema ▸ table tree. A catalog's map-ready tables load when it is opened. Used by Explore
// (pick one table) and the OGC service editor (tick several).
type Loaded = { state: 'loading' | 'ready' | 'failed', tables: CatalogTable[], error?: string }

export function CatalogTree ({ isActive, onPick, leafStart, reloadKey = 0, reveal }: {
  isActive: (t: CatalogTable) => boolean
  onPick: (t: CatalogTable) => void
  leafStart?: (t: CatalogTable) => ReactNode
  /** Change to reload the open catalogs (after a scan or an override) */
  reloadKey?: number
  /** A table (catalog.schema.table) to open the tree to when it first loads, e.g. the one Explore reopened */
  reveal?: string
}) {
  const [catalogs, setCatalogs] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [filter, setFilter] = useState('')

  useEffect(() => { api.catalogs().then(setCatalogs).catch(e => setError(e.message)) }, [])
  // Open the revealed table's catalog and schema once, then scroll it into view when its catalog has loaded
  const revealed = useRef<'no' | 'opened' | 'done'>('no')
  const treeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!reveal || !catalogs || revealed.current !== 'no') return
    const [c, s] = reveal.split('.')
    if (!catalogs.includes(c)) { revealed.current = 'done'; return }
    revealed.current = 'opened'
    setOpen(prev => new Set([...prev, c, `${c}.${s}`]))
    if (!loaded[c]) load(c)
  }, [reveal, catalogs])
  useEffect(() => {
    if (revealed.current !== 'opened' || !reveal || loaded[reveal.split('.')[0]]?.state !== 'ready') return
    revealed.current = 'done'
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>('.node.table.active')?.scrollIntoView({ block: 'nearest' }))
  }, [loaded, reveal])
  useEffect(() => {
    if (!reloadKey) return
    for (const c of Object.keys(loaded)) if (open.has(c)) load(c)
    setLoaded(l => Object.fromEntries(Object.entries(l).filter(([c]) => open.has(c))))
  }, [reloadKey])

  const load = (catalog: string) => {
    setLoaded(l => ({ ...l, [catalog]: { state: 'loading', tables: [] } }))
    api.tables(catalog)
      .then(tables => setLoaded(l => ({ ...l, [catalog]: { state: 'ready', tables } })))
      .catch(e => setLoaded(l => ({ ...l, [catalog]: { state: 'failed', tables: [], error: e.message } })))
  }
  const toggle = (key: string, catalog?: string) => {
    const opening = !open.has(key)
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (opening && catalog && (!loaded[catalog] || loaded[catalog].state === 'failed')) load(catalog)
  }

  const q = filter.trim().toLowerCase()
  const shownCatalogs = (catalogs || []).filter(c => !q || c.toLowerCase().includes(q) || loaded[c]?.tables.some(t => t.table.toLowerCase().includes(q)))

  return (
    <>
      <input className='search' placeholder='Filter catalogs and loaded tables' value={filter} onChange={e => setFilter(e.target.value)} aria-label='Filter catalogs and tables' />
      {error && <p className='error'>Could not list catalogs: {error}</p>}
      {!catalogs && !error && <p className='muted'>Loading catalogs…</p>}
      <div role='tree' aria-label='Unity Catalog' ref={treeRef}>
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
                              <button key={t.table} role='treeitem' aria-selected={isActive(t)} className={`node table${isActive(t) ? ' active' : ''}`} onClick={() => onPick(t)}>
                                {leafStart?.(t)}
                                <span className='node-name'>{t.name}</span>
                                <span className={`geom-chip${t.detectedBy === 'override' ? ' override' : ''}`} title={t.detectedBy === 'override' ? 'set by an author' : t.detectedBy === 'content' ? 'found by sampling values' : 'GEOMETRY/GEOGRAPHY column'}>{t.geometry}</span>
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
    </>
  )
}
