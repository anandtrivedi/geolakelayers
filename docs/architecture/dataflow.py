# Builds geolakelayers-dataflow.svg: how a map request moves through GeoLakeLayers.
#   python3 docs/architecture/dataflow.py   (then export a PNG with docs/architecture/export.mjs)
from html import escape
from pathlib import Path

W, H = 1920, 1310
CORAL, BLUE, NAVY, OAT, INK, MUTED, LINE = '#FF6B4A', '#4FC3E8', '#0B2026', '#F9F7F4', '#0B2026', '#5A6B70', '#C9CFCF'
BLUE_TXT = '#167A99'  # lake blue darkened for text on oat
FONT = "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif"
out = []


def t(x, y, s, size=15, weight=400, fill=INK, anchor='start', italic=False):
    st = ' font-style="italic"' if italic else ''
    out.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{st}>{escape(s)}</text>')


def box(x, y, w, h, title, lines=(), fill='#FFFFFF', stroke=LINE, dash=None, title_fill=INK, r=10, sw=1.5):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
    t(x + 16, y + 28, title, 17, 700, title_fill)
    for i, line in enumerate(lines):
        t(x + 16, y + 52 + i * 21, line, 14.5, 400, MUTED)


def badge(x, y, n, color=CORAL):
    out.append(f'<circle cx="{x}" cy="{y}" r="13" fill="{color}"/>')
    t(x, y + 5, str(n), 14, 700, '#FFFFFF', 'middle')


def arrow(points, color=CORAL, dash=None, w=2.4, head='coral'):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    pts = ' '.join(f'{x},{y}' for x, y in points)
    out.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="{w}"{d} stroke-linejoin="round" marker-end="url(#{head})"/>')


def label(x, y, s, color=CORAL, anchor='start', size=13.5):
    t(x, y, s, size, 700, color, anchor)


# ---- header ----------------------------------------------------------------------------------------
out.append(f'<rect width="{W}" height="{H}" fill="{OAT}"/>')
out.append('<g transform="translate(40,30) scale(1.9)">'
           f'<path fill-rule="evenodd" fill="{CORAL}" d="M16 2.5C10.8 2.5 7 6.4 7 11.3C7 17.2 16 24.5 16 24.5C16 24.5 25 17.2 25 11.3C25 6.4 21.2 2.5 16 2.5ZM16 14.8C17.9 14.8 19.4 13.3 19.4 11.4C19.4 9.5 17.9 8 16 8C14.1 8 12.6 9.5 12.6 11.4C12.6 13.3 14.1 14.8 16 14.8Z"/>'
           f'<path fill="none" stroke="{BLUE}" stroke-width="2" stroke-linecap="round" d="M3.5 26.2C5.6 24.8 7.7 24.8 9.8 26.2C11.9 27.6 14 27.6 16.1 26.2C18.2 24.8 20.3 24.8 22.4 26.2C24.5 27.6 26.6 27.6 28.5 26.2"/>'
           f'<path fill="none" stroke="{BLUE}" stroke-width="2" stroke-linecap="round" opacity="0.6" d="M6.5 30C8.3 28.8 10.1 28.8 11.9 30C13.7 31.2 15.5 31.2 17.3 30C19.1 28.8 20.9 28.8 22.7 30C24 30.8 25 30.9 25.6 30.6"/></g>')
t(112, 62, 'How a map request moves through GeoLakeLayers', 34, 700)
t(112, 94, 'Unity Catalog tables as live map layers, queried as each signed-in viewer. Nothing is copied to ArcGIS or the client.', 17, 400, MUTED)
# legend
lx = 1440
arrow([(lx, 50), (lx + 52, 50)])
t(lx + 64, 55, 'request', 14, 400, MUTED)
arrow([(lx + 150, 50), (lx + 202, 50)], BLUE, '7 5', head='blue')
t(lx + 214, 55, 'token / results', 14, 400, MUTED)
arrow([(lx, 82), (lx + 52, 82)], CORAL, '3 5', 2, head='coral')
t(lx + 64, 87, 'the one copy (on request)', 14, 400, MUTED)

