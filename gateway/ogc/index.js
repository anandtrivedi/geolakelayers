/*
  ogc/index.js — OGC API – Features (Part 1 Core, GeoJSON, OpenAPI 3.0; Part 2 CRS84 + EPSG:3857)

    /ogc                                           services the caller can read
    /ogc/{service}                                 landing page
    /ogc/{service}/conformance
    /ogc/{service}/api                             OpenAPI 3.0
    /ogc/{service}/collections                     one collection per table in the service
    /ogc/{service}/collections/{id}
    /ogc/{service}/collections/{id}/queryables
    /ogc/{service}/collections/{id}/items          GeoJSON, paged (limit, offset / cursor), bbox, datetime, ?field=value
    /ogc/{service}/collections/{id}/items/{fid}

  Read-only, and every query runs as the caller (same token, warehouse allow-list and caches as the Esri
  layers), so Unity Catalog decides what each client sees. Console routes for defining services are in
  consoleApi() below.
*/

const express = require('express')
const { CRS84, EPSG3857, SUPPORTED, reproject } = require('./crs')
const { OgcError, parseFormat, parseCrs, parseItemsQuery, queryablesOf } = require('./params')
const { validateService, createStore } = require('./services')
const { buildOpenApi } = require('./openapi')
const { explain } = require('../lib/errors')

const CONFORMANCE = [
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
  'http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs'
]
const GREGORIAN = 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian'
const JSON_TYPE = 'application/json'
const GEOJSON_TYPE = 'application/geo+json'
const OPENAPI_TYPE = 'application/vnd.oai.openapi+json;version=3.0'

// Errors from Databricks, the model or our own checks -> { status, code, description }
function toOgcError (err) {
  if (err instanceof OgcError) return err
  const message = (err?.message || String(err)).split('\n')[0].slice(0, 300)
  if (err?.code === 400) return new OgcError(400, 'InvalidParameterValue', message)
  if (err?.code === 429) return new OgcError(429, 'TooManyRequests', message)
  // Missing grants and tables, in words that say what to ask for (lib/errors.js)
  const explained = explain(err)
  if (explained.status === 403) return new OgcError(403, 'Forbidden', explained.message)
  if (explained.status === 404) return new OgcError(404, 'NotFound', explained.message)
  if (explained.status === 401) return new OgcError(401, 'Unauthorized', explained.message)
  return new OgcError(500, 'ServerError', message)
}

function sendError (res, err) {
  const e = toOgcError(err)
  res.status(e.status).type(JSON_TYPE).json({ code: e.code, description: e.message })
}

const link = (href, rel, type, title) => ({ href, rel, type, ...(title ? { title } : {}) })

// Same URL with some query parameters changed (null removes one)
function withQuery (base, query, changes) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (!(k in changes)) q.set(k, String(v))
  for (const [k, v] of Object.entries(changes)) if (v !== null && v !== undefined) q.set(k, String(v))
  const s = q.toString()
  return s ? `${base}?${s}` : base
}

/**
 * deps: { model: { queryFeatures, collectionInfo, checkRateLimit }, store (or null when OGC is off),
 *         obo(req), selfOrigin(req), defaultLimit, maxLimit, readWarehouse (warehouse for OGC reads) }
 */
