import { useEffect, useRef, useState } from 'react'
import { layerPath } from '../api'

// ArcGIS Maps SDK 5.0 from Esri's CDN, loaded on first use. Layer requests are same-origin with the
// gateway, so the Databricks Apps session cookie authenticates them.
declare global { interface Window { $arcgis?: { import: (m: string[]) => Promise<any[]> } } }

let sdk: Promise<void> | null = null
function loadSdk (): Promise<void> {
  if (window.$arcgis) return Promise.resolve()
  if (!sdk) {
    sdk = new Promise((resolve, reject) => {
      const css = document.createElement('link')
      css.rel = 'stylesheet'
      css.href = 'https://js.arcgis.com/5.0/esri/themes/light/main.css'
      document.head.appendChild(css)
      const s = document.createElement('script')
      s.type = 'module'
      s.src = 'https://js.arcgis.com/5.0/'
      s.onload = () => { const wait = () => window.$arcgis ? resolve() : setTimeout(wait, 50); wait() }
      s.onerror = () => reject(new Error('Could not load the ArcGIS Maps SDK'))
      document.head.appendChild(s)
    })
  }
  return sdk
}

// table: a FeatureServer layer; ogc: an OGC API – Features collection (drawn with OGCFeatureLayer)
export function MapPreview ({ table, ogc }: { table: string, ogc?: { url: string, collectionId: string } }) {
  const el = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Loading map…')

  useEffect(() => {
    let view: any
    let cancelled = false
    setStatus('Loading map…')
    ;(async () => {
      try {
        await loadSdk()
        const [ArcMap, MapView, FeatureLayer, OGCFeatureLayer] = await window.$arcgis!.import([
          '@arcgis/core/Map.js', '@arcgis/core/views/MapView.js', '@arcgis/core/layers/FeatureLayer.js', '@arcgis/core/layers/OGCFeatureLayer.js'
        ])
        if (cancelled || !el.current) return
        const popupTemplate = { title: table.split('.').pop(), content: [{ type: 'fields' }] }
        const layer = ogc
          ? new OGCFeatureLayer({ url: ogc.url, collectionId: ogc.collectionId, outFields: ['*'], popupTemplate })
          : new FeatureLayer({ url: `${location.origin}${layerPath(table)}`, outFields: ['*'], popupTemplate })
        view = new MapView({ container: el.current, map: new ArcMap({ basemap: 'gray-vector', layers: [layer] }), center: [-98, 38], zoom: 3 })
        setStatus('Loading layer…')
        await layer.load()
        if (cancelled) return
        if (layer.fullExtent) await view.goTo(layer.fullExtent.expand(1.15)).catch(() => {})
        const lv = await view.whenLayerView(layer)
        setStatus('Drawing…')
        const watch = () => { if (!lv.updating) setStatus('') ; else setTimeout(watch, 300) }
        watch()
      } catch (err: any) {
        if (!cancelled) setStatus(`Map failed: ${err.message}`)
      }
    })()
    return () => { cancelled = true; view?.destroy() }
  }, [table, ogc?.url, ogc?.collectionId])

  return (
    <div className='map-preview'>
      <div ref={el} className='map-preview-view' />
      {status && <div className='map-preview-status'>{status}</div>}
    </div>
  )
}
