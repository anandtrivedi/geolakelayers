// auth.ts keeps module-level state, so every test loads a fresh copy
const GW = 'https://gw.example'
const jwt = (exp?: number) => `h.${btoa(JSON.stringify(exp === undefined ? {} : { exp })).replace(/=+$/, '')}.s`

function fresh (opts: { builder?: boolean } = {}) {
  ;(window as any).jimuConfig = opts.builder ? { isBuilder: true } : {}
  let mod: typeof import('../src/auth')
  jest.isolateModules(() => { mod = require('../src/auth') })
  return mod!
}
const sendToken = (token: string, origin = GW, type = 'databricks-gateway-token') =>
  window.dispatchEvent(new MessageEvent('message', { origin, data: { type, token, user: 'me@x' } }))

class FakeChannel {
  static all: FakeChannel[] = []
  sent: any[] = []
  onmsg: ((e: any) => void) | null = null
  constructor (public name: string) { FakeChannel.all.push(this) }
  postMessage (m: any) { this.sent.push(m) }
  addEventListener (_: string, fn: any) { this.onmsg = fn }
}

beforeEach(() => {
  jest.useFakeTimers()
  ;(global as any).fetch = jest.fn()
  FakeChannel.all = []
  ;(global as any).BroadcastChannel = FakeChannel
})
afterEach(() => { jest.useRealTimers() })

const ok = (body: any, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body })