# ---- column headings ---------------------------------------------------------------------------------
for x, w, s in [(40, 340, 'Map clients'), (560, 490, 'GeoLakeLayers · a Databricks App'), (1100, 330, 'Compute'), (1500, 380, 'Unity Catalog')]:
    out.append(f'<rect x="{x}" y="138" width="{w}" height="40" rx="8" fill="{NAVY}"/>')
    t(x + w / 2, 165, s, 17, 700, '#FFFFFF', 'middle')

# ---- map clients -------------------------------------------------------------------------------------
box(40, 196, 340, 170, 'Experience Builder app', ['Databricks Data widget', 'signs in once per gateway', 'then every request carries', 'Authorization: Bearer <viewer token>'])
box(40, 396, 340, 130, 'QGIS · GDAL · OpenLayers · MapLibre', ['OGC API – Features (GeoJSON)', 'Bearer = a Databricks OAuth token (~1 h)'])
box(40, 556, 340, 120, 'Scripts and notebooks', ['Esri FeatureServer REST', 'OAuth token; personal access tokens refused'])
box(40, 720, 340, 126, 'The map draws', ['filters, charts and tables reuse the same', 'queries; each viewer sees only their rows'], fill='#EEF8FB', stroke=BLUE)

# ---- the app -----------------------------------------------------------------------------------------
out.append(f'<rect x="560" y="196" width="490" height="650" rx="12" fill="#FFFFFF" stroke="{CORAL}" stroke-width="2"/>')
IX, IW = 584, 442
box(IX, 216, IW, 70, '/auth/handoff', ['posts the viewer\'s token to the page, allowed origins only'], fill=OAT)
box(IX, 316, IW, 70, 'FeatureServer and OGC routes', ['a pan or zoom = bbox, zoom level, filters, paging'], fill=OAT)
box(IX, 416, IW, 80, 'Table spec', ['geometry and object id by column type and content,', 'never by name; overrides applied; cached per viewer'], fill=OAT)
box(IX, 526, IW, 80, 'SQL builder', ['bbox → ST_Intersects pushdown · zoomed out →', 'ST_Simplify · paging · named parameters'], fill=OAT)
box(IX, 636, IW, 64, 'Per-viewer cache, 5 min', ['a repeated request never reaches the warehouse'], fill=OAT)
box(IX, 730, IW, 96, 'Encoder', ['rows → Esri JSON (FeatureServer) or GeoJSON (OGC),', 'CRS84 or EPSG:3857'], fill=OAT)
for y0, y1 in [(386, 416), (496, 526), (606, 636)]:
    arrow([(805, y0 + 1), (805, y1 - 3)], CORAL, w=2)

# ---- compute -----------------------------------------------------------------------------------------
out.append(f'<rect x="1100" y="520" width="330" height="326" rx="12" fill="#FFFFFF" stroke="{LINE}" stroke-width="1.5"/>')
box(1116, 536, 298, 132, 'SQL warehouse (serverless)', ['one session per viewer (on behalf of)', 'writes, ST_Simplify and anything RT', 'refuses run here; open tables as the app'], fill=OAT)
box(1116, 706, 298, 124, 'Lakehouse//RT (optional)', ['map-sized SELECTs when the app or', 'OGC service picks it; refusals and', 'outages fall back to the warehouse'], fill='#EEF8FB', stroke=BLUE)
arrow([(1265, 706), (1265, 671)], BLUE, '6 4', 2, head='blue')
label(1276, 694, 'fallback', BLUE_TXT, size=12.5)

