/** @jsx jsx */
import { React, jsx, css, Immutable } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { Button, Checkbox, Option, Select, Switch, TextInput } from 'jimu-ui'
import { TrashOutlined } from 'jimu-icons/outlined/editor/trash'
import { PlusOutlined } from 'jimu-icons/outlined/editor/plus'
import { RightOutlined } from 'jimu-icons/outlined/directional/right'
import { DownOutlined } from 'jimu-icons/outlined/directional/down'
import type { IMConfig, CatalogTable, Workspace } from '../config'
import { getToken, signIn, signInNotice, listenForToken, fetchCatalog, fetchCatalogNames, fetchWarehouses, fetchDirectory, fetchEditing, setWarehouse } from '../auth'
import type { WarehouseInfo } from '../auth'
import { workspacesOf, labelFromUrl, newWorkspaceId, normalizeUrl, layerKey, parseLayerKey } from '../workspaces'
import { TableTree } from '../table-tree'
import { onLayerAnnounced } from '../sync'
import defaultMessages from './translations/default'

/*
  The author's path, top to bottom:
    Map -> viewer browsing on/off -> one card per Databricks workspace (URL, sign-in, warehouse, and the
    catalogs viewers can browse) -> start-up layers (one tree, workspace ▸ catalog ▸ schema ▸ table).
  Each thing is set in exactly one place. Card contents are filled from that workspace's gateway with the
  author's own permissions after sign-in.
*/
interface WorkspaceInfo { warehouses: WarehouseInfo[], defaultWarehouse: string | null, catalogs: string[], editing?: boolean, error?: string }

