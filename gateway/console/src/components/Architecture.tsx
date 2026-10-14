// How LakeGate fits: map clients -> LakeGate (one per Unity Catalog metastore) -> SQL warehouse ->
// Unity Catalog, which holds both the data and the gateway's settings. House style: teal header bands,
// red flow arrows, green governed-access arrow, featured boxes in #fff3f0 with a Databricks-red border,
// light-gray context boxes, Arial.

const TEAL = '#1b3139'
const RED = '#ff3621'
const GREEN = '#00a972'
const GRAY_FILL = '#e9ebee'
const BORDER = '#c9ced3'
const FEATURE_FILL = '#fff3f0'
const TEXT = '#1b3139'
const MUTED = '#5a6b73'

function Band ({ x, w, title }: { x: number, w: number, title: string }) {
  return (
    <g>
      <rect x={x} y={20} width={w} height={34} rx={8} fill={TEAL} />
      <text x={x + w / 2} y={42} textAnchor='middle' fill='#fff' fontSize={14} fontWeight={700}>{title}</text>
      <rect x={x} y={62} width={w} height={474} rx={10} fill='#fff' stroke={BORDER} strokeDasharray='4 4' />
    </g>
  )
}

function Box ({ x, y, w, h, title, lines = [], featured = false, gray = false, shadow = true }: {
  x: number, y: number, w: number, h: number, title: string, lines?: string[], featured?: boolean, gray?: boolean, shadow?: boolean
}) {
  return (
    <g filter={shadow ? 'url(#shadow)' : undefined}>
      <rect x={x} y={y} width={w} height={h} rx={8}
        fill={featured ? FEATURE_FILL : gray ? GRAY_FILL : '#fff'}
        stroke={featured ? RED : BORDER} strokeWidth={featured ? 2.5 : 1} />
      <text x={x + 12} y={y + 22} fill={TEXT} fontSize={13} fontWeight={700}>{title}</text>
      {lines.map((l, i) => <text key={i} x={x + 12} y={y + 41 + i * 16} fill={MUTED} fontSize={11.5}>{l}</text>)}
    </g>
  )
}

function Label ({ x, y, color, children, anchor = 'middle' }: { x: number, y: number, color: string, children: string, anchor?: 'middle' | 'start' }) {
  return (
    <text x={x} y={y} fill={color} fontSize={11} fontWeight={700} textAnchor={anchor}
      stroke='#fff' strokeWidth={4} paintOrder='stroke' strokeLinejoin='round'>{children}</text>
  )
}

// Red = requests and data, green = governed access, gray dotted (no heads) = related, not a data flow
function Arrow ({ d, color = RED, label, lx, ly, dashed = false }: {
  d: string, color?: string, label?: string, lx?: number, ly?: number, dashed?: boolean
}) {
  const marker = color === GREEN ? 'url(#greenHead)' : 'url(#redHead)'
  return (
    <g>
      <path d={d} fill='none' stroke={color} strokeWidth={2.5} strokeDasharray={dashed ? '6 5' : undefined} markerEnd={marker} />
      {label && <Label x={lx!} y={ly!} color={color === GREEN ? '#00804f' : '#c22a14'}>{label}</Label>}
    </g>
  )
}

