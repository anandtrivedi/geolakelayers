import { React } from 'jimu-core'
import { render } from 'jimu-for-test'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'

// The spinner and icons are presentation only; keep jimu-ui's full bundle out of the test
jest.mock('jimu-ui', () => ({ Loading: ({ text }: any) => require('react').createElement('span', null, text), LoadingType: { Donut: 'donut' } }))
jest.mock('jimu-icons/outlined/directional/right', () => ({ RightOutlined: () => null }))
jest.mock('jimu-icons/outlined/directional/down', () => ({ DownOutlined: () => null }))
import { TableTree } from '../src/table-tree'
import type { CatalogTable, Workspace } from '../src/config'

const ws = (id: string, label = id): Workspace => ({ id, label, gatewayUrl: `https://${id}.example`, warehouseId: '', catalogs: ['cat'] })
const t = (table: string): CatalogTable => {
  const [catalog, schema, name] = table.split('.')
  return { table, catalog, schema, name, idField: 'objectid', geometry: 'geom' }
}
const messages = { loading: 'Loading…', failed: (e: string) => `Failed: ${e}`, empty: 'No tables', tablesIn: (n: number) => `${n} tables` }

function setup (props: Partial<React.ComponentProps<typeof TableTree>> = {}) {
  const loadTables = props.loadTables || jest.fn(async (_w: Workspace, c: string) => [t(`${c}.s1.alpha`), t(`${c}.s1.beta`), t(`${c}.s2.gamma`)])
  const onTableClick = jest.fn()
  const utils = render(
    <TableTree workspaces={[ws('a')]} catalogsFor={w => w.catalogs} loadTables={loadTables}
      renderTable={(w, x) => <span>{x.name}</span>} onTableClick={onTableClick} messages={messages} {...props} />
  )
  return { ...utils, loadTables, onTableClick }
}

describe('TableTree', () => {
  test('lists catalogs closed; opening one loads its tables once, grouped by schema', async () => {
    const { loadTables } = setup()
    expect(screen.getByText('cat')).toBeTruthy()
    expect(loadTables).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('cat'))
    await screen.findByText('3 tables')
    expect(screen.getByText('s1')).toBeTruthy()
    expect(screen.getByText('s2')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    fireEvent.click(screen.getByText('s1'))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('beta')).toBeTruthy()
    fireEvent.click(screen.getByText('cat'))
    expect(screen.queryByText('s1')).toBeNull()
    fireEvent.click(screen.getByText('cat'))
    expect(loadTables).toHaveBeenCalledTimes(1)
  })

  test('clicking a table reports it', async () => {
    const { onTableClick } = setup({ loadTables: async () => [t('cat.s.only')] })
    fireEvent.click(screen.getByText('cat'))
    fireEvent.click(await screen.findByText('only'))
    expect(onTableClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.objectContaining({ table: 'cat.s.only' }))
  })

  test('a failed load shows the error and retries when reopened', async () => {
    let calls = 0
    const loadTables = jest.fn(async () => { if (++calls === 1) throw new Error('boom'); return [t('cat.s.ok')] })
    setup({ loadTables })
    fireEvent.click(screen.getByText('cat'))
    await screen.findByText('Failed: boom')
    fireEvent.click(screen.getByText('cat'))
    fireEvent.click(screen.getByText('cat'))
    await screen.findByText('ok')
    expect(loadTables).toHaveBeenCalledTimes(2)
  })

  test('empty catalogs say so', async () => {
    setup({ loadTables: async () => [] })
    fireEvent.click(screen.getByText('cat'))
    await screen.findByText('No tables')
  })

  test('expandAll opens and loads every workspace and catalog', async () => {
    const loadTables = jest.fn(async (w: Workspace, c: string) => [t(`${c}.s.${w.id}_${c}`)])
    setup({ workspaces: [ws('a', 'East'), { ...ws('b', 'Gov'), catalogs: ['x', 'y'] }], loadTables, expandAll: true })
    await screen.findByText('a_cat')
    await screen.findByText('b_x')
    await screen.findByText('b_y')
    expect(loadTables).toHaveBeenCalledTimes(3)
    expect(screen.getByText('East')).toBeTruthy()
  })

  test('text filter and tableFilter hide rows', async () => {
    const { rerender, loadTables } = setup({ expandAll: true })
    await screen.findByText('alpha')
    const base = { workspaces: [ws('a')], catalogsFor: (w: Workspace) => w.catalogs, loadTables, renderTable: (w: Workspace, x: CatalogTable) => <span>{x.name}</span>, messages, expandAll: true }
    rerender(<TableTree {...base} filter='gam' />)
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('gamma')).toBeTruthy()
    rerender(<TableTree {...base} tableFilter={(w, x) => x.name === 'beta'} />)
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.queryByText('gamma')).toBeNull()
  })

  test('a slow earlier response never overwrites a newer one', async () => {
    const resolvers: Array<(v: CatalogTable[]) => void> = []
    const loadTables = jest.fn(() => new Promise<CatalogTable[]>(resolve => resolvers.push(resolve)))
    const props = { catalogsFor: (w: Workspace) => w.catalogs, loadTables, renderTable: (w: Workspace, x: CatalogTable) => <span>{x.name}</span>, messages, expandAll: true }
    const { rerender } = render(<TableTree {...props} workspaces={[ws('a')]} />)
    await waitFor(() => expect(loadTables).toHaveBeenCalledTimes(1))
    // The workspace's warehouse changes: open catalogs reload
    rerender(<TableTree {...props} workspaces={[{ ...ws('a'), warehouseId: 'w2' }]} />)
    await waitFor(() => expect(loadTables).toHaveBeenCalledTimes(2))
    await act(async () => { resolvers[1]([t('cat.s.newer')]) })
    await act(async () => { resolvers[0]([t('cat.s.older')]) })
    expect(screen.getByText('newer')).toBeTruthy()
    expect(screen.queryByText('older')).toBeNull()
  })

  test('one workspace hides the workspace level unless asked; several show it', () => {
    const { unmount } = setup()
    expect(screen.queryByText('a')).toBeNull()
    unmount()
    setup({ workspaces: [ws('a', 'East'), ws('b', 'Gov')] })
    expect(screen.getByText('East')).toBeTruthy()
    expect(screen.getByText('Gov')).toBeTruthy()
  })

  test('autoExpandSingle opens a lone catalog; catalogBadge renders', async () => {
    setup({ autoExpandSingle: true, catalogBadge: () => <em>viewers</em> })
    await screen.findByText('3 tables')
    expect(screen.getByText('viewers')).toBeTruthy()
  })
})
