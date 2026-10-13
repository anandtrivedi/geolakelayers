import { React, Immutable } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { Button, Checkbox, Option, Select, Switch, TextInput } from 'jimu-ui'
import type { IMConfig, CatalogTable } from '../config'
import { getToken, signIn, listenForToken, fetchCatalog, fetchCatalogNames, fetchWarehouses, setWarehouse } from '../auth'
import type { WarehouseInfo } from '../auth'
import { onLayerAnnounced } from '../sync'
import defaultMessages from './translations/default'

/*
  Settings follow the author's path: map -> Databricks workspace (gateway) and sign-in -> warehouse ->
  catalogs -> what viewers may do -> layers that load when the app opens. Everything after sign-in is
  filled from the gateway with the author's own permissions.
*/
export default function Setting (props: AllWidgetSettingProps<IMConfig>) {
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)
  const gateway = (props.config.gatewayUrl || '').replace(/\/$/, '')
  const selected: string[] = props.config.layers ? props.config.layers.asMutable() : []
  const catalogs: string[] = props.config.catalogs ? props.config.catalogs.asMutable() : []

  const [user, setUser] = React.useState<string>(getToken(gateway)?.user || null)
  const [warehouses, setWarehouses] = React.useState<WarehouseInfo[]>([])
  const [defaultWarehouse, setDefaultWarehouse] = React.useState<string>(null)
  const [catalogNames, setCatalogNames] = React.useState<string[]>([])
  const [tables, setTables] = React.useState<CatalogTable[]>([])
  const [filter, setFilter] = React.useState('')
  const [catalogFilter, setCatalogFilter] = React.useState('')
  const [status, setStatus] = React.useState('')

  const setConfig = (key: string, value: any) => {
    props.onSettingChange({ id: props.id, config: props.config.set(key, value) })
  }
  const setLayers = (layers: string[]) => setConfig('layers', Immutable(layers))
  const toggleLayer = (table: string) => {
    setLayers(selected.includes(table) ? selected.filter(t => t !== table) : [...selected, table])
  }
  const toggleCatalog = (c: string) => {
    setConfig('catalogs', Immutable(catalogs.includes(c) ? catalogs.filter(x => x !== c) : [...catalogs, c]))
  }

  // Tables the author adds or removes on the live-view canvas are saved here too
  const configRef = React.useRef(props.config)
  configRef.current = props.config
  React.useEffect(() => onLayerAnnounced(props.id, (action, table) => {
    const cur: string[] = configRef.current.layers ? configRef.current.layers.asMutable() : []
    const next = action === 'add' ? (cur.includes(table) ? cur : [...cur, table]) : cur.filter(t => t !== table)
    if (next.length !== cur.length) props.onSettingChange({ id: props.id, config: configRef.current.set('layers', Immutable(next)) })
  }), [props.id])

  // After sign-in: warehouses and catalogs the author can use
  const loadWorkspace = React.useCallback(async () => {
    try {
      const [w, c] = await Promise.all([fetchWarehouses(gateway), fetchCatalogNames(gateway)])
      setWarehouses(w.warehouses)
      setDefaultWarehouse(w.default)
      setCatalogNames(c)
    } catch (err) {
      setStatus(nls('workspaceFailed', { error: err.message }))
    }
  }, [gateway])

  // Tables in the chosen catalogs, for the start-up layer picker
  const loadTables = React.useCallback(async () => {
    if (!getToken(gateway)) return
    if (!catalogs.length) { setTables([]); return }
    setStatus(nls('loadingCatalog'))
    try {
      setWarehouse(gateway, props.config.warehouseId || '')
      setTables(await fetchCatalog(gateway, catalogs))
      setStatus('')
    } catch (err) {
      setStatus(nls('catalogFailed', { error: err.message }))
    }
  }, [gateway, catalogs.join(','), props.config.warehouseId])

  React.useEffect(() => {
    if (!gateway) return
    const off = listenForToken(gateway, t => { setUser(t.user); loadWorkspace() })
    if (getToken(gateway)) loadWorkspace()
    return off
  }, [gateway, loadWorkspace])

  React.useEffect(() => {
    if (user) loadTables()
  }, [user, loadTables])

  const shownTables = tables.filter(t => t.table.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)
  const shownCatalogs = catalogNames.filter(c => c.toLowerCase().includes(catalogFilter.toLowerCase()))
  const warehouseLabel = (w: WarehouseInfo) => `${w.name} (${w.serverless ? 'serverless, ' : ''}${w.size})`

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

      <SettingSection title={nls('workspace')}>
        <SettingRow flow='wrap' label={nls('gatewayUrl')}>
          <TextInput size='sm' className='w-100' defaultValue={props.config.gatewayUrl}
            onAcceptValue={v => setConfig('gatewayUrl', v.trim())} />
        </SettingRow>
        <SettingRow flow='wrap'>
          {user
            ? <small>{nls('signedInAs', { user })}</small>
            : (
              <div className='w-100'>
                <small style={{ display: 'block', marginBottom: 6 }}>{nls('signInHint')}</small>
                <Button size='sm' type='primary' disabled={!gateway} onClick={() => signIn(gateway)}>{nls('signInDatabricks')}</Button>
              </div>
              )}
        </SettingRow>
        {status && <SettingRow flow='wrap'><small role='status'>{status}</small></SettingRow>}
      </SettingSection>

      {user && (
        <SettingSection title={nls('warehouse')}>
          <SettingRow flow='wrap'>
            <Select size='sm' className='w-100' aria-label={nls('warehouse')} value={props.config.warehouseId || ''}
              onChange={(e, value) => setConfig('warehouseId', String(value || ''))}>
              <Option value=''>{nls('warehouseDefault', { name: warehouses.find(w => w.id === defaultWarehouse)?.name || nls('gatewayDefault') })}</Option>
              {warehouses.filter(w => w.id !== defaultWarehouse).map(w => <Option key={w.id} value={w.id}>{warehouseLabel(w)}</Option>)}
            </Select>
          </SettingRow>
          <SettingRow flow='wrap'><small>{nls('warehouseHint')}</small></SettingRow>
        </SettingSection>
      )}

      {user && (
        <SettingSection title={nls('catalogs')}>
          <SettingRow flow='wrap'>
            <div className='w-100'>
              {catalogs.length > 0 && <small style={{ display: 'block', marginBottom: 4 }}>{nls('selected', { n: String(catalogs.length) })}: {catalogs.join(', ')}</small>}
              <TextInput size='sm' className='w-100' placeholder={nls('filterCatalogs')} aria-label={nls('filterCatalogs')}
                value={catalogFilter} onChange={e => setCatalogFilter(e.target.value)} style={{ marginBottom: 6 }} />
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                {shownCatalogs.map(c => (
                  <label key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '3px 0', cursor: 'pointer' }}>
                    <Checkbox checked={catalogs.includes(c)} onChange={() => toggleCatalog(c)} />
                    <span style={{ fontSize: 12, wordBreak: 'break-all' }}>{c}</span>
                  </label>
                ))}
              </div>
            </div>
          </SettingRow>
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
                {selected.map(t => (
                  <div key={t} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                    <small style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</small>
                    <Button size='sm' type='tertiary' aria-label={nls('removeStartLayer', { table: t })} onClick={() => toggleLayer(t)}>×</Button>
                  </div>
                ))}
              </div>
            )}
            {!user && <small>{nls('startLayersHint')}</small>}
            {user && !catalogs.length && <small>{nls('pickCatalogsFirst')}</small>}
            {tables.length > 0 && (
              <React.Fragment>
                <TextInput size='sm' className='w-100' placeholder={nls('filterTables')} aria-label={nls('filterTables')}
                  value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
                <div style={{ maxHeight: 320, overflow: 'auto' }}>
                  {shownTables.map(t => (
                    <label key={t.table} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', margin: '3px 0', cursor: 'pointer' }}>
                      <Checkbox checked={selected.includes(t.table)} onChange={() => toggleLayer(t.table)} />
                      <span style={{ fontSize: 12, wordBreak: 'break-all' }}>{t.catalog}.{t.schema}.<b>{t.name}</b></span>
                    </label>
                  ))}
                </div>
              </React.Fragment>
            )}
          </div>
        </SettingRow>
      </SettingSection>
    </div>
  )
}
