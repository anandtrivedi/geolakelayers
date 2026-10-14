import { useEffect, useState } from 'react'
import { api } from '../api'
import type { LayerOverride, LayerSpec } from '../api'

type Column = { name: string, type: string }
const LONLAT = '__lonlat'
const isGeomType = (t: string) => /^(geometry|geography|string|binary|varchar)/.test(t)
const isNum = (t: string) => /^(double|float|decimal|int|bigint|smallint)/.test(t)
const isIdType = (t: string) => /^(tinyint|smallint|int|integer|bigint|string)$/.test(t)

const geometryHow = (s: LayerSpec) => ({ type: 'its column type', content: 'sampling its values', override: 'an author’s setting' })[s.geometryDetectedBy]
const idHow = (s: LayerSpec) => s.idSource === 'primary key'
  ? <>the table's primary key <code>{s.objectId}</code></>
  : s.idSource === 'override'
    ? <>an author's setting (<code>{s.syntheticIdFrom || s.objectId}</code>{s.syntheticIdFrom ? ', hashed' : ''})</>
    : <>derived from the whole row. Fine for viewing; editing needs a primary key or a chosen integer id column.</>

// How the gateway reads a table (geometry, object id) and the author's override when that's wrong or missing
export function LayerSettings ({ table, spec, columns, override, onChanged }: {
  table: string, spec: LayerSpec | null, columns: Column[], override: (LayerOverride & { updatedBy?: string }) | null, onChanged: () => void
}) {
  const [info, setInfo] = useState<{ enabled: boolean, table: string | null, missing: boolean } | null>(null)
  const [editing, setEditing] = useState(!spec)
  const [geom, setGeom] = useState(override?.lonColumn ? LONLAT : override?.geometryColumn || '')
  const [lon, setLon] = useState(override?.lonColumn || '')
  const [lat, setLat] = useState(override?.latColumn || '')
  const [srid, setSrid] = useState(override?.srid ? String(override.srid) : '')
  const [id, setId] = useState(override?.idColumn || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { api.overridesInfo().then(setInfo).catch(() => setInfo(null)) }, [])

  const geomCol = columns.find(c => c.name === geom)
  const textGeom = geomCol && !/^(geometry|geography)/.test(geomCol.type)
  const valid = (geom !== LONLAT || (lon && lat && lon !== lat)) && (geom || id) && (!srid || /^\d{1,6}$/.test(srid))

  const save = async () => {
    setBusy(true); setError('')
    const o: LayerOverride = {
      geometryColumn: geom && geom !== LONLAT ? geom : null,
      lonColumn: geom === LONLAT ? lon : null,
      latColumn: geom === LONLAT ? lat : null,
      srid: textGeom && srid ? Number(srid) : null,
      idColumn: id || null
    }
    try { await api.saveOverride(table, o); setEditing(false); onChanged() } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true); setError('')
    try { await api.clearOverride(table); onChanged() } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }
  const setup = async () => {
    setBusy(true); setError('')
    try { await api.overridesSetup(); setInfo(await api.overridesInfo()) } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div className='optimize layer-settings'>
      <div className='settings-head'>
        <h4>How it's read</h4>
        {info?.enabled && !editing && <button className='button ghost' onClick={() => setEditing(true)}>Change</button>}
      </div>
      {spec && (
        <ul className='plain how'>
          <li>Geometry: <code>{spec.geometryColumn || spec.geometrySource}</code>, found by {geometryHow(spec)}.</li>
          <li>Object id: {idHow(spec)}</li>
          {override && <li className='muted small'>Override set by {override.updatedBy || 'an author'}. It applies to everyone who uses this table through the gateway.</li>}
        </ul>
      )}
      {info && !info.enabled && <p className='muted small'>Overrides are off on this gateway (bundle variable <code>layer_overrides_table</code>).</p>}
      {info?.enabled && info.missing && editing && (
        <div>
          <p className='muted small'>The overrides table <code>{info.table}</code> doesn't exist yet. Creating it needs CREATE TABLE on its schema; everyone gets SELECT on it, and whoever should set overrides needs MODIFY.</p>
          <button className='button' disabled={busy} onClick={setup}>Create overrides table</button>
        </div>
      )}
      {info?.enabled && !info.missing && editing && (
        <div className='override-form'>
          <label>Geometry
            <select value={geom} onChange={e => setGeom(e.target.value)}>
              <option value=''>Detect automatically</option>
              {columns.filter(c => isGeomType(c.type)).map(c => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)}
              <option value={LONLAT}>Longitude and latitude columns</option>
            </select>
          </label>
          {geom === LONLAT && (
            <>
              <label>Longitude
                <select value={lon} onChange={e => setLon(e.target.value)}>
                  <option value=''>Pick a column</option>
                  {columns.filter(c => isNum(c.type)).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </label>
              <label>Latitude
                <select value={lat} onChange={e => setLat(e.target.value)}>
                  <option value=''>Pick a column</option>
                  {columns.filter(c => isNum(c.type)).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </label>
            </>
          )}
          {textGeom && (
            <label>SRID (EPSG)
              <input value={srid} onChange={e => setSrid(e.target.value)} placeholder='from the data, else 4326' />
            </label>
          )}
          <label>Object id
            <select value={id} onChange={e => setId(e.target.value)}>
              <option value=''>Primary key, else derived</option>
              {columns.filter(c => isIdType(c.type)).map(c => <option key={c.name} value={c.name}>{c.name} ({c.type}{c.type === 'string' ? ', hashed' : ''})</option>)}
            </select>
          </label>
          <div className='card-actions'>
            <button className='button' disabled={!valid || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            {override && <button className='button ghost' disabled={busy} onClick={clear}>Remove override</button>}
            {spec && <button className='button ghost' onClick={() => setEditing(false)}>Cancel</button>}
          </div>
          <p className='muted small override-note'>
            Pick an id column only if its values are unique and never change: ArcGIS selects, pages and edits by it.
            Saving needs MODIFY on <code>{info.table}</code>.
          </p>
        </div>
      )}
      {error && <p className='error small'>{error}</p>}
    </div>
  )
}
