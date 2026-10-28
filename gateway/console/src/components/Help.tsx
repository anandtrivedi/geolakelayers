import { Architecture } from './Architecture'
import { Drawer } from './Drawer'
import { Guide, Install } from './Guide'

export type HelpPage = 'guide' | 'install'

// Help: how the pieces fit, then the guide (docs/guide.md) or the install walkthrough (docs/install.md)
export function Help ({ page, onPage, onClose, widgetSource }: { page: HelpPage | null, onPage: (p: HelpPage) => void, onClose: () => void, widgetSource?: string | null }) {
  return (
    <Drawer open={!!page} title='Help' onClose={onClose} wide>
      <div className='help-pages' role='tablist'>
        <button role='tab' aria-selected={page === 'guide'} className={`tab${page === 'guide' ? ' active' : ''}`} onClick={() => onPage('guide')}>How it works</button>
        <button role='tab' aria-selected={page === 'install'} className={`tab${page === 'install' ? ' active' : ''}`} onClick={() => onPage('install')}>Install, step by step</button>
      </div>
      {page === 'install'
        ? <Install />
        : (
          <>
            <p className='muted small'>
              Map clients call this gateway; it runs each query in Databricks with the caller's identity. Nothing is copied
              to ArcGIS or the client.
            </p>
            <Architecture />
            <p className='small'><a href='/dataflow.png' target='_blank' rel='noreferrer'>The full data flow, step by step</a> (opens the detailed diagram)</p>
            <Guide widgetSource={widgetSource} />
          </>
          )}
    </Drawer>
  )
}
