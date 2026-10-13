import { BaseVersionManager, Immutable } from 'jimu-core'
import type { IMConfig } from './config'

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
    }
  ]
}

export const versionManager: BaseVersionManager = new VersionManager()
