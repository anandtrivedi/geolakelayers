import { React, Immutable } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { Button, Checkbox, MultiSelect, MultiSelectItem, Option, Select, Switch, TextInput } from 'jimu-ui'
import { TrashOutlined } from 'jimu-icons/outlined/editor/trash'
import { PlusOutlined } from 'jimu-icons/outlined/editor/plus'
import type { IMConfig, CatalogTable, Workspace } from '../config'
import { getToken, signIn, listenForToken, fetchCatalog, fetchCatalogNames, fetchWarehouses, fetchDirectory, setWarehouse } from '../auth'
import type { WarehouseInfo } from '../auth'
import { workspacesOf, labelFromUrl, newWorkspaceId, normalizeUrl, layerKey, parseLayerKey } from '../workspaces'
import { TableTree } from '../table-tree'
import { onLayerAnnounced } from '../sync'
import defaultMessages from './translations/default'

/*
  Settings follow the author's path: map -> Databricks workspaces (a gateway URL each, with its own
  sign-in) -> per workspace: warehouse and the catalogs viewers can browse -> what viewers may do ->
  layers that load when the app opens (workspace ▸ catalog ▸ schema ▸ table). Everything after sign-in
  is filled from each gateway with the author's own permissions.
*/
interface WorkspaceInfo { warehouses: WarehouseInfo[], defaultWarehouse: string | null, catalogs: string[], error?: string }