# ---- unity catalog -------------------------------------------------------------------------------------
box(1500, 196, 380, 110, 'GeoLakeLayers settings', ['ogc_services · layer_overrides (UC tables)', 'read as the viewer; MODIFY to change them'])
box(1500, 326, 380, 104, 'Open tables', ['admin-listed; read as the app\'s service', 'principal so anyone signed in can see them'])
box(1500, 450, 380, 120, 'Grants · row filters · column masks', ['checked for the viewer on every query', 'the app needs no data grants (open tables aside)'], stroke=NAVY, sw=2)
box(1500, 590, 380, 150, 'Delta tables', ['GEOMETRY / GEOGRAPHY, or WKT, WKB,', 'GeoJSON stored as text or binary', 'the data stays here'], stroke=NAVY, sw=2)
box(1500, 760, 380, 86, 'Optimize for maps: the one copy', ['on request, written as the viewer'], stroke=CORAL, dash='5 5')
arrow([(1690, 570), (1690, 587)], NAVY, w=2, head='navy')
arrow([(1690, 760), (1690, 743)], CORAL, '3 5', 2)

# ---- flows ---------------------------------------------------------------------------------------------
# 1 sign in, 2 token handed to the widget (captions in the steps strip)
arrow([(380, 244), (581, 244)])
badge(432, 230, 1)
arrow([(584, 272), (383, 272)], BLUE, '7 5', head='blue')
badge(432, 296, 2, BLUE)
# 3 requests with Bearer
arrow([(380, 351), (581, 351)])
arrow([(380, 456), (477, 456)])
arrow([(380, 616), (477, 616)])
badge(432, 376, 3)
# 4 spec reads settings (and the table's own DESCRIBE / sample)
arrow([(1026, 436), (1075, 436), (1075, 251), (1497, 251)], BLUE, '7 5', 2, head='blue')
badge(1075, 300, 4, BLUE); label(1095, 305, 'overrides, DESCRIBE, sample', BLUE_TXT, size=12.5)
# 5 SQL to compute
arrow([(1026, 668), (1097, 668)])
badge(1063, 646, 5)
# open tables
arrow([(1265, 536), (1265, 378), (1497, 378)], NAVY, '2 4', 1.8, head='navy')
label(1276, 508, 'open tables, as the app', NAVY, size=12.5)
# 6 query as the viewer
arrow([(1430, 556), (1497, 556)], NAVY, w=2.4, head='navy')
badge(1464, 536, 6, NAVY)
# results back
arrow([(1500, 664), (1433, 664)], BLUE, '7 5', head='blue')
arrow([(1100, 780), (1029, 780)], BLUE, '7 5', head='blue')
arrow([(584, 780), (383, 780)], BLUE, '7 5', head='blue')
badge(432, 806, 7, BLUE)

# ---- front door (a gate every request passes) ----------------------------------------------------------
out.append(f'<rect x="480" y="196" width="52" height="650" rx="10" fill="{NAVY}"/>')
out.append(f'<text transform="translate(512,521) rotate(-90)" font-size="14.5" font-weight="700" fill="#FFFFFF" text-anchor="middle" letter-spacing="0.2">Databricks Apps front door  ·  SSO  ·  CORS allow-list  ·  forwards the viewer\'s token</text>')

# ---- numbered steps ----------------------------------------------------------------------------------
steps = [(1, CORAL, 'Sign in', ['the widget opens /auth/handoff', 'in a popup; Databricks SSO']),
         (2, BLUE, 'Token handed back', ['posted to the page, only for', 'origins in allowed_origins']),
         (3, CORAL, 'Every request', ['carries Authorization: Bearer', 'through the front door']),
         (4, BLUE, 'Table spec', ['geometry and id from types,', 'content and overrides']),
         (5, CORAL, 'SQL', ['bbox pushdown, ST_Simplify;', 'a cache hit stops here']),
         (6, NAVY, 'Runs as the viewer', ['Unity Catalog applies grants,', 'row filters and masks']),
         (7, BLUE, 'Back to the map', ['Esri JSON or GeoJSON;', 'the layer draws'])]
sw = 1840 / len(steps)
for i, (n, c, head, lines) in enumerate(steps):
    x = 40 + i * sw
    badge(x + 14, 890, n, c)
    t(x + 36, 896, head, 16, 700)
    for k, line in enumerate(lines):
        t(x + 36, 918 + k * 19, line, 13.5, 400, MUTED)

