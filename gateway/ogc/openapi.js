/*
  openapi.js — OpenAPI 3.0 description of one OGC service (its collections and their queryables)
*/

const { SUPPORTED } = require('./crs')

function jsonType (sqlType) {
  const t = String(sqlType || '').toLowerCase()
  if (/^(tinyint|smallint|int|integer|bigint)$/.test(t)) return { type: 'integer' }
  if (/^(float|double|decimal)/.test(t)) return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'date') return { type: 'string', format: 'date' }
  if (t.startsWith('timestamp')) return { type: 'string', format: 'date-time' }
  return { type: 'string' }
}

const ref = name => ({ $ref: `#/components/parameters/${name}` })
const json = (description, schema) => ({ description, content: { 'application/json': { schema } } })
const geojson = (description, schema) => ({ description, content: { 'application/geo+json': { schema } } })

/**
 * service: { name, title, description, collections }
 * info: { [collectionId]: { queryables: [{ name, sqlType }], hasTime } }
 */
function buildOpenApi ({ service, baseUrl, info, maxLimit, defaultLimit }) {
  const paths = {
    '/': { get: { summary: 'Landing page', operationId: 'getLandingPage', parameters: [ref('f')], responses: { 200: json('Links to the API, conformance and collections', { type: 'object' }) } } },
    '/conformance': { get: { summary: 'Conformance classes', operationId: 'getConformance', parameters: [ref('f')], responses: { 200: json('Conformance classes', { type: 'object', properties: { conformsTo: { type: 'array', items: { type: 'string' } } } }) } } },
    '/api': { get: { summary: 'This document', operationId: 'getApi', responses: { 200: { description: 'OpenAPI 3.0', content: { 'application/vnd.oai.openapi+json;version=3.0': { schema: { type: 'object' } } } } } } },
    '/collections': { get: { summary: 'Collections (one per table)', operationId: 'getCollections', parameters: [ref('f')], responses: { 200: json('Collections', { type: 'object' }) } } }
  }
  for (const c of service.collections) {
    const q = info[c.id] || { queryables: [], hasTime: false }
    const props = q.queryables.map(p => ({ name: p.name, in: 'query', required: false, description: `Features whose ${p.name} equals this value`, schema: jsonType(p.sqlType), style: 'form', explode: false }))
    const params = [ref('bbox'), ref('bbox-crs'), ref('crs'), ref('limit'), ref('offset'), ref('cursor'), ...(q.hasTime ? [ref('datetime')] : []), ref('f'), ...props]
    paths[`/collections/${c.id}`] = { get: { summary: c.title, operationId: `describe_${c.id}`, parameters: [ref('f')], responses: { 200: json('Collection', { type: 'object' }), 404: ref404() } } }
    paths[`/collections/${c.id}/items`] = {
      get: {
        summary: `Features of ${c.title}`,
        operationId: `items_${c.id}`,
        parameters: params,
        responses: { 200: geojson('GeoJSON FeatureCollection', { $ref: '#/components/schemas/featureCollection' }), 400: ref400(), 404: ref404() }
      }
    }
    paths[`/collections/${c.id}/items/{featureId}`] = {
      get: {
        summary: `One feature of ${c.title}`,
        operationId: `item_${c.id}`,
        parameters: [{ name: 'featureId', in: 'path', required: true, schema: { type: 'integer' } }, ref('crs'), ref('f')],
        responses: { 200: geojson('GeoJSON Feature', { $ref: '#/components/schemas/feature' }), 404: ref404() }
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: service.title, description: service.description || `OGC API – Features from Unity Catalog, served by LakeGate`, version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      parameters: {
        bbox: { name: 'bbox', in: 'query', required: false, style: 'form', explode: false, schema: { type: 'array', minItems: 4, maxItems: 6, items: { type: 'number' } } },
        'bbox-crs': { name: 'bbox-crs', in: 'query', required: false, schema: { type: 'string', format: 'uri', enum: SUPPORTED } },
        crs: { name: 'crs', in: 'query', required: false, schema: { type: 'string', format: 'uri', enum: SUPPORTED } },
        limit: { name: 'limit', in: 'query', required: false, style: 'form', explode: false, schema: { type: 'integer', minimum: 1, maximum: maxLimit, default: defaultLimit } },
        offset: { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
        cursor: { name: 'cursor', in: 'query', required: false, description: 'Id of the last feature of the previous page (next links set it)', schema: { type: 'integer' } },
        datetime: { name: 'datetime', in: 'query', required: false, style: 'form', explode: false, schema: { type: 'string' } },
        f: { name: 'f', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'geojson'] } }
      },
      responses: {
        400: { description: 'Invalid parameter', content: { 'application/json': { schema: { $ref: '#/components/schemas/exception' } } } },
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/exception' } } } }
      },
      schemas: {
        exception: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, description: { type: 'string' } } },
        link: { type: 'object', required: ['href'], properties: { href: { type: 'string' }, rel: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' } } },
        feature: { type: 'object', required: ['type', 'geometry', 'properties'], properties: { type: { type: 'string', enum: ['Feature'] }, id: { type: 'integer' }, geometry: { type: 'object', nullable: true }, properties: { type: 'object', nullable: true }, links: { type: 'array', items: { $ref: '#/components/schemas/link' } } } },
        featureCollection: { type: 'object', required: ['type', 'features'], properties: { type: { type: 'string', enum: ['FeatureCollection'] }, features: { type: 'array', items: { $ref: '#/components/schemas/feature' } }, links: { type: 'array', items: { $ref: '#/components/schemas/link' } }, timeStamp: { type: 'string', format: 'date-time' }, numberMatched: { type: 'integer', minimum: 0 }, numberReturned: { type: 'integer', minimum: 0 } } }
      }
    }
  }
}

function ref400 () { return { $ref: '#/components/responses/400' } }
function ref404 () { return { $ref: '#/components/responses/404' } }

module.exports = { buildOpenApi, jsonType }
