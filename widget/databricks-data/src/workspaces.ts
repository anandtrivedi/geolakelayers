/*
  Workspace helpers shared by the runtime and the settings panel.
*/
import type { IMConfig, Workspace } from './config'

export function normalizeUrl (url: string): string {
  return (url || '').trim().replace(/\/$/, '')
}

/** Workspaces from config, with URLs normalized and empty entries dropped. */
export function workspacesOf (config: IMConfig): Workspace[] {
  const list = config.workspaces ? config.workspaces.asMutable({ deep: true }) as Workspace[] : []
  return list
    .map(w => ({ ...w, gatewayUrl: normalizeUrl(w.gatewayUrl), catalogs: w.catalogs || [], warehouseId: w.warehouseId || '' }))
    .filter(w => w.gatewayUrl)
}

/** A readable default name for a gateway URL: the app name without the workspace-id suffix. */
export function labelFromUrl (url: string): string {
  try {
    const host = new URL(url).hostname
    return host.split('.')[0].replace(/-\d{6,}$/, '') + (host.includes('databricksapps.us') ? ' (gov)' : '')
  } catch {
    return url
  }
}

export function newWorkspaceId (existing: Workspace[]): string {
  let n = existing.length + 1
  while (existing.some(w => w.id === `ws${n}`)) n++
  return `ws${n}`
}

const SEP = '::'

export function layerKey (workspaceId: string, table: string): string {
  return `${workspaceId}${SEP}${table}`
}

export function parseLayerKey (key: string): { workspaceId: string, table: string } {
  const i = key.indexOf(SEP)
  return i < 0 ? { workspaceId: '', table: key } : { workspaceId: key.slice(0, i), table: key.slice(i + SEP.length) }
}