# ---- the other path ------------------------------------------------------------------------------------
py = 980
out.append(f'<rect x="40" y="{py}" width="1840" height="290" rx="14" fill="#FFFFFF" stroke="{LINE}" stroke-width="1.5"/>')
t(64, py + 40, 'Two ways to put Databricks tables on ArcGIS maps', 22, 700)
t(64, py + 68, 'GeoLakeLayers sits on the Databricks side. The Custom Data Feed sits on the ArcGIS side. Pick by the clients you need and whose permissions should apply.', 15, 400, MUTED)
rows = [('', 'GeoLakeLayers (above)', 'Custom Data Feed'),
        ('Runs', 'a Databricks App; nothing installed in ArcGIS', 'ArcGIS Server 11.4+ with the Custom Data Feeds runtime'),
        ('Who sees what', 'each viewer\'s own Unity Catalog grants', 'one Databricks identity per service; Portal sharing decides'),
        ('Clients', 'Experience Builder (widget), OGC API clients, scripts', 'every Esri app: Map Viewer, ArcGIS Pro, Field Maps'),
        ('Set up by', 'a Databricks admin', 'an ArcGIS Server admin')]
cx = [64, 260, 690]
for i, r in enumerate(rows):
    y = py + 110 + i * 34
    if i:
        out.append(f'<line x1="64" y1="{y - 24}" x2="1100" y2="{y - 24}" stroke="#E6E9E9"/>')
    for j, c in enumerate(r):
        t(cx[j], y, c, 15 if i else 14, 700 if (i == 0 or j == 0) else 400, (MUTED if i == 0 else INK))
# mini flow for the CDF path
mx, my = 1160, py + 104
for k, (s, sub) in enumerate([('Map Viewer · Pro · Field Maps', 'any Esri client'), ('ArcGIS Server + CDF', 'feature services in Portal'), ('SQL warehouse or Lakebase', 'one service principal or token')]):
    y = my + k * 64
    out.append(f'<rect x="{mx}" y="{y}" width="320" height="48" rx="8" fill="{OAT}" stroke="{LINE}"/>')
    t(mx + 14, y + 21, s, 15, 700)
    t(mx + 14, y + 39, sub, 12.5, 400, MUTED)
    if k < 2:
        arrow([(mx + 160, y + 48), (mx + 160, y + 61)], MUTED, w=2, head='muted')
t(mx + 340, my + 22, 'For layers that must open', 14, 400, MUTED)
t(mx + 340, my + 42, 'in Map Viewer, ArcGIS Pro', 14, 400, MUTED)
t(mx + 340, my + 62, 'or Field Maps, use the', 14, 400, MUTED)
t(mx + 340, my + 82, 'Custom Data Feed:', 14, 400, MUTED)
t(mx + 340, my + 106, 'github.com/anandtrivedi/', 14, 700, BLUE_TXT)
t(mx + 340, my + 126, 'esri-customdatafeed', 14, 700, BLUE_TXT)

marks = ''.join(f'<marker id="{n}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>'
                for n, c in [('coral', CORAL), ('blue', BLUE), ('navy', NAVY), ('muted', MUTED)])
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}" role="img" aria-labelledby="t d">'
       '<title id="t">How a map request moves through GeoLakeLayers</title>'
       '<desc id="d">Map clients sign in through the Databricks Apps front door, the gateway builds SQL that runs as the viewer on a SQL warehouse or Lakehouse//RT, Unity Catalog enforces grants, and results return as Esri JSON or GeoJSON. A panel compares the ArcGIS-side Custom Data Feed.</desc>'
       f'<defs>{marks}</defs>' + '\n'.join(out) + '</svg>\n')
Path(__file__).with_name('geolakelayers-dataflow.svg').write_text(svg)
print('wrote geolakelayers-dataflow.svg')
