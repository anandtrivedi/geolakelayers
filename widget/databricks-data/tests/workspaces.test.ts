/*
  workspaces.test.ts — Tests for src/workspaces.ts helpers
*/
import { normalizeUrl, workspacesOf, labelFromUrl, newWorkspaceId, layerKey, parseLayerKey } from '../src/workspaces'
import type { IMConfig, Workspace } from '../src/config'
import { Immutable } from 'jimu-core'

describe('workspaces.normalizeUrl', () => {
  test('removes trailing slash', () => {
    const result = normalizeUrl('https://app.databricksapps.com/')
    expect(result).toBe('https://app.databricksapps.com')
  })

  test('trims whitespace', () => {
    const result = normalizeUrl('  https://app.databricksapps.com  ')
    expect(result).toBe('https://app.databricksapps.com')
  })

  test('returns empty string unchanged', () => {
    const result = normalizeUrl('')
    expect(result).toBe('')
  })

  test('handles null/undefined gracefully', () => {
    expect(normalizeUrl(null as any)).toBe('')
    expect(normalizeUrl(undefined as any)).toBe('')
  })
})

describe('workspaces.labelFromUrl', () => {
  test('extracts app name from databricksapps.com URL', () => {
    const result = labelFromUrl('https://arcgateway-1234567890123456.databricksapps.com')
    expect(result).toBe('arcgateway')
  })

  test('removes workspace-id suffix from app name', () => {
    const result = labelFromUrl('https://arcgateway-1234567890.databricksapps.com')
    expect(result).toMatch(/arcgateway/)
  })

  test('adds (gov) suffix for databricksapps.us URLs', () => {
    const result = labelFromUrl('https://arcgateway-1234567890.databricksapps.us')
    expect(result).toContain('gov')
  })

  test('returns URL on parse error', () => {
    const result = labelFromUrl('not a valid url')
    expect(result).toBe('not a valid url')
  })
})

describe('workspaces.newWorkspaceId', () => {
  test('increments based on list length', () => {
    const existing: Workspace[] = [
      { id: 'ws1', gatewayUrl: 'http://a', catalogs: [], warehouseId: '' },
      { id: 'ws2', gatewayUrl: 'http://b', catalogs: [], warehouseId: '' }
    ]
    const result = newWorkspaceId(existing)
    expect(result).toBe('ws3')
  })

  test('skips IDs already in use', () => {
    const existing: Workspace[] = [
      { id: 'ws1', gatewayUrl: 'http://a', catalogs: [], warehouseId: '' },
      { id: 'ws3', gatewayUrl: 'http://b', catalogs: [], warehouseId: '' }
    ]
    // length=2, so n=3. ws3 exists, so n=4. ws4 doesn't exist, return ws4
    const result = newWorkspaceId(existing)
    expect(result).toBe('ws4')
  })

  test('empty list generates ws1', () => {
    const result = newWorkspaceId([])
    expect(result).toBe('ws1')
  })
})

describe('workspaces.layerKey and parseLayerKey', () => {
  test('layerKey creates composite key', () => {
    const key = layerKey('ws1', 'catalog.schema.table')
    expect(key).toBe('ws1::catalog.schema.table')
  })

  test('parseLayerKey splits composite key', () => {
    const result = parseLayerKey('ws1::catalog.schema.table')
    expect(result.workspaceId).toBe('ws1')
    expect(result.table).toBe('catalog.schema.table')
  })

  test('parseLayerKey handles missing separator', () => {
    const result = parseLayerKey('catalog.schema.table')
    expect(result.workspaceId).toBe('')
    expect(result.table).toBe('catalog.schema.table')
  })

  test('parseLayerKey roundtrips', () => {
    const original = { workspaceId: 'ws2', table: 'db.sch.tbl' }
    const key = layerKey(original.workspaceId, original.table)
    const parsed = parseLayerKey(key)
    expect(parsed).toEqual(original)
  })
})

describe('workspaces.workspacesOf', () => {
  test('returns normalized workspaces', () => {
    const config = {
      workspaces: Immutable([
        { id: 'ws1', gatewayUrl: 'https://app.com/', catalogs: Immutable(['cat1']), warehouseId: 'wh1' }
      ])
    } as any as IMConfig

    const result = workspacesOf(config)
    expect(result).toHaveLength(1)
    expect(result[0].gatewayUrl).toBe('https://app.com')
  })

  test('filters out empty gateway URLs', () => {
    const config = {
      workspaces: Immutable([
        { id: 'ws1', gatewayUrl: 'https://app.com', catalogs: Immutable([]), warehouseId: '' },
        { id: 'ws2', gatewayUrl: '', catalogs: Immutable([]), warehouseId: '' }
      ])
    } as any as IMConfig

    const result = workspacesOf(config)
    expect(result).toHaveLength(1)
  })

  test('handles missing workspaces property', () => {
    const config = {} as IMConfig
    const result = workspacesOf(config)
    expect(result).toEqual([])
  })

  test('provides default catalogs and warehouse', () => {
    const config = {
      workspaces: Immutable([
        { id: 'ws1', gatewayUrl: 'https://app.com', catalogs: undefined, warehouseId: undefined }
      ])
    } as any as IMConfig

    const result = workspacesOf(config)
    expect(result[0].catalogs).toEqual([])
    expect(result[0].warehouseId).toBe('')
  })
})