export function Architecture () {
  return (
    <svg viewBox='0 0 1120 556' role='img' aria-labelledby='arch-title arch-desc' style={{ width: '100%', height: 'auto', fontFamily: 'Arial, Helvetica, sans-serif' }}>
      <title id='arch-title'>How LakeGate fits between map clients and Databricks</title>
      <desc id='arch-desc'>ArcGIS and OGC API clients call a LakeGate gateway, one per Unity Catalog metastore. The gateway runs FeatureServer and OGC API queries on a SQL warehouse as the signed-in user, so Unity Catalog permissions apply. Its settings and the data are Unity Catalog tables.</desc>
      <defs>
        <filter id='shadow' x='-10%' y='-10%' width='120%' height='130%'><feDropShadow dx='0' dy='2' stdDeviation='2.5' floodColor='#1b3139' floodOpacity='0.12' /></filter>
        <marker id='redHead' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill={RED} /></marker>
        <marker id='greenHead' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill={GREEN} /></marker>
      </defs>

      <Band x={20} w={300} title='Map clients' />
      <Band x={410} w={320} title='Databricks workspace' />
      <Band x={800} w={300} title='Lakehouse' />

      <Box x={40} y={82} w={260} h={92} featured title='Experience Builder app'
        lines={['Databricks Data widget', 'pick workspace, warehouse, catalogs', 'layers become ExB data sources']} />
      <Box x={40} y={190} w={260} h={74} gray title='Esri widgets'
        lines={['Map Layers, Legend, Table,', 'Filter, Edit']} />
      <Box x={40} y={280} w={260} h={74} gray title='ArcGIS Maps SDK apps, scripts'
        lines={['FeatureServer layer URL', 'with a Databricks OAuth token']} />
      <Box x={40} y={370} w={260} h={74} gray title='OGC API clients'
        lines={['QGIS, GDAL/OGR, OpenLayers, MapLibre,', 'pipelines with an OAuth token']} />
      <Box x={40} y={460} w={260} h={54} gray title='Viewer' lines={['signs in once per gateway']} />

      <Box x={430} y={82} w={280} h={70} gray title='Databricks Apps front door'
        lines={['Databricks SSO, token per workspace', 'CORS: allow-listed origins']} />
      <Box x={430} y={196} w={280} h={170} featured title='LakeGate (this app)'
        lines={['FeatureServer layer per UC table', 'OGC API – Features services', 'queries run as the viewer (OBO)', 'geometry + id by type and content', 'warehouse allow-list, catalog scope', 'one per metastore, same bundle']} />
      <Box x={430} y={430} w={280} h={84} title='Other metastores'
        lines={['their own LakeGate gateway', '(e.g. gov in GovCloud)', 'listed in the workspace directory']} />

      <Box x={820} y={82} w={260} h={92} title='SQL warehouse (serverless)'
        lines={['bbox pushdown with ST_Intersects', 'paging, counts, extents', 'allow-listed per gateway']} />
      <Box x={820} y={222} w={260} h={292} featured title='Unity Catalog'
        lines={['grants, row filters and column masks', 'decide what each viewer sees']} />
      <Box x={836} y={292} w={228} h={92} gray shadow={false} title='Delta tables'
        lines={['Maritime, Overture, AIS, ...', 'data stays in Databricks', '(nothing copied to ArcGIS)']} />
      <Box x={836} y={398} w={228} h={100} gray shadow={false} title='LakeGate settings'
        lines={['OGC services', 'layer overrides', 'UC tables, read as the viewer']} />

      <Arrow d='M300 118 L428 118' label='sign in (popup)' lx={364} ly={108} dashed />
      <Arrow d='M300 150 C366 150 362 232 428 232' label='FeatureServer queries' lx={352} ly={186} />
      <Arrow d='M300 317 C366 317 362 290 428 290' label='layer URLs' lx={352} ly={300} />
      <Arrow d='M300 407 C368 407 360 340 428 340' label='OGC API (GeoJSON)' lx={356} ly={392} />
      <Arrow d='M570 152 L570 194' />
      <Arrow d='M710 240 C764 240 766 128 818 128' />
      <Label x={766} y={262} color='#c22a14'>SQL as</Label>
      <Label x={766} y={276} color='#c22a14'>the viewer</Label>
      <Arrow d='M950 174 L950 220' color={GREEN} label='governed access' lx={1006} ly={202} />
      <path d='M570 366 L570 430' fill='none' stroke={MUTED} strokeWidth={2} strokeDasharray='2 5' strokeLinecap='round' />
      <Label x={580} y={402} color={MUTED} anchor='start'>peers, not a data path</Label>
    </svg>
  )
}