export default function Setting (props: AllWidgetSettingProps<IMConfig>) {
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)

  // All rows, including one still missing a URL (workspacesOf drops those for the runtime)
  const rows: Workspace[] = props.config.workspaces ? props.config.workspaces.asMutable({ deep: true }) as Workspace[] : []
  const workspaces = workspacesOf(props.config)
  const selected: string[] = props.config.layers ? props.config.layers.asMutable() : []
  const allowBrowse = props.config.allowBrowse !== false

  const [users, setUsers] = React.useState<{ [id: string]: string }>({})
  const [blocked, setBlocked] = React.useState<{ [gatewayUrl: string]: boolean }>({})
  const [info, setInfo] = React.useState<{ [id: string]: WorkspaceInfo }>({})
  const [open, setOpen] = React.useState<{ [id: string]: boolean }>(() => rows.length === 1 ? { [rows[0].id]: true } : {})
  const [adding, setAdding] = React.useState(false)
  const [newUrl, setNewUrl] = React.useState('')
  const [directory, setDirectory] = React.useState<Array<{ name: string, url: string }>>([])
  const [filter, setFilter] = React.useState('')
  const [selectedOnly, setSelectedOnly] = React.useState(false)
  const [catalogFilter, setCatalogFilter] = React.useState<{ [id: string]: string }>({})

  // Every change builds on the latest config, not this render's props: two quick edits (ticking two
  // catalogs, say) would otherwise both start from the same old config and the first would be lost
  const configRef = React.useRef(props.config)
  configRef.current = props.config
  const commit = (config: IMConfig) => {
    configRef.current = config
    props.onSettingChange({ id: props.id, config })
  }
  const currentRows = (): Workspace[] => configRef.current.workspaces ? configRef.current.workspaces.asMutable({ deep: true }) as Workspace[] : []
  const currentLayers = (): string[] => configRef.current.layers ? configRef.current.layers.asMutable() : []
  const setConfig = (key: string, value: any) => commit(configRef.current.set(key, value))
  const setRows = (next: Workspace[], layers?: string[]) => {
    let config = configRef.current.set('workspaces', Immutable(next))
    if (layers) config = config.set('layers', Immutable(layers))
    commit(config)
  }
  const updateRow = (id: string, patch: Partial<Workspace>) => setRows(currentRows().map(w => w.id === id ? { ...w, ...patch } : w))
  const addWorkspace = (label: string, url: string) => {
    const gatewayUrl = normalizeUrl(url)
    const now = currentRows()
    if (!/^https:\/\//.test(gatewayUrl) || now.some(r => normalizeUrl(r.gatewayUrl) === gatewayUrl)) return
    const id = newWorkspaceId(now)
    setRows([...now, { id, label: label || labelFromUrl(gatewayUrl), gatewayUrl, warehouseId: '', catalogs: [] }])
    setOpen(o => ({ ...o, [id]: true }))
    setAdding(false)
    setNewUrl('')
  }
  const removeRow = (id: string) => setRows(currentRows().filter(w => w.id !== id), currentLayers().filter(k => parseLayerKey(k).workspaceId !== id))
  const toggleLayer = (key: string) => {
    const cur = currentLayers()
    setConfig('layers', Immutable(cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]))
  }
  const toggleCatalog = (wsId: string, c: string) => {
    const ws = currentRows().find(w => w.id === wsId)
    if (!ws) return
    const cats = ws.catalogs || []
    updateRow(wsId, { catalogs: cats.includes(c) ? cats.filter(x => x !== c) : [...cats, c] })
  }

  // Tables the author adds or removes on the live-view canvas are saved here too
  React.useEffect(() => onLayerAnnounced(props.id, (action, key) => {
    const cur = currentLayers()
    const next = action === 'add' ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter(k => k !== key)
    if (next.length !== cur.length) setConfig('layers', Immutable(next))
  }), [props.id])

  // After a workspace is signed in: its allowed warehouses, the catalogs the author can see, the directory
  const loadWorkspace = async (ws: Workspace) => {
    try {
      const [w, c, editing] = await Promise.all([fetchWarehouses(ws.gatewayUrl), fetchCatalogNames(ws.gatewayUrl), fetchEditing(ws.gatewayUrl).catch(() => false)])
      setInfo(i => ({ ...i, [ws.id]: { warehouses: w.warehouses, defaultWarehouse: w.default, catalogs: c, editing } }))
      // Warm the tables of the catalogs viewers browse, so opening them in the tree is instant
      setWarehouse(ws.gatewayUrl, ws.warehouseId)
      for (const cat of ws.catalogs) fetchCatalog(ws.gatewayUrl, [cat]).catch(() => {})
      fetchDirectory(ws.gatewayUrl).then(d => setDirectory(prev => {
        const merged = [...prev]
        for (const e of d) if (!merged.some(m => normalizeUrl(m.url) === normalizeUrl(e.url))) merged.push(e)
        return merged
      })).catch(() => {})
    } catch (err) {
      setInfo(i => ({ ...i, [ws.id]: { warehouses: [], defaultWarehouse: null, catalogs: [], error: err.message } }))
    }
  }

  const wsKey = workspaces.map(w => w.id + '=' + w.gatewayUrl).join('|')
  React.useEffect(() => {
    const offs = workspaces.map(ws => {
      const onSignedIn = (user: string) => { setUsers(u => ({ ...u, [ws.gatewayUrl]: user })); loadWorkspace(ws) }
      if (getToken(ws.gatewayUrl)) onSignedIn(getToken(ws.gatewayUrl).user)
      return listenForToken(ws.gatewayUrl, t => {
        if (t) onSignedIn(t.user)
        else setUsers(u => { const next = { ...u }; delete next[ws.gatewayUrl]; return next })
      })
    })
    return () => offs.forEach(off => off())
  }, [wsKey])

  const loadTables = React.useCallback((ws: Workspace, catalog: string) => {
    setWarehouse(ws.gatewayUrl, ws.warehouseId)
    return fetchCatalog(ws.gatewayUrl, [catalog])
  }, [])

  const signedIn = workspaces.filter(ws => users[ws.gatewayUrl])
  const directoryLeft = directory.filter(d => !rows.some(r => normalizeUrl(r.gatewayUrl) === normalizeUrl(d.url)))
  const warehouseLabel = (w: WarehouseInfo) => w.realtime ? `${w.name} (${nls('realtime')})` : `${w.name} (${w.serverless ? 'serverless, ' : ''}${w.size})`
  // "Show selected only": catalogs that hold a selected table, tables filtered in the tree
  const selectedTables = new Set(selected)
  const catalogsWithSelection = (ws: Workspace) => Array.from(new Set(selected
    .map(parseLayerKey).filter(k => k.workspaceId === ws.id).map(k => k.table.split('.')[0])))

  return (
    <div className='widget-setting-databricks-data' css={style}>
      <SettingSection title={nls('map')}>
        <SettingRow>
          <MapWidgetSelector
            useMapWidgetIds={props.useMapWidgetIds}
            onSelect={(ids: string[]) => props.onSettingChange({ id: props.id, useMapWidgetIds: ids })}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={nls('viewers')}>
        <SettingRow label={nls('allowBrowse')}>
          <Switch checked={allowBrowse} aria-label={nls('allowBrowse')} onChange={e => setConfig('allowBrowse', e.target.checked)} />
        </SettingRow>
        <SettingRow flow='wrap'><small className='hint'>{allowBrowse ? nls('allowBrowseOn') : nls('allowBrowseOff')}</small></SettingRow>
        <SettingRow label={nls('allowEditing')}>
          <Switch checked={props.config.allowEditing === true} aria-label={nls('allowEditing')} onChange={e => setConfig('allowEditing', e.target.checked)} />
        </SettingRow>
        <SettingRow flow='wrap'><small className='hint'>{props.config.allowEditing ? nls('allowEditingOn') : nls('allowEditingOff')}</small></SettingRow>
      </SettingSection>

      <SettingSection title={nls('workspaces')}>
        {rows.map(ws => {
          const url = normalizeUrl(ws.gatewayUrl)
          const isOpen = !!open[ws.id]
          const wi = info[ws.id]
          const user = users[url]
          const cf = (catalogFilter[ws.id] || '').toLowerCase()
          return (
            <div key={ws.id} className='ws-card'>
              <div className='ws-head' role='button' tabIndex={0} aria-expanded={isOpen}
                onClick={() => setOpen(o => ({ ...o, [ws.id]: !isOpen }))}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setOpen(o => ({ ...o, [ws.id]: !isOpen }))}>
                {isOpen ? <DownOutlined size={12} /> : <RightOutlined size={12} />}
                <span className='ws-name'>{ws.label || labelFromUrl(url) || nls('newWorkspace')}</span>
                <span className={`ws-status${user ? ' on' : ''}`}>{user ? nls('connected') : nls('notSignedIn')}</span>
              </div>
              {!user && url && (
                <>
                  {signInNotice(url) === 'expired' && <p className='ws-note'>{nls('signInExpired')}</p>}
                  <Button size='sm' type='primary' className='w-100 ws-signin' onClick={() => setBlocked(b => ({ ...b, [url]: !signIn(url) }))}>
                    {nls('signInTo', { workspace: ws.label || labelFromUrl(url) })}
                  </Button>
                  {blocked[url] && <p className='ws-note ws-error' role='alert'>{nls('popupBlocked')}</p>}
                </>
              )}
              {isOpen && (
                <div className='ws-body'>
                  <label className='field'>{nls('workspaceName')}
                    <TextInput size='sm' className='w-100' defaultValue={ws.label} onAcceptValue={v => updateRow(ws.id, { label: v.trim() })} />
                  </label>
                  <label className='field'>{nls('gatewayUrl')}
                    <TextInput size='sm' className='w-100' defaultValue={ws.gatewayUrl}
                      onAcceptValue={v => updateRow(ws.id, { gatewayUrl: normalizeUrl(v) })} />
                  </label>
                  {user && <small className='hint'>{nls('signedInAs', { user })}</small>}
                  {wi?.error && (
                    <div className='retry-row'>
                      <small className='error'>{nls('workspaceFailed', { error: wi.error })}</small>
                      <Button size='sm' type='default' onClick={() => { setInfo(i => { const n = { ...i }; delete n[ws.id]; return n }); loadWorkspace(ws) }}>{nls('retry')}</Button>
                    </div>
                  )}

                  {user && props.config.allowEditing && wi && !wi.error && (
                    <small className='hint'>{wi.editing ? nls('gatewayEditingOn') : nls('gatewayEditingOff')}</small>
                  )}
                  {user && (
                    <label className='field'>{nls('warehouse')}
                      <Select size='sm' className='w-100' aria-label={nls('warehouse')} value={ws.warehouseId || ''}
                        onChange={(e, value) => updateRow(ws.id, { warehouseId: String(value || '') })}>
                        <Option value=''>{nls('warehouseDefault', { name: wi?.warehouses.find(w => w.id === wi?.defaultWarehouse)?.name || nls('gatewayDefault') })}</Option>
                        {(wi?.warehouses || []).filter(w => w.id !== wi?.defaultWarehouse).map(w => <Option key={w.id} value={w.id}>{warehouseLabel(w)}</Option>)}
                      </Select>
                    </label>
                  )}

                  {user && allowBrowse && (
                    <div className='field'>
                      <span>{nls('catalogs')} {ws.catalogs.length > 0 && <b>({ws.catalogs.length})</b>}</span>
                      {(wi?.catalogs.length || 0) > 8 && (
                        <TextInput size='sm' className='w-100' placeholder={nls('filterCatalogs')} aria-label={nls('filterCatalogs')}
                          value={catalogFilter[ws.id] || ''} onChange={e => setCatalogFilter(f => ({ ...f, [ws.id]: e.target.value }))} />
                      )}
                      <div className='catalog-list' role='group' aria-label={nls('catalogs')}>
                        {(wi?.catalogs || []).filter(c => !cf || c.toLowerCase().includes(cf) || ws.catalogs.includes(c)).map(c => (
                          <label key={c} className='check'>
                            <Checkbox checked={ws.catalogs.includes(c)} onChange={() => toggleCatalog(ws.id, c)} />
                            <span>{c}</span>
                          </label>
                        ))}
                      </div>
                      {!ws.catalogs.length && <small className='hint'>{nls('catalogsNone')}</small>}
                    </div>
                  )}

                  <Button size='sm' type='tertiary' className='ws-remove' onClick={() => removeRow(ws.id)}>
                    <TrashOutlined size='s' /> {nls('removeWorkspace')}
                  </Button>
                </div>
              )}
            </div>
          )
        })}

        {!adding
          ? <div className='add-row'><Button size='sm' type='default' className='w-100' onClick={() => setAdding(true)}><PlusOutlined size='s' /> {nls('addWorkspace')}</Button></div>
          : (
            <div className='ws-card add-panel'>
              {directoryLeft.length > 0 && (
                <div className='field'>
                  <span>{nls('fromDirectory')}</span>
                  {directoryLeft.map(d => (
                    <Button key={d.url} size='sm' type='default' className='w-100 dir-entry' title={d.url} onClick={() => addWorkspace(d.name, d.url)}>
                      <PlusOutlined size='s' /> {d.name}
                    </Button>
                  ))}
                </div>
              )}
              <label className='field'>{directoryLeft.length ? nls('orEnterUrl') : nls('enterUrl')}
                <TextInput size='sm' className='w-100' placeholder='https://lakegate-….databricksapps.com' value={newUrl}
                  onChange={e => setNewUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && addWorkspace('', newUrl)} />
              </label>
              <div className='add-actions'>
                <Button size='sm' type='primary' disabled={!/^https:\/\//.test(normalizeUrl(newUrl))} onClick={() => addWorkspace('', newUrl)}>{nls('add')}</Button>
                <Button size='sm' type='tertiary' onClick={() => { setAdding(false); setNewUrl('') }}>{nls('cancel')}</Button>
              </div>
              {!directory.length && <small className='hint'>{nls('directoryLater')}</small>}
            </div>
            )}
      </SettingSection>

      <SettingSection title={selected.length ? nls('startLayersCount', { n: String(selected.length) }) : nls('startLayers')}>
        <SettingRow flow='wrap'>
          <div className='w-100'>
            {!signedIn.length && <small className='hint'>{nls('startLayersHint')}</small>}
            {signedIn.length > 0 && (
              <React.Fragment>
                <small className='hint' style={{ marginBottom: 6 }}>{nls('startLayersFrom')}</small>
                <TextInput size='sm' className='w-100' placeholder={nls('filterTables')} aria-label={nls('filterTables')}
                  value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
                <label className='toggle-row'>
                  {nls('showSelectedOnly')}
                  <Switch checked={selectedOnly} disabled={!selected.length} aria-label={nls('showSelectedOnly')} onChange={e => setSelectedOnly(e.target.checked)} />
                </label>
                <div className='tree-box'>
                  <TableTree
                    workspaces={selectedOnly ? signedIn.filter(ws => catalogsWithSelection(ws).length) : signedIn}
                    catalogsFor={ws => selectedOnly ? catalogsWithSelection(ws) : (info[ws.id]?.catalogs || [])}
                    loadTables={loadTables}
                    filter={filter}
                    catalogBadge={(ws, c) => allowBrowse && ws.catalogs.includes(c) ? <span className='badge-viewers'>{nls('viewersBadge')}</span> : null}
                    expandAll={selectedOnly}
                    tableFilter={selectedOnly ? (ws, t) => selectedTables.has(layerKey(ws.id, t.table)) : undefined}
                    renderTable={(ws, t: CatalogTable) => {
                      const key = layerKey(ws.id, t.table)
                      return (
                        <label className='check tree-check'>
                          <Checkbox checked={selectedTables.has(key)} onChange={() => toggleLayer(key)} />
                          <span>{t.name}</span>
                        </label>
                      )
                    }}
                    messages={{
                      loading: nls('loadingCatalog'),
                      failed: error => nls('catalogFailed', { error }),
                      empty: nls('noTablesInCatalog'),
                      tablesIn: n => nls('tableCount', { n: String(n) })
                    }}
                  />
                </div>
              </React.Fragment>
            )}
          </div>
        </SettingRow>
      </SettingSection>
    </div>
  )
}

