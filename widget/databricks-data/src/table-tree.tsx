/** @jsx jsx */
/*
  Workspace ▸ catalog ▸ schema ▸ table tree, shared by the runtime (click to add) and the settings
  panel (tick start-up layers). A catalog's tables load the first time it is expanded.
*/
import { React, jsx, css } from 'jimu-core'
import { Loading, LoadingType } from 'jimu-ui'
import { RightOutlined } from 'jimu-icons/outlined/directional/right'
import { DownOutlined } from 'jimu-icons/outlined/directional/down'
import type { CatalogTable, Workspace } from './config'

interface CatalogState { state: 'loading' | 'ready' | 'failed', tables: CatalogTable[], error?: string }

export interface TableTreeProps {
  workspaces: Workspace[]
  /** Catalogs to show under a workspace */
  catalogsFor: (ws: Workspace) => string[]
  /** Map-ready tables of one catalog */
  loadTables: (ws: Workspace, catalog: string) => Promise<CatalogTable[]>
  /** Right-hand side of a table row (status, checkbox, ...) */
  renderTable: (ws: Workspace, t: CatalogTable) => React.ReactNode
  onTableClick?: (ws: Workspace, t: CatalogTable) => void
  /** Text filter on table names (applies to loaded catalogs) */
  filter?: string
  /** Show the workspace level even with one workspace */
  showWorkspaces?: boolean
  /** Expand everything that has one child (e.g. a single catalog) */
  autoExpandSingle?: boolean
  /** Open (and load) every listed workspace and catalog */
  expandAll?: boolean
  /** Extra marker after a catalog's name */
  catalogBadge?: (ws: Workspace, catalog: string) => React.ReactNode
  /** Only show tables passing this test (e.g. "selected only") */
  tableFilter?: (ws: Workspace, t: CatalogTable) => boolean
  messages: { loading: string, failed: (error: string) => string, empty: string, tablesIn: (n: number) => string }
}

