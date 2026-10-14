import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ServerLoad } from '../api'

const gb = (n: number) => `${(n / 1073741824).toFixed(1)} GB`

// How busy the gateway is: its memory against the Node heap limit, and requests being answered. Polls while the tab is visible.
export function LoadGauge () {
  const [load, setLoad] = useState<ServerLoad | null>(null)
  useEffect(() => {
    let timer: number | undefined
    const tick = () => {
      if (document.visibilityState === 'visible') api.load().then(setLoad).catch(() => setLoad(null))
      timer = window.setTimeout(tick, 5000)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])
  if (!load) return null
  const share = Math.max(load.heapUsed / load.heapLimit, load.memoryLimit ? load.rss / load.memoryLimit : 0)
  const level = share > 0.85 ? 'high' : share > 0.65 ? 'busy' : 'ok'
  const title = [
    `Memory: ${gb(load.heapUsed)} of ${gb(load.heapLimit)} heap; ${gb(load.rss)} in use${load.memoryLimit ? ` of ${gb(load.memoryLimit)} for the app` : ''}`,
    `CPU: ${Math.round(load.cpu * 100)}% of ${load.cores} cores`,
    `Requests being answered: ${load.inFlight}`,
    `Up ${Math.round(load.uptime / 60)} min`
  ].join('\n')
  return (
    <span className={`load-gauge ${level}`} title={title} aria-label={`Gateway load. ${title}`}>
      <span className='load-label'>Server</span>
      <span className='load-bar'><span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} /></span>
      <span className='load-num load-pct'>{Math.round(share * 100)}%</span>
      <span className='load-num'>{load.inFlight} {load.inFlight === 1 ? 'request' : 'requests'}</span>
    </span>
  )
}
