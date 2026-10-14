import { Immutable } from 'jimu-core'
import { versionManager } from '../src/version-manager'

// Run one upgrader by version number
const upgrade = (version: string, config: any) => {
  const step = (versionManager as any).versions.find((v: any) => v.version === version)
  return step.upgrader(Immutable(config)).asMutable({ deep: true })
}

describe('version manager', () => {
  test('versions are in order and end at 1.20.3 (manifest version)', () => {
    const versions = (versionManager as any).versions.map((v: any) => v.version)
    expect(versions).toEqual(['1.20.1', '1.20.2', '1.20.3'])
    expect(require('../manifest.json').version).toBe('1.20.3')
  })

  test('1.20.1 adds start-up layers and turns browsing on, keeping existing values', () => {
    expect(upgrade('1.20.1', { gatewayUrl: 'https://g' })).toEqual({ gatewayUrl: 'https://g', layers: [], allowBrowse: true })
    expect(upgrade('1.20.1', { layers: ['a.b.c'], allowBrowse: false })).toEqual({ layers: ['a.b.c'], allowBrowse: false })
  })

  test('1.20.2 turns the catalog/schema prefix into a catalog list and drops it', () => {
    expect(upgrade('1.20.2', { catalogFilter: 'main.geospatial' })).toEqual({ catalogs: ['main'], warehouseId: '' })
    expect(upgrade('1.20.2', {})).toEqual({ catalogs: [], warehouseId: '' })
    expect(upgrade('1.20.2', { catalogs: ['x'], warehouseId: 'w', catalogFilter: 'y' })).toEqual({ catalogs: ['x'], warehouseId: 'w' })
  })

  test('1.20.3 moves single-workspace settings into a workspace and prefixes layer keys', () => {
    const out = upgrade('1.20.3', {
      gatewayUrl: 'https://arcgateway-1234567890123456.aws.databricksapps.com/',
      warehouseId: 'abc',
      catalogs: ['main'],
      layers: ['main.geospatial.a', 'ws9::x.y.z'],
      allowBrowse: true
    })
    expect(out.gatewayUrl).toBeUndefined()
    expect(out.warehouseId).toBeUndefined()
    expect(out.catalogs).toBeUndefined()
    expect(out.workspaces).toHaveLength(1)
    expect(out.workspaces[0]).toMatchObject({ id: 'ws1', gatewayUrl: 'https://arcgateway-1234567890123456.aws.databricksapps.com', warehouseId: 'abc', catalogs: ['main'] })
    expect(typeof out.workspaces[0].label).toBe('string')
    expect(out.layers).toEqual(['ws1::main.geospatial.a', 'ws9::x.y.z'])
    expect(out.allowBrowse).toBe(true)
  })

  test('1.20.3 with no gateway gives no workspaces; already-migrated configs pass through', () => {
    expect(upgrade('1.20.3', { layers: [] }).workspaces).toEqual([])
    const migrated = { workspaces: [{ id: 'ws1', label: 'a', gatewayUrl: 'https://g', warehouseId: '', catalogs: [] }], layers: ['ws1::a.b.c'] }
    expect(upgrade('1.20.3', migrated)).toEqual(migrated)
  })

  test('the full chain upgrades a 1.20.0 config to the current shape', () => {
    let c: any = Immutable({ gatewayUrl: 'https://g.example', catalogFilter: 'cat', layers: ['cat.s.t'] })
    for (const v of (versionManager as any).versions) c = v.upgrader(c)
    expect(c.asMutable({ deep: true })).toMatchObject({ allowBrowse: true, layers: ['ws1::cat.s.t'], workspaces: [{ id: 'ws1', gatewayUrl: 'https://g.example', catalogs: ['cat'], warehouseId: '' }] })
  })
})