export function TableTree (props: TableTreeProps) {
  const { workspaces, catalogsFor, loadTables, renderTable, onTableClick, filter = '', messages } = props
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [catalogState, setCatalogState] = React.useState<{ [key: string]: CatalogState }>({})
  const showWorkspaces = props.showWorkspaces || workspaces.length > 1
  const q = filter.trim().toLowerCase()

  // Latest request per catalog wins: a slow, older response can't overwrite a newer one
  const seq = React.useRef<{ [key: string]: number }>({})
  const load = React.useCallback(async (ws: Workspace, catalog: string) => {
    const key = `${ws.id}|${catalog}`
    const n = (seq.current[key] = (seq.current[key] || 0) + 1)
    setCatalogState(s => ({ ...s, [key]: { state: 'loading', tables: [] } }))
    try {
      const tables = await loadTables(ws, catalog)
      if (seq.current[key] === n) setCatalogState(s => ({ ...s, [key]: { state: 'ready', tables } }))
    } catch (err) {
      if (seq.current[key] === n) setCatalogState(s => ({ ...s, [key]: { state: 'failed', tables: [], error: err.message } }))
    }
  }, [loadTables])

  // Side effects (loading) stay outside the state updater, which React may run twice
  const toggle = (key: string, onOpen?: () => void) => {
    const opening = !expanded.has(key)
    setExpanded(prev => {
      const next = new Set(prev)
      if (opening) next.add(key)
      else next.delete(key)
      return next
    })
    if (opening) onOpen?.()
  }

  React.useEffect(() => {
    if (!props.expandAll) return
    const next = new Set(expanded)
    for (const ws of workspaces) {
      next.add(`w|${ws.id}`)
      for (const c of catalogsFor(ws)) {
        next.add(`c|${ws.id}|${c}`)
        if (!catalogState[`${ws.id}|${c}`]) load(ws, c)
      }
    }
    setExpanded(next)
  }, [props.expandAll, workspaces.map(w => w.id + ':' + catalogsFor(w).join(',')).join('|')])

  // Catalogs open by default when there's just one under a workspace
  React.useEffect(() => {
    if (!props.autoExpandSingle) return
    for (const ws of workspaces) {
      const cats = catalogsFor(ws)
      const wsKey = `w|${ws.id}`
      if (showWorkspaces && workspaces.length === 1) setExpanded(p => new Set(p).add(wsKey))
      if (cats.length === 1) {
        const key = `${ws.id}|${cats[0]}`
        setExpanded(p => new Set(p).add(`c|${key}`))
        if (!catalogState[key]) load(ws, cats[0])
      }
    }
  }, [workspaces.map(w => w.id + ':' + catalogsFor(w).join(',')).join('|')])

  // When a workspace's gateway or warehouse changes, drop cached tables and reload the open catalogs
  const identity = workspaces.map(w => w.id + w.gatewayUrl + w.warehouseId).join('|')
  const firstIdentity = React.useRef(true)
  React.useEffect(() => {
    if (firstIdentity.current) { firstIdentity.current = false; return }
    setCatalogState({})
    for (const key of expanded) {
      if (!key.startsWith('c|')) continue
      const [wsId, catalog] = key.slice(2).split('|')
      const ws = workspaces.find(w => w.id === wsId)
      if (ws) load(ws, catalog)
    }
  }, [identity])

  const caret = (open: boolean) => open ? <DownOutlined size={12} /> : <RightOutlined size={12} />

  const renderCatalog = (ws: Workspace, catalog: string, depth: number) => {
    const key = `${ws.id}|${catalog}`
    const nodeKey = `c|${key}`
    const open = expanded.has(nodeKey) || (q && catalogState[key]?.state === 'ready') || props.expandAll
    const st = catalogState[key]
    const tables = (st?.tables || []).filter(t => (!q || t.table.toLowerCase().includes(q)) && (!props.tableFilter || props.tableFilter(ws, t)))
    const schemas = Array.from(new Set(tables.map(t => t.schema))).sort()
    if (q && st?.state === 'ready' && !tables.length) return null
    return (
      <div key={nodeKey} role='treeitem' aria-expanded={!!open}>
        <div className='tt-row tt-branch' style={{ paddingLeft: depth * 14 }} role='button' tabIndex={0}
          onClick={() => toggle(nodeKey, () => { if (!st || st.state === 'failed') load(ws, catalog) })}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggle(nodeKey, () => { if (!st || st.state === 'failed') load(ws, catalog) })}>
          {caret(!!open)}<span className='tt-name'>{catalog}</span>{props.catalogBadge?.(ws, catalog)}
          {st?.state === 'ready' && <small className='tt-hint'>{messages.tablesIn(st.tables.length)}</small>}
        </div>
        {open && (
          <div role='group'>
            {st?.state === 'loading' && <div className='tt-row' style={{ paddingLeft: (depth + 1) * 14 }}><Loading type={LoadingType.Donut} width={14} height={14} text={messages.loading} /></div>}
            {st?.state === 'failed' && <div className='tt-row tt-error' style={{ paddingLeft: (depth + 1) * 14 }}>{messages.failed(st.error)}</div>}
            {st?.state === 'ready' && !st.tables.length && <div className='tt-row tt-hint' style={{ paddingLeft: (depth + 1) * 14 }}>{messages.empty}</div>}
            {schemas.map(schema => {
              const sKey = `s|${key}|${schema}`
              const sOpen = expanded.has(sKey) || !!q || schemas.length === 1 || !!props.expandAll
              const inSchema = tables.filter(t => t.schema === schema)
              return (
                <div key={sKey} role='treeitem' aria-expanded={sOpen}>
                  <div className='tt-row tt-branch' style={{ paddingLeft: (depth + 1) * 14 }} role='button' tabIndex={0}
                    onClick={() => toggle(sKey)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggle(sKey)}>
                    {caret(sOpen)}<span className='tt-name'>{schema}</span><small className='tt-hint'>{inSchema.length}</small>
                  </div>
                  {sOpen && (
                    <div role='group'>
                      {inSchema.map(t => (
                        <div key={t.table} role='treeitem' className={`tt-row tt-leaf${onTableClick ? ' tt-clickable' : ''}`}
                          style={{ paddingLeft: (depth + 2) * 14 + 14 }}
                          tabIndex={onTableClick ? 0 : undefined}
                          onClick={onTableClick ? () => onTableClick(ws, t) : undefined}
                          onKeyDown={onTableClick ? e => (e.key === 'Enter' || e.key === ' ') && onTableClick(ws, t) : undefined}>
                          {renderTable(ws, t)}
                        </div>
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
  }

  return (
    <div className='table-tree' role='tree' css={style}>
      {workspaces.map(ws => {
        const cats = catalogsFor(ws)
        if (!showWorkspaces) return cats.map(c => renderCatalog(ws, c, 0))
        const wKey = `w|${ws.id}`
        const open = expanded.has(wKey) || !!q || !!props.expandAll
        return (
          <div key={wKey} role='treeitem' aria-expanded={open}>
            <div className='tt-row tt-branch tt-workspace' role='button' tabIndex={0}
              onClick={() => toggle(wKey)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggle(wKey)}>
              {caret(open)}<span className='tt-name'>{ws.label}</span><small className='tt-hint'>{cats.length}</small>
            </div>
            {open && <div role='group'>{cats.map(c => renderCatalog(ws, c, 1))}</div>}
          </div>
        )
      })}
    </div>
  )
}

const style = css`
  .tt-row { display: flex; align-items: center; gap: 6px; min-height: 26px; padding-right: 4px; }
  .tt-branch { cursor: pointer; border-radius: 3px; }
  .tt-branch:hover, .tt-clickable:hover { background-color: var(--sys-color-action-hover); }
  .tt-branch:focus-visible, .tt-clickable:focus-visible { outline: 2px solid var(--sys-color-primary-main); outline-offset: -2px; }
  .tt-workspace .tt-name { font-weight: 600; }
  .tt-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tt-hint { color: var(--sys-color-surface-paper-hint); margin-left: auto; white-space: nowrap; }
  .tt-error { color: var(--sys-color-error-main); }
  .tt-leaf { border-bottom: 1px solid var(--sys-color-divider-tertiary); }
  .tt-clickable { cursor: pointer; }
`
