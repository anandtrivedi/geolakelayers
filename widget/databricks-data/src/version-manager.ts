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
    }
  ]
}

export const versionManager: BaseVersionManager = new VersionManager()
