import { BaseVersionManager, Immutable } from 'jimu-core'
import type { IMConfig } from './config'
import { labelFromUrl, normalizeUrl, layerKey } from './workspaces'

class VersionManager extends BaseVersionManager {
  versions = [
    {
      version: '1.20.1',
      description: 'Saved start-up layers and the viewer browsing switch',
      upgrader: (oldConfig: IMConfig) => {
        let config = oldConfig
        if (!config.layers) config = config.set('layers', Immutable([]))
        if (config.allowBrowse === undefined) config = config.set('allowBrowse', true)
        return config
      }
    },
    {
      version: '1.20.2',
      description: 'Warehouse and catalogs picked in settings (replaces the catalog/schema prefix)',
      upgrader: (oldConfig: IMConfig) => {
        let config = oldConfig
        if (!config.catalogs) {
          const prefix = (config.catalogFilter || '').split('.')[0]
          config = config.set('catalogs', Immutable(prefix ? [prefix] : []))
        }
        if (config.warehouseId === undefined) config = config.set('warehouseId', '')
        return config.without('catalogFilter' as any)
      }
    },
    {
      version: '1.20.3',
      description: 'Multiple Databricks workspaces: settings move into a workspaces list; layer keys carry the workspace',
      upgrader: (oldConfig: IMConfig) => {
        if (oldConfig.workspaces) return oldConfig
        const url = normalizeUrl(oldConfig.gatewayUrl)
        const id = 'ws1'
        const workspaces = url
          ? [{ id, label: labelFromUrl(url), gatewayUrl: url, warehouseId: oldConfig.warehouseId || '', catalogs: oldConfig.catalogs ? oldConfig.catalogs.asMutable() : [] }]
          : []
        const layers = (oldConfig.layers ? oldConfig.layers.asMutable() : []).map(t => t.includes('::') ? t : layerKey(id, t))
        return oldConfig
          .set('workspaces', Immutable(workspaces))
          .set('layers', Immutable(layers))
          .without('gatewayUrl' as any).without('warehouseId' as any).without('catalogs' as any)
      }
    }
  ]
}

export const versionManager: BaseVersionManager = new VersionManager()
