/*
  outputs.test.ts — the widget's output data sources (src/outputs.ts): stable ids, the saved JSON,
  and which layers get rebuilt or keep their saved JSON.
*/
import { outputDataSourceId, outputDataSourceJson, buildOutputDataSources, layerUrl } from '../src/outputs'
import type { Workspace } from '../src/config'

const ws: Workspace = { id: 'ws1', label: 'Production', gatewayUrl: 'https://gw.example.com', warehouseId: '', catalogs: [] }
const definition = {
  geometryType: 'esriGeometryPoint',
  objectIdField: 'objectid',
  fields: [
    { name: 'objectid', type: 'esriFieldTypeOID', alias: 'objectid' },
    { name: 'carrier', type: 'esriFieldTypeString', alias: 'carrier' }
  ]
}

describe('outputDataSourceId', () => {
  test('is the same every time for a layer, so the app finds it again on load', () => {
    expect(outputDataSourceId('widget_1', 'ws1::c.s.towers')).toBe(outputDataSourceId('widget_1', 'ws1::c.s.towers'))
  })
  test('differs per table, workspace and widget', () => {
    const ids = new Set([
      outputDataSourceId('widget_1', 'ws1::c.s.towers'),
      outputDataSourceId('widget_1', 'ws2::c.s.towers'),
      outputDataSourceId('widget_1', 'ws1::c.s_towers'),
      outputDataSourceId('widget_2', 'ws1::c.s.towers')
    ])
    expect(ids.size).toBe(4)
  })
  test('starts with the widget id and has only id-safe characters', () => {
    expect(outputDataSourceId('widget_1', 'ws1::c.s.my-table')).toMatch(/^widget_1_dbx_my_table_[a-z0-9]+$/)
  })
})

describe('outputDataSourceJson', () => {
  test('a FEATURE_LAYER output with the gateway URL, label and field schema', () => {
    const json: any = outputDataSourceJson('id1', 'https://gw/x/FeatureServer/0', 'towers', definition)
    expect(json).toMatchObject({ id: 'id1', type: 'FEATURE_LAYER', url: 'https://gw/x/FeatureServer/0', label: 'towers', isOutputFromWidget: true, geometryType: 'esriGeometryPoint' })
    expect(json.schema.idField).toBe('objectid')
    expect(Object.keys(json.schema.fields)).toEqual(['objectid', 'carrier'])
    expect(json.schema.fields.carrier.name).toBe('carrier')
  })
})

describe('buildOutputDataSources', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })
  const key = 'ws1::c.s.towers'
  const id = outputDataSourceId('widget_1', key)
  const saved = { id, type: 'FEATURE_LAYER', url: 'old' } as any
  const opts = (over: any = {}) => ({
    widgetId: 'widget_1',
    workspaces: [ws],
    layers: [key],
    titleOf: () => 'towers',
    saved: (x: string) => (x === id ? saved : undefined),
    signedIn: () => true,
    ...over
  })

  test('signed in: built from the definition the gateway returns', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => definition })) as any
    const [out]: any[] = await buildOutputDataSources(opts())
    expect(out.url).toBe(layerUrl(ws.gatewayUrl, 'c.s.towers'))
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${layerUrl(ws.gatewayUrl, 'c.s.towers')}?f=json`)
  })
  test('not signed in: keeps what is saved, without asking the gateway', async () => {
    global.fetch = jest.fn() as any
    expect(await buildOutputDataSources(opts({ signedIn: () => false }))).toEqual([saved])
    expect(global.fetch).not.toHaveBeenCalled()
  })
  test('gateway error or network failure: keeps what is saved', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ error: { message: 'no' } }) })) as any
    expect(await buildOutputDataSources(opts())).toEqual([saved])
    global.fetch = jest.fn(async () => { throw new Error('offline') }) as any
    expect(await buildOutputDataSources(opts())).toEqual([saved])
  })
  test('a layer of a removed workspace with nothing saved is dropped', async () => {
    expect(await buildOutputDataSources(opts({ workspaces: [], saved: () => undefined }))).toEqual([])
  })
})