export default function Setting (props: AllWidgetSettingProps<IMConfig>) {
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)

  // All rows, including ones still missing a URL (workspacesOf drops those for the runtime)
  const rows: Workspace[] = props.config.workspaces ? props.config.workspaces.asMutable({ deep: true }) as Workspace[] : []
  const workspaces = workspacesOf(props.config)
  const selected: string[] = props.config.layers ? props.config.layers.asMutable() : []

  const [users, setUsers] = React.useState<{ [id: string]: string }>({})
  const [info, setInfo] = React.useState<{ [id: string]: WorkspaceInfo }>({})
  const [activeId, setActiveId] = React.useState<string>(rows[0]?.id)
  const [filter, setFilter] = React.useState('')
  const [directory, setDirectory] = React.useState<Array<{ name: string, url: string }>>([])
  // The start-up layer tree shows the catalogs picked for viewers; this widens it to every catalog
  const [allCatalogs, setAllCatalogs] = React.useState(false)
  const active = workspaces.find(w => w.id === activeId) || workspaces[0]

  const setConfig = (key: string, value: any) => {
    props.onSettingChange({ id: props.id, config: props.config.set(key, value) })
  }
  const setRows = (next: Workspace[], layers?: string[]) => {
    let config = props.config.set('workspaces', Immutable(next))
    if (layers) config = config.set('layers', Immutable(layers))
    props.onSettingChange({ id: props.id, config })
  }
  const updateRow = (id: string, patch: Partial<Workspace>) => setRows(rows.map(w => w.id === id ? { ...w, ...patch } : w))
  const addRow = (label = '', gatewayUrl = '') => {
    const id = newWorkspaceId(rows)
    setRows([...rows, { id, label, gatewayUrl, warehouseId: '', catalogs: [] }])
    setActiveId(id)
  }
  const removeRow = (id: string) => setRows(rows.filter(w => w.id !== id), selected.filter(k => parseLayerKey(k).workspaceId !== id))
  const toggleLayer = (key: string) => setConfig('layers', Immutable(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key]))

  // Tables the author adds or removes on the live-view canvas are saved here too
  const configRef = React.useRef(props.config)
  configRef.current = props.config
  React.useEffect(() => onLayerAnnounced(props.id, (action, key) => {
    const cur: string[] = configRef.current.layers ? configRef.current.layers.asMutable() : []
    const next = action === 'add' ? (cur.includes(key) ? cur : [...cur, key]) : cur.filter(k => k !== key)
    if (next.length !== cur.length) props.onSettingChange({ id: props.id, config: configRef.current.set('layers', Immutable(next)) })
  }), [props.id])

  // After a workspace is signed in: its allowed warehouses and the catalogs the author can see
  const loadWorkspace = async (ws: Workspace) => {
    try {
      const [w, c] = await Promise.all([fetchWarehouses(ws.gatewayUrl), fetchCatalogNames(ws.gatewayUrl)])
      setInfo(i => ({ ...i, [ws.id]: { warehouses: w.warehouses, defaultWarehouse: w.default, catalogs: c } }))
      // The gateway's directory of other workspaces, offered under "Add from directory"
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
      const signedIn = (user: string) => { setUsers(u => ({ ...u, [ws.id]: user })); loadWorkspace(ws) }
      if (getToken(ws.gatewayUrl)) signedIn(getToken(ws.gatewayUrl).user)
      return listenForToken(ws.gatewayUrl, t => signedIn(t.user))
    })
    return () => offs.forEach(off => off())
  }, [wsKey])

  const loadTables = React.useCallback((ws: Workspace, catalog: string) => {
    setWarehouse(ws.gatewayUrl, ws.warehouseId)
    return fetchCatalog(ws.gatewayUrl, [catalog])
  }, [])

  const signedIn = workspaces.filter(ws => users[ws.id])
  const warehouseLabel = (w: WarehouseInfo) => `${w.name} (${w.serverless ? 'serverless, ' : ''}${w.size})`
  const labelOf = (id: string) => workspaces.find(w => w.id === id)?.label || id

  return (
    <div className='widget-setting-databricks-data'>
      <SettingSection title={nls('map')}>
        <SettingRow>
          <MapWidgetSelector
            useMapWidgetIds={props.useMapWidgetIds}
            onSelect={(ids: string[]) => props.onSettingChange({ id: props.id, useMapWidgetIds: ids })}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={nls('workspaces')}>
        {rows.map(ws => {
          const url = normalizeUrl(ws.gatewayUrl)
          return (
            <SettingRow key={ws.id} flow='wrap'>
              <div className='w-100' style={{ borderBottom: '1px solid var(--sys-color-divider-secondary)', paddingBottom: 8 }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                  <TextInput size='sm' style={{ flex: 1 }} placeholder={nls('workspaceName')} aria-label={nls('workspaceName')}
                    defaultValue={ws.label} onAcceptValue={v => updateRow(ws.id, { label: v.trim() })} />
                  <Button size='sm' type='tertiary' icon title={nls('removeWorkspace')} aria-label={nls('removeWorkspace')}
                    onClick={() => removeRow(ws.id)}><TrashOutlined size='s' /></Button>
                </div>
                <TextInput size='sm' className='w-100' placeholder={nls('gatewayUrl')} aria-label={nls('gatewayUrl')}
                  defaultValue={ws.gatewayUrl} style={{ marginBottom: 4 }}
                  onAcceptValue={v => {
                    const next = normalizeUrl(v)
                    updateRow(ws.id, { gatewayUrl: next, label: ws.label || (next ? labelFromUrl(next) : '') })
                  }} />
                {url && (users[ws.id]
                  ? <small>{nls('signedInAs', { user: users[ws.id] })}</small>
                  : <Button size='sm' type='primary' onClick={() => signIn(url)}>{nls('signInTo', { workspace: ws.label || labelFromUrl(url) })}</Button>)}
                {info[ws.id]?.error && <small style={{ display: 'block', color: 'var(--sys-color-error-main)' }}>{nls('workspaceFailed', { error: info[ws.id].error })}</small>}
              </div>
            </SettingRow>
          )
        })}
        {directory.filter(d => !rows.some(r => normalizeUrl(r.gatewayUrl) === normalizeUrl(d.url))).length > 0 && (
          <SettingRow flow='wrap' label={nls('addFromDirectory')}>
            <Select size='sm' className='w-100' value='' aria-label={nls('addFromDirectory')}
              onChange={(e, value) => { const d = directory.find(x => x.url === value); if (d) addRow(d.name, normalizeUrl(d.url)) }}>
              <Option value=''>{nls('pickWorkspace')}</Option>
              {directory.filter(d => !rows.some(r => normalizeUrl(r.gatewayUrl) === normalizeUrl(d.url)))
                .map(d => <Option key={d.url} value={d.url}>{d.name}</Option>)}
            </Select>
          </SettingRow>
        )}
        <SettingRow>
          <Button size='sm' type='tertiary' onClick={() => addRow()}><PlusOutlined size='s' /> {nls('addWorkspace')}</Button>
        </SettingRow>
        <SettingRow flow='wrap'><small>{nls('workspacesHint')}</small></SettingRow>
      </SettingSection>

      {active && users[active.id] && (
        <SettingSection title={nls('workspaceSettings')}>
          {workspaces.length > 1 && (
            <SettingRow flow='wrap' label={nls('configureWorkspace')}>
              <Select size='sm' className='w-100' value={active.id} aria-label={nls('configureWorkspace')}
                onChange={(e, value) => setActiveId(String(value))}>
                {workspaces.map(w => <Option key={w.id} value={w.id}>{w.label}{users[w.id] ? '' : ` (${nls('notSignedIn')})`}</Option>)}
              </Select>
            </SettingRow>
          )}
          <SettingRow flow='wrap' label={nls('warehouse')}>
            <Select size='sm' className='w-100' aria-label={nls('warehouse')} value={active.warehouseId || ''}
              onChange={(e, value) => updateRow(active.id, { warehouseId: String(value || '') })}>
              <Option value=''>{nls('warehouseDefault', { name: info[active.id]?.warehouses.find(w => w.id === info[active.id]?.defaultWarehouse)?.name || nls('gatewayDefault') })}</Option>
              {(info[active.id]?.warehouses || []).filter(w => w.id !== info[active.id]?.defaultWarehouse).map(w => <Option key={w.id} value={w.id}>{warehouseLabel(w)}</Option>)}
            </Select>
          </SettingRow>
          <SettingRow flow='wrap'><small>{nls('warehouseHint')}</small></SettingRow>
          <SettingRow flow='wrap' label={nls('catalogs')}>
            <MultiSelect size='sm' className='w-100' aria-label={nls('catalogs')}
              placeholder={nls('pickCatalogs')}
              values={active.catalogs}
              displayByValues={values => values.length ? values.join(', ') : nls('pickCatalogs')}
              onChange={(value, values) => updateRow(active.id, { catalogs: values.map(String) })}>
              {(info[active.id]?.catalogs || []).map(c => <MultiSelectItem key={c} value={c} label={c} />)}
            </MultiSelect>
          </SettingRow>
          <SettingRow flow='wrap'><small>{nls('catalogsHint')}</small></SettingRow>
        </SettingSection>
      )}

      <SettingSection title={nls('viewers')}>
        <SettingRow label={nls('allowBrowse')}>
          <Switch checked={props.config.allowBrowse !== false} aria-label={nls('allowBrowse')}
            onChange={e => setConfig('allowBrowse', e.target.checked)} />
        </SettingRow>
      </SettingSection>

      <SettingSection title={nls('startLayers')}>
        <SettingRow flow='wrap'>
          <div className='w-100'>
            {selected.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ marginBottom: 4 }}>{nls('selected', { n: String(selected.length) })}</div>
                {selected.map(k => {
                  const { workspaceId, table } = parseLayerKey(k)
                  return (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                      <small style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{workspaces.length > 1 ? `${labelOf(workspaceId)} · ` : ''}{table}</small>
                      <Button size='sm' type='tertiary' aria-label={nls('removeStartLayer', { table })} onClick={() => toggleLayer(k)}>×</Button>
                    </div>
                  )
                })}
              </div>
            )}
            {!signedIn.length && <small>{nls('startLayersHint')}</small>}
            {signedIn.length > 0 && (
              <React.Fragment>
                <TextInput size='sm' className='w-100' placeholder={nls('filterTables')} aria-label={nls('filterTables')}
                  value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
                {signedIn.some(ws => ws.catalogs.length) && (
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, margin: '0 0 6px', fontSize: 12 }}>
                    {nls('showAllCatalogs')}
                    <Switch checked={allCatalogs} aria-label={nls('showAllCatalogs')} onChange={e => setAllCatalogs(e.target.checked)} />
                  </label>
                )}
                <div style={{ maxHeight: 360, overflow: 'auto' }}>
                  <TableTree
                    workspaces={signedIn}
                    catalogsFor={ws => (allCatalogs || !ws.catalogs.length) ? (info[ws.id]?.catalogs || []) : ws.catalogs}
                    loadTables={loadTables}
                    filter={filter}
                    renderTable={(ws, t: CatalogTable) => {
                      const key = layerKey(ws.id, t.table)
                      return (
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, cursor: 'pointer', width: '100%' }}>
                          <Checkbox checked={selected.includes(key)} onChange={() => toggleLayer(key)} />
                          <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
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