function ogcRouter (deps) {
  const { model, store, obo, selfOrigin } = deps
  const defaultLimit = deps.defaultLimit || 100
  const maxLimit = deps.maxLimit || 4000
  const router = express.Router({ strict: false })
  // OGC clients can't pick a warehouse, so each service names its engine (a request that names an allowed
  // warehouse, like the console's preview, still wins). An engine that's no longer allowed falls back to the
  // bound warehouse rather than breaking clients that can do nothing about it.
  const warned = new Set()
  const readWarehouse = (req, service) => {
    if (req.warehouseId) return req.warehouseId
    const w = service?.warehouse
    if (!w) return undefined
    if ((deps.allowedWarehouses || []).includes(w)) return w
    if (!warned.has(w)) { warned.add(w); console.warn(`OGC service ${service.name}: warehouse ${w} is no longer allowed; using the bound warehouse`) }
    return undefined
  }

  const handle = fn => async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      sendError(res, err)
    }
  }
  const base = (req, service) => `${selfOrigin(req)}/ogc/${service}`
  const ctx = (req, service) => ({ userToken: obo(req), warehouseId: readWarehouse(req, service) })

  async function serviceOf (req) {
    if (!store) throw new OgcError(404, 'NotFound', 'OGC services are not turned on for this gateway (bundle variable ogc_services_table)')
    const s = await store.get(req, req.params.service)
    if (!s) throw new OgcError(404, 'NotFound', `No service named ${req.params.service}`)
    return s
  }
  function collectionOf (service, id) {
    const c = service.collections.find(x => x.id === id)
    if (!c) throw new OgcError(404, 'NotFound', `No collection ${id} in ${service.name}`)
    return c
  }
  const infoOf = (req, c, service) => model.collectionInfo({ table: c.table, timeField: c.timeField, ...ctx(req, service) })

  function collectionJson (req, service, c, info) {
    const b = base(req, service.name)
    const out = {
      id: c.id,
      title: c.title,
      description: c.description || `${c.table} in Unity Catalog`,
      itemType: 'feature',
      crs: SUPPORTED,
      storageCrs: CRS84,
      links: [
        link(`${b}/collections/${c.id}`, 'self', JSON_TYPE, 'This collection'),
        link(`${b}/collections/${c.id}/items`, 'items', GEOJSON_TYPE, 'Features'),
        link(`${b}/collections/${c.id}/queryables`, 'http://www.opengis.net/def/rel/ogc/1.0/queryables', 'application/schema+json', 'Queryables')
      ]
    }
    const e = info.extent
    if (e) out.extent = { spatial: { bbox: [[e.xmin, e.ymin, e.xmax, e.ymax]], crs: CRS84 } }
    if (info.temporal && (info.temporal[0] || info.temporal[1])) {
      out.extent = { ...(out.extent || {}), temporal: { interval: [info.temporal], trs: GREGORIAN } }
    }
    return out
  }

  // Services this caller can read
  router.get('/', handle(async (req, res) => {
    parseFormat(req.query)
    const services = store ? await store.list(req) : []
    res.type(JSON_TYPE).json({
      services: services.map(s => ({ name: s.name, title: s.title, description: s.description, collections: s.collections.length, href: base(req, s.name) })),
      links: [link(`${selfOrigin(req)}/ogc`, 'self', JSON_TYPE)]
    })
  }))

  router.get('/:service', handle(async (req, res) => {
    parseFormat(req.query)
    const s = await serviceOf(req)
    const b = base(req, s.name)
    res.type(JSON_TYPE).json({
      title: s.title,
      description: s.description || 'Unity Catalog tables as OGC API – Features, served by LakeGate',
      links: [
        link(b, 'self', JSON_TYPE, 'This document'),
        link(`${b}/api`, 'service-desc', OPENAPI_TYPE, 'API definition'),
        link(`${selfOrigin(req)}/#ogc`, 'service-doc', 'text/html', 'LakeGate console'),
        link(`${b}/conformance`, 'conformance', JSON_TYPE, 'Conformance classes'),
        link(`${b}/conformance`, 'http://www.opengis.net/def/rel/ogc/1.0/conformance', JSON_TYPE, 'Conformance classes'),
        link(`${b}/collections`, 'data', JSON_TYPE, 'Collections'),
        link(`${b}/collections`, 'http://www.opengis.net/def/rel/ogc/1.0/data', JSON_TYPE, 'Collections')
      ]
    })
  }))

  router.get('/:service/conformance', handle(async (req, res) => {
    parseFormat(req.query)
    await serviceOf(req)
    res.type(JSON_TYPE).json({ conformsTo: CONFORMANCE })
  }))

  router.get('/:service/api', handle(async (req, res) => {
    const s = await serviceOf(req)
    const info = {}
    await Promise.all(s.collections.map(async c => {
      try {
        const i = await infoOf(req, c, s)
        info[c.id] = { queryables: queryablesOf(i.fields), hasTime: !!c.timeField }
      } catch (e) {
        info[c.id] = { queryables: [], hasTime: !!c.timeField }
      }
    }))
    res.type(OPENAPI_TYPE).send(JSON.stringify(buildOpenApi({ service: s, baseUrl: base(req, s.name), info, maxLimit, defaultLimit })))
  }))

  router.get('/:service/collections', handle(async (req, res) => {
    parseFormat(req.query)
    const s = await serviceOf(req)
    // Tables the caller can't read (or that stopped being map-ready) are left out rather than listed broken
    const results = await Promise.all(s.collections.map(c => infoOf(req, c, s).then(i => collectionJson(req, s, c, i), () => null)))
    res.type(JSON_TYPE).json({
      links: [link(`${base(req, s.name)}/collections`, 'self', JSON_TYPE, 'Collections')],
      crs: SUPPORTED,
      collections: results.filter(Boolean)
    })
  }))

  router.get('/:service/collections/:cid', handle(async (req, res) => {
    parseFormat(req.query)
    const s = await serviceOf(req)
    const c = collectionOf(s, req.params.cid)
    res.type(JSON_TYPE).json(collectionJson(req, s, c, await infoOf(req, c, s)))
  }))

  router.get('/:service/collections/:cid/queryables', handle(async (req, res) => {
    parseFormat(req.query)
    const s = await serviceOf(req)
    const c = collectionOf(s, req.params.cid)
    const info = await infoOf(req, c, s)
    const { jsonType } = require('./openapi')
    const properties = {}
    for (const q of queryablesOf(info.fields)) properties[q.name] = { title: q.name, ...jsonType(q.sqlType) }
    res.type('application/schema+json').json({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${base(req, s.name)}/collections/${c.id}/queryables`,
      type: 'object',
      title: c.title,
      properties,
      additionalProperties: false
    })
  }))

  router.get('/:service/collections/:cid/items', handle(async (req, res) => {
    if (model.checkRateLimit && !model.checkRateLimit(clientIp(req))) throw new OgcError(429, 'TooManyRequests', 'Rate limit exceeded. Try again later.')
    const s = await serviceOf(req)
    const c = collectionOf(s, req.params.cid)
    const info = await infoOf(req, c, s)
    const q = parseItemsQuery(req.query, { queryables: queryablesOf(info.fields), hasTime: !!c.timeField, defaultLimit, maxLimit })
    const result = await model.queryFeatures({
      table: c.table,
      ...ctx(req, s),
      bbox: q.bbox,
      propertyFilters: q.filters,
      params: q.params,
      time: q.datetime ? { field: c.timeField, ...q.datetime } : undefined,
      limit: q.limit,
      offset: q.offset,
      cursor: q.cursor,
      count: 'auto'
    })
    const itemsUrl = `${base(req, s.name)}/collections/${c.id}/items`
    const pick = q.properties && new Set(q.properties)
    const features = result.features.map(f => ({
      ...f,
      geometry: reproject(f.geometry, q.crs),
      properties: pick ? Object.fromEntries(Object.entries(f.properties || {}).filter(([k]) => pick.has(k))) : f.properties,
      links: [link(`${itemsUrl}/${f.id}`, 'self', GEOJSON_TYPE)]
    }))
    const links = [
      link(withQuery(itemsUrl, req.query, {}), 'self', GEOJSON_TYPE, 'This page'),
      link(`${base(req, s.name)}/collections/${c.id}`, 'collection', JSON_TYPE, c.title)
    ]
    // Next page: keyset on the id (fast at any depth); offset kept so prev links and clients that count work
    if (features.length === q.limit && result.lastId !== null && result.lastId !== undefined) {
      links.push(link(withQuery(itemsUrl, req.query, { offset: q.offset + q.limit, cursor: result.lastId, limit: q.limit }), 'next', GEOJSON_TYPE, 'Next page'))
    }
    if (q.offset > 0) {
      links.push(link(withQuery(itemsUrl, req.query, { offset: Math.max(0, q.offset - q.limit) || null, cursor: null, limit: q.limit }), 'prev', GEOJSON_TYPE, 'Previous page'))
    }
    const body = { type: 'FeatureCollection', timeStamp: new Date().toISOString() }
    if (result.numberMatched !== undefined) body.numberMatched = result.numberMatched
    body.numberReturned = features.length
    body.features = features
    body.links = links
    sendGeoJson(res, body, q.crs)
  }))

  router.get('/:service/collections/:cid/items/:fid', handle(async (req, res) => {
    for (const k of Object.keys(req.query)) if (!['crs', 'f'].includes(k)) throw new OgcError(400, 'InvalidParameterValue', `Unknown parameter ${k}`)
    parseFormat(req.query)
    const crs = parseCrs(req.query.crs === undefined ? undefined : String(req.query.crs), 'crs')
    const s = await serviceOf(req)
    const c = collectionOf(s, req.params.cid)
    if (!/^-?\d{1,16}$/.test(req.params.fid) || !Number.isSafeInteger(Number(req.params.fid))) throw new OgcError(404, 'NotFound', `No feature ${req.params.fid}`)
    const result = await model.queryFeatures({ table: c.table, ...ctx(req, s), featureId: Number(req.params.fid), limit: 1 })
    const f = result.features[0]
    if (!f) throw new OgcError(404, 'NotFound', `No feature ${req.params.fid}`)
    const itemsUrl = `${base(req, s.name)}/collections/${c.id}/items`
    sendGeoJson(res, {
      ...f,
      geometry: reproject(f.geometry, crs),
      links: [
        link(`${itemsUrl}/${f.id}`, 'self', GEOJSON_TYPE, 'This feature'),
        link(`${base(req, s.name)}/collections/${c.id}`, 'collection', JSON_TYPE, c.title)
      ]
    }, crs)
  }))

  return router
}

function sendGeoJson (res, body, crs) {
  res.set('Content-Crs', `<${crs}>`)
  res.set('Cache-Control', 'private, max-age=0')
  res.type(GEOJSON_TYPE).send(JSON.stringify(body, (k, v) => typeof v === 'bigint' ? Number(v) : v))
}

function clientIp (req) {
  const fwd = req.headers['x-forwarded-for']
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.ip || 'unknown'
}

/**
 * Console routes for defining services (same-origin JSON writes, guarded by consoleOnly in server.js):
 *   GET/POST /api/ogc/services, GET/PUT/DELETE /api/ogc/services/:name, POST /api/ogc/setup,
 *   GET /api/ogc/columns/:table (time-field candidates)
 */
function consoleApi (deps) {
  const { model, store, obo } = deps
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))
  const handle = fn => async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      const e = toOgcError(err)
      res.status(e.status).json({ error: e.message, code: e.code, setup: !!err.setup })
    }
  }
  const off = () => { throw new OgcError(404, 'NotFound', 'OGC services are not turned on (bundle variable ogc_services_table)') }
  const ctx = req => ({ userToken: obo(req), warehouseId: req.warehouseId })

  // Every table must be map-ready for the author, a time field must be a date/timestamp column, and the
  // engine must be an allowed warehouse
  async function checkTables (req, def) {
    if (def.warehouse && !(deps.allowedWarehouses || []).includes(def.warehouse)) {
      throw new OgcError(400, 'InvalidParameterValue', `Warehouse ${def.warehouse} is not allowed on this gateway`)
    }
    for (const c of def.collections) {
      let info
      try {
        info = await model.collectionInfo({ table: c.table, ...ctx(req) })
      } catch (err) {
        const e = toOgcError(err)
        throw new OgcError(e.status === 500 ? 400 : e.status, e.code, `${c.table}: ${e.message}`)
      }
      if (c.timeField) {
        const f = info.fields.find(x => x.name === c.timeField)
        if (!f || !/^(date|timestamp|timestamp_ntz)$/i.test(String(f.sqlType))) {
          throw new OgcError(400, 'InvalidParameterValue', `${c.table}: ${c.timeField} is not a date or timestamp column`)
        }
      }
    }
  }

  router.get('/services', handle(async (req, res) => {
    if (!store) off()
    res.json({ table: store.table, services: await store.list(req) })
  }))
  router.get('/services/:name', handle(async (req, res) => {
    if (!store) off()
    const s = await store.get(req, req.params.name)
    if (!s) throw new OgcError(404, 'NotFound', `No service named ${req.params.name}`)
    res.json(s)
  }))
  router.post('/services', handle(async (req, res) => {
    if (!store) off()
    const def = validateService(req.body)
    await checkTables(req, def)
    await store.create(req, def)
    res.status(201).json(await store.get(req, def.name) || def)
  }))
  router.put('/services/:name', handle(async (req, res) => {
    if (!store) off()
    const def = validateService(req.body, req.params.name)
    await checkTables(req, def)
    await store.update(req, def, (req.body || {}).version)
    res.json(await store.get(req, def.name) || def)
  }))
  router.delete('/services/:name', handle(async (req, res) => {
    if (!store) off()
    await store.remove(req, req.params.name)
    res.status(204).end()
  }))
  router.post('/setup', handle(async (req, res) => {
    if (!store) off()
    if (deps.preflight && await deps.preflight(req, res, 'CREATE_TABLE', store.table.split('.').slice(0, 2).join('.'))) return
    await store.setup(req)
    res.json({ table: store.table, ready: true })
  }))
  router.get('/columns/:table', handle(async (req, res) => {
    const info = await model.collectionInfo({ table: req.params.table, ...ctx(req) })
    res.json({
      table: req.params.table,
      idField: info.idField,
      count: info.count,
      timeFields: info.fields.filter(f => /^(date|timestamp|timestamp_ntz)$/i.test(String(f.sqlType))).map(f => f.name),
      queryables: queryablesOf(info.fields).map(q => q.name)
    })
  }))
  return router
}

module.exports = { ogcRouter, consoleApi, createStore, CONFORMANCE, toOgcError, withQuery, EPSG3857 }
