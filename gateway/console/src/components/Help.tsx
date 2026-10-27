import { Architecture } from './Architecture'
import { Drawer } from './Drawer'
import { Guide } from './Guide'

// Help: how the pieces fit, then the guide (docs/guide.md)
export function Help ({ open, onClose, widgetSource }: { open: boolean, onClose: () => void, widgetSource?: string | null }) {
  return (
    <Drawer open={open} title='Help' onClose={onClose} wide>
      <h3>How it works</h3>
      <p className='muted small'>
        Map clients call this gateway; it runs each query in Databricks with the caller's identity. Nothing is copied
        to ArcGIS or the client.
      </p>
      <Architecture />
      <Guide widgetSource={widgetSource} />
    </Drawer>
  )
}
