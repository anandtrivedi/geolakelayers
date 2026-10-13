import { React, Immutable } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { Button, Checkbox, Switch, TextInput } from 'jimu-ui'
import type { IMConfig, CatalogTable } from '../config'
import { getToken, signIn, listenForToken, fetchCatalog } from '../auth'
import { onLayerAnnounced } from '../sync'
import defaultMessages from './translations/default'

export default function Setting (props: AllWidgetSettingProps<IMConfig>) {
  const nls = (id: keyof typeof defaultMessages, values?: { [k: string]: string }) =>
    props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] }, values)
  const gateway = (props.config.gatewayUrl || '').replace(/\/$/, '')
  const selected: string[] = props.config.layers ? props.config.layers.asMutable() : []

  const [user, setUser] = React.useState<string>(getToken(gateway)?.user || null)
  const [tables, setTables] = React.useState<CatalogTable[]>([])
  const [filter, setFilter] = React.useState('')
  const [status, setStatus] = React.useState('')

  const set = (key: 'gatewayUrl' | 'catalogFilter', value: string) => {
    props.onSettingChange({ id: props.id, config: props.config.set(key, value.trim()) })
  }

  const setLayers = (layers: string[]) => {
    props.onSettingChange({ id: props.id, config: props.config.set('layers', Immutable(layers)) })
  }

  // Tables the author adds or removes on the live-view canvas are saved here too
  const configRef = React.useRef(props.config)
  configRef.current = props.config
  React.useEffect(() => onLayerAnnounced(props.id, (action, table) => {
    const cur: string[] = configRef.current.layers ? configRef.current.layers.asMutable() : []
    const next = action === 'add' ? (cur.includes(table) ? cur : [...cur, table]) : cur.filter(t => t !== table)
    if (next.length !== cur.length) props.onSettingChange({ id: props.id, config: configRef.current.set('layers', Immutable(next)) })
  }), [props.id])

  const toggle = (table: string) => {
    setLayers(selected.includes(table) ? selected.filter(t => t !== table) : [...selected, table])
  }

  const load = React.useCallback(async () => {
    setStatus(nls('loadingCatalog'))
    try {
      const list = await fetchCatalog(gateway, props.config.catalogFilter)
      setTables(list)
      setStatus('')
    } catch (err) {
      setStatus(nls('catalogFailed', { error: err.message }))
    }
  }, [gateway, props.config.catalogFilter])

  React.useEffect(() => {
    if (!gateway) return
    const off = listenForToken(gateway, t => { setUser(t.user); load() })
    if (getToken(gateway)) load()
    return off
  }, [gateway, load])

  const shown = tables.filter(t => t.table.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)

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
      <SettingSection title={nls('gateway')}>
        <SettingRow flow='wrap' label={nls('gatewayUrl')}>
          <TextInput size='sm' className='w-100' defaultValue={props.config.gatewayUrl} onAcceptValue={v => set('gatewayUrl', v)} />
        </SettingRow>
        <SettingRow label={nls('allowBrowse')}>
          <Switch checked={props.config.allowBrowse !== false}
            onChange={e => props.onSettingChange({ id: props.id, config: props.config.set('allowBrowse', e.target.checked) })} />
        </SettingRow>
        <SettingRow flow='wrap' label={nls('catalogFilter')}>
          <TextInput size='sm' className='w-100' defaultValue={props.config.catalogFilter} onAcceptValue={v => set('catalogFilter', v)} />
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
                    <Button size='sm' type='tertiary' aria-label={nls('removeStartLayer', { table: t })} onClick={() => toggle(t)}>×</Button>
                  </div>
                ))}
              </div>
            )}
            {!user && (
              <div>
                <small style={{ display: 'block', marginBottom: 6 }}>{nls('startLayersHint')}</small>
                <Button size='sm' type='primary' disabled={!gateway} onClick={() => signIn(gateway)}>{nls('signInDatabricks')}</Button>
              </div>
            )}
            {user && <small style={{ display: 'block', marginBottom: 6 }}>{nls('signedInAs', { user })}</small>}
            {status && <small style={{ display: 'block', marginBottom: 6 }}>{status}</small>}
            {tables.length > 0 && (
              <React.Fragment>
                <TextInput size='sm' className='w-100' placeholder={nls('filterTables')} value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
                <div style={{ maxHeight: 320, overflow: 'auto' }}>
                  {shown.map(t => (
                    <label key={t.table} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', margin: '3px 0', cursor: 'pointer' }}>
                      <Checkbox checked={selected.includes(t.table)} onChange={() => toggle(t.table)} />
                      <span style={{ fontSize: 12, wordBreak: 'break-all' }}>{t.schema}.<b>{t.name}</b></span>
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