const style = css`
  .hint { color: var(--sys-color-surface-paper-hint); display: block; }
  .error { color: var(--sys-color-error-main); display: block; }
  .ws-card { border: 1px solid var(--sys-color-divider-secondary); border-radius: 4px; margin: 0 0 8px; padding: 6px 8px; }
  .ws-head { display: flex; align-items: center; gap: 6px; cursor: pointer; min-height: 26px; }
  .ws-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-status { font-size: 0.75rem; color: var(--sys-color-surface-paper-hint); white-space: nowrap; }
  .ws-status.on { color: var(--sys-color-success-main); }
  .ws-signin { margin: 6px 0 2px; }
  .ws-note { font-size: 12px; margin: 4px 0; color: var(--sys-color-surface-paper-hint); }
  .ws-note.ws-error { color: var(--sys-color-error-main); }
  .ws-body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 0; font-size: 0.8125rem; }
  .catalog-list { max-height: 180px; overflow: auto; border: 1px solid var(--sys-color-divider-tertiary); border-radius: 3px; padding: 2px 6px; }
  .check { display: flex; align-items: center; gap: 6px; margin: 2px 0; cursor: pointer; font-size: 0.75rem; min-width: 0; }
  .check span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-check { margin: 0; width: 100%; }
  .ws-remove { align-self: flex-start; padding-left: 0; }
  .add-row { margin: 0; }
  .add-panel { display: flex; flex-direction: column; gap: 8px; }
  .dir-entry { justify-content: flex-start; margin-top: 4px; }
  .add-actions { display: flex; gap: 6px; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 0 0 6px; font-size: 0.75rem; }
  .tree-box { max-height: 380px; overflow: auto; }
  .retry-row { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  .badge-viewers { font-size: 0.6875rem; color: var(--sys-color-success-main); border: 1px solid var(--sys-color-success-main); border-radius: 8px; padding: 0 6px; margin-left: 4px; white-space: nowrap; }
`
