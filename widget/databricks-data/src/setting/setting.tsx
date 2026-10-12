import { React } from 'jimu-core'
import type { AllWidgetSettingProps } from 'jimu-for-builder'
import { MapWidgetSelector, SettingSection, SettingRow } from 'jimu-ui/advanced/setting-components'
import { TextInput } from 'jimu-ui'
import type { IMConfig } from '../config'
import defaultMessages from './translations/default'

export default function Setting (props: AllWidgetSettingProps<IMConfig>) {
  const nls = (id: keyof typeof defaultMessages) => props.intl.formatMessage({ id, defaultMessage: defaultMessages[id] })

  const set = (key: 'gatewayUrl' | 'catalogFilter', value: string) => {
    props.onSettingChange({ id: props.id, config: props.config.set(key, value.trim()) })
  }

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
        <SettingRow flow='wrap' label={nls('catalogFilter')}>
          <TextInput size='sm' className='w-100' defaultValue={props.config.catalogFilter} onAcceptValue={v => set('catalogFilter', v)} />
        </SettingRow>
      </SettingSection>
    </div>
  )
}
