/*
  crs.js — the two coordinate reference systems ArcGateway's OGC API offers (OGC API – Features Part 2):
  CRS84 (lon/lat WGS 84, the default and storage CRS) and EPSG:3857 (Web Mercator)
*/

const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
const EPSG3857 = 'http://www.opengis.net/def/crs/EPSG/0/3857'
const SUPPORTED = [CRS84, EPSG3857]

const R = 6378137
const MAX_LAT = 85.0511287798066

function toWgs84 ([x, y]) {
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)]
}

function toWebMercator ([lon, lat]) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  return [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360)) * R]
}

// Apply fn to every position of a GeoJSON geometry (returns a new geometry; extra ordinates such as z kept)
function mapPositions (geometry, fn) {
  if (!geometry) return geometry
  const pos = p => { const [x, y] = fn([p[0], p[1]]); return p.length > 2 ? [x, y, ...p.slice(2)] : [x, y] }
  const deep = (c, depth) => depth === 0 ? pos(c) : c.map(x => deep(x, depth - 1))
  const depths = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 }
  if (geometry.type === 'GeometryCollection') {
    return { ...geometry, geometries: (geometry.geometries || []).map(g => mapPositions(g, fn)) }
  }
  if (!(geometry.type in depths) || !geometry.coordinates) return geometry
  return { ...geometry, coordinates: deep(geometry.coordinates, depths[geometry.type]) }
}

const reproject = (geometry, crs) => crs === EPSG3857 ? mapPositions(geometry, toWebMercator) : geometry

module.exports = { CRS84, EPSG3857, SUPPORTED, toWgs84, toWebMercator, mapPositions, reproject }
