/*
  Builder-only link between the runtime (live-view canvas) and the settings panel, which are
  separate same-origin windows. The runtime can't write the widget's saved config; the settings
  panel can, so the runtime announces layers the author adds or removes and the panel saves them.
*/
type LayerAction = 'add' | 'remove'

const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('databricks-data-layers') : null

export function announceLayer (widgetId: string, action: LayerAction, table: string): void {
  channel?.postMessage({ widgetId, action, table })
}

export function onLayerAnnounced (widgetId: string, fn: (action: LayerAction, table: string) => void): () => void {
  if (!channel) return () => {}
  const onMessage = (e: MessageEvent) => {
    const d = e.data || {}
    if (d.widgetId === widgetId && (d.action === 'add' || d.action === 'remove') && d.table) fn(d.action, d.table)
  }
  channel.addEventListener('message', onMessage)
  return () => channel.removeEventListener('message', onMessage)
}