describe('auth', () => {
  test('a token from the handoff popup is kept, sent as Bearer, and announced to listeners', () => {
    const a = fresh()
    const got: any[] = []
    const off = a.listenForToken(GW, t => got.push(t))
    sendToken(jwt(Date.now() / 1000 + 3600))
    expect(a.getToken(GW)?.user).toBe('me@x')
    expect(a.gatewayHeaders(GW).Authorization).toMatch(/^Bearer h\./)
    expect(got).toHaveLength(1)
    off()
    sendToken(jwt(Date.now() / 1000 + 7200))
    expect(got).toHaveLength(1)
  })

  test('messages from other origins or of other types are ignored', () => {
    const a = fresh()
    a.listenForToken(GW, () => {})
    sendToken('x', 'https://evil.example')
    sendToken('x', GW, 'something-else')
    expect(a.getToken(GW)).toBeUndefined()
    expect(a.listenForToken('', () => {})).toBeInstanceOf(Function)
  })

  test('tokens expire a minute early; tokens without exp never do', () => {
    const a = fresh()
    a.listenForToken(GW, () => {})
    sendToken(jwt(Date.now() / 1000 + 30))
    expect(a.getToken(GW)).toBeUndefined()
    sendToken('not-a-jwt')
    expect(a.getToken(GW)?.token).toBe('not-a-jwt')
  })

  test('the 30 s sweep signs out expired tokens and tells listeners', () => {
    const a = fresh()
    const got: any[] = []
    a.listenForToken(GW, t => got.push(t))
    sendToken(jwt(Date.now() / 1000 + 90))
    expect(got).toHaveLength(1)
    jest.advanceTimersByTime(31000 + 30000)
    expect(got.at(-1)).toBeNull()
    expect(a.gatewayHeaders(GW).Authorization).toBeUndefined()
  })

  test('warehouse header follows setWarehouse', () => {
    const a = fresh()
    a.setWarehouse(GW, 'abc123')
    expect(a.gatewayHeaders(GW)['X-Databricks-Warehouse']).toBe('abc123')
    a.setWarehouse(GW, '')
    expect(a.gatewayHeaders(GW)['X-Databricks-Warehouse']).toBeUndefined()
  })

  test('lookups need a sign-in, are memoized, and failures are not cached', async () => {
    const a = fresh()
    await expect(a.fetchCatalogNames(GW)).rejects.toThrow('Not signed in')
    a.listenForToken(GW, () => {})
    sendToken('tok')
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockReturnValueOnce(ok({ catalogs: ['a'] }))
    expect(await a.fetchCatalogNames(GW)).toEqual(['a'])
    expect(await a.fetchCatalogNames(GW)).toEqual(['a'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${GW}/api/catalogs`)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
    fetchMock.mockReturnValueOnce(ok({ error: 'nope' }, 500)).mockReturnValueOnce(ok({ directory: [{ name: 'x', url: 'https://x' }], editing: true }))
    await expect(a.fetchDirectory(GW)).rejects.toThrow('nope')
    expect(await a.fetchDirectory(GW)).toEqual([{ name: 'x', url: 'https://x' }])
    expect(await a.fetchEditing(GW)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('a 401 signs out and a network failure says the gateway did not answer', async () => {
    const a = fresh()
    const got: any[] = []
    a.listenForToken(GW, t => got.push(t))
    sendToken('tok')
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockReturnValueOnce(Promise.reject(new TypeError('Failed to fetch')))
    await expect(a.fetchWarehouses(GW)).rejects.toThrow('did not answer')
    fetchMock.mockReturnValueOnce(ok({}, 401))
    await expect(a.fetchWarehouses(GW)).rejects.toThrow('expired')
    expect(got.at(-1)).toBeNull()
    expect(a.getToken(GW)).toBeUndefined()
  })

  test('signOut clears this gateway\'s cached lookups only', async () => {
    const a = fresh()
    a.listenForToken(GW, () => {})
    a.listenForToken('https://other.example', () => {})
    sendToken('tok')
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://other.example', data: { type: 'databricks-gateway-token', token: 't2', user: 'u' } }))
    const fetchMock = (global as any).fetch as jest.Mock
    fetchMock.mockImplementation(() => ok({ catalogs: ['a'] }))
    await a.fetchCatalogNames(GW)
    await a.fetchCatalogNames('https://other.example')
    a.signOut(GW)
    sendToken('tok')
    await a.fetchCatalogNames(GW)
    await a.fetchCatalogNames('https://other.example')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('published apps never use the BroadcastChannel; the builder shares tokens over it', () => {
    fresh()
    expect(FakeChannel.all).toHaveLength(0)
    const a = fresh({ builder: true })
    expect(FakeChannel.all).toHaveLength(1)
    const ch = FakeChannel.all[0]
    a.listenForToken(GW, () => {})
    expect(ch.sent).toContainEqual({ type: 'ask', gateway: GW })
    sendToken('tok')
    expect(ch.sent).toContainEqual({ type: 'token', gateway: GW, token: { token: 'tok', user: 'me@x' } })
    // Another builder window announces a token for a second gateway
    ch.onmsg!({ data: { type: 'token', gateway: 'https://g2', token: { token: 't2', user: 'u' } } })
    expect(a.getToken('https://g2')?.token).toBe('t2')
    // ...and asks for ours
    ch.sent = []
    ch.onmsg!({ data: { type: 'ask', gateway: GW } })
    expect(ch.sent).toEqual([{ type: 'token', gateway: GW, token: { token: 'tok', user: 'me@x' } }])
  })

  test('signIn opens the handoff popup for this page origin; tableRef splits names', () => {
    const a = fresh()
    const open = jest.spyOn(window, 'open').mockImplementation(() => null)
    a.signIn(GW)
    expect(open.mock.calls[0][0]).toBe(`${GW}/auth/handoff?origin=${encodeURIComponent(window.location.origin)}`)
    expect(a.tableRef('c.s.t')).toMatchObject({ table: 'c.s.t', catalog: 'c', schema: 's', name: 't' })
  })

  test('signIn opens the handoff popup for this origin and reports a blocked popup', () => {
    const a = fresh()
    const open = jest.spyOn(window, 'open')
    open.mockReturnValueOnce({ closed: false } as any)
    expect(a.signIn(GW)).toBe(true)
    expect(open.mock.calls[0][0]).toBe(`${GW}/auth/handoff?origin=${encodeURIComponent(window.location.origin)}`)
    open.mockReturnValueOnce(null)
    expect(a.signIn(GW)).toBe(false)
    open.mockReturnValueOnce({ closed: true } as any)
    expect(a.signIn(GW)).toBe(false)
    open.mockRestore()
  })

  test('signInNotice says "expired" after a lapse or a 401, and clears on the next sign-in', async () => {
    const a = fresh()
    a.listenForToken(GW, () => {})
    expect(a.signInNotice(GW)).toBeNull()
    sendToken(jwt(Date.now() / 1000 + 3600))
    expect(a.getToken(GW)).toBeDefined()
    a.signOut(GW)
    expect(a.signInNotice(GW)).toBeNull()
    sendToken(jwt(Date.now() / 1000 + 30))
    expect(a.getToken(GW)).toBeUndefined()
    expect(a.signInNotice(GW)).toBe('expired')
    sendToken(jwt(Date.now() / 1000 + 3600))
    expect(a.signInNotice(GW)).toBeNull()
    ;(global as any).fetch.mockReturnValueOnce(ok({}, 401))
    await expect(a.fetchCatalogNames(GW)).rejects.toThrow(/expired/)
    expect(a.signInNotice(GW)).toBe('expired')
  })
})
