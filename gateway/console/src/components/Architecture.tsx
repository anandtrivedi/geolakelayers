// How ArcGateway fits: ArcGIS clients -> ArcGateway (one per Databricks workspace) -> SQL warehouse +
// Unity Catalog. House style: teal header bands, red flow arrows, green native-access arrows,
// featured boxes in #fff3f0 with a Databricks-red border, light-gray client boxes, Arial.

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
      <rect x={x} y={62} width={w} height={378} rx={10} fill='#fff' stroke={BORDER} strokeDasharray='4 4' />
    </g>
  )
}

function Box ({ x, y, w, h, title, lines = [], featured = false, gray = false }: {
  x: number, y: number, w: number, h: number, title: string, lines?: string[], featured?: boolean, gray?: boolean
}) {
  return (
    <g filter='url(#shadow)'>
      <rect x={x} y={y} width={w} height={h} rx={8}
        fill={featured ? FEATURE_FILL : gray ? GRAY_FILL : '#fff'}
        stroke={featured ? RED : BORDER} strokeWidth={featured ? 2.5 : 1} />
      <text x={x + 12} y={y + 22} fill={TEXT} fontSize={13} fontWeight={700}>{title}</text>
      {lines.map((l, i) => <text key={i} x={x + 12} y={y + 41 + i * 16} fill={MUTED} fontSize={11.5}>{l}</text>)}
    </g>
  )
}

function Arrow ({ d, color = RED, label, lx, ly, both = false, dashed = false }: {
  d: string, color?: string, label?: string, lx?: number, ly?: number, both?: boolean, dashed?: boolean
}) {
  const marker = color === GREEN ? 'url(#greenHead)' : 'url(#redHead)'
  return (
    <g>
      <path d={d} fill='none' stroke={color} strokeWidth={2.5} strokeDasharray={dashed ? '6 5' : undefined}
        markerEnd={marker} markerStart={both ? marker : undefined} />
      {label && <text x={lx} y={ly} fill={color === GREEN ? '#00804f' : '#c22a14'} fontSize={11} fontWeight={700} textAnchor='middle'
        stroke='#fff' strokeWidth={4} paintOrder='stroke' strokeLinejoin='round'>{label}</text>}
    </g>
  )
}

export function Architecture () {
  return (
    <svg viewBox='0 0 1120 460' role='img' aria-labelledby='arch-title arch-desc' style={{ width: '100%', height: 'auto', fontFamily: 'Arial, Helvetica, sans-serif' }}>
      <title id='arch-title'>How ArcGateway fits between ArcGIS and Databricks</title>
      <desc id='arch-desc'>ArcGIS clients call an ArcGateway in each Databricks workspace. The gateway runs FeatureServer queries on a SQL warehouse as the signed-in user, so Unity Catalog permissions apply.</desc>
      <defs>
        <filter id='shadow' x='-10%' y='-10%' width='120%' height='130%'><feDropShadow dx='0' dy='2' stdDeviation='2.5' floodColor='#1b3139' floodOpacity='0.12' /></filter>
        <marker id='redHead' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill={RED} /></marker>
        <marker id='greenHead' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill={GREEN} /></marker>
      </defs>

      <Band x={20} w={300} title='ArcGIS (Portal / Enterprise)' />
      <Band x={410} w={320} title='Databricks workspace' />
      <Band x={800} w={300} title='Lakehouse (per workspace)' />

      <Box x={40} y={82} w={260} h={92} featured title='Experience Builder app'
        lines={['Databricks Data widget', 'pick workspace, warehouse, catalogs', 'layers become ExB data sources']} />
      <Box x={40} y={190} w={260} h={74} gray title='Esri widgets'
        lines={['Map Layers, Legend, Table,', 'Filter, Feature Info']} />
      <Box x={40} y={280} w={260} h={74} gray title='Map Viewer, ArcGIS Pro, SDK apps'
        lines={['any client that reads', 'a FeatureServer layer URL']} />
      <Box x={40} y={370} w={260} h={54} gray title='Viewer' lines={['signs in once per workspace']} />

      <Box x={430} y={82} w={280} h={70} gray title='Databricks Apps front door'
        lines={['Databricks SSO, token per workspace', 'CORS: allow-listed Portal origins']} />
      <Box x={430} y={170} w={280} h={140} featured title='ArcGateway (this app)'
        lines={['FeatureServer API per UC table', 'queries run as the viewer (OBO)', 'geometry + id detected per table', 'warehouse allow-list, catalog scope', 'one per workspace, same bundle']} />
      <Box x={430} y={328} w={280} h={96} title='Other workspaces'
        lines={['another ArcGateway per workspace', '(e.g. gov: own metastore)', 'listed in the workspace directory']} />

      <Box x={820} y={82} w={260} h={92} title='SQL warehouse (serverless)'
        lines={['bbox pushdown with ST_Intersects', 'paging, counts, extents', 'allow-listed per gateway']} />
      <Box x={820} y={200} w={260} h={112} featured title='Unity Catalog'
        lines={['tables: GEOMETRY / WKT / WKB /', 'lon-lat; integer or string ids', 'grants decide what each', 'viewer sees']} />
      <Box x={820} y={330} w={260} h={94} gray title='Delta tables'
        lines={['Maritime, Overture, AIS, ...', 'data stays in Databricks', '(nothing copied to ArcGIS)']} />

      <Arrow d='M300 118 L428 118' label='sign in (popup)' lx={364} ly={108} dashed />
      <Arrow d='M300 140 C360 140 370 220 428 220' label='FeatureServer queries' lx={352} ly={196} />
      <Arrow d='M300 318 C370 318 370 260 428 260' label='layer URLs' lx={350} ly={302} />
      <Arrow d='M570 152 L570 168' />
      <Arrow d='M710 210 C760 210 770 128 818 128' label='SQL as the viewer' lx={792} ly={196} />
      <Arrow d='M950 176 L950 198' color={GREEN} both />
      <Arrow d='M950 314 L950 328' color={GREEN} both />
      <Arrow d='M570 312 L570 326' dashed />
    </svg>
  )
}
