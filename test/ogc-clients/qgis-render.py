"""Render a GeoLakeLayers OGC service in QGIS (headless) to screenshots/ogc-qgis.png.

QGIS reads the collections through its own OGC API – Features provider (OAPIF) with an "API Header" auth
config holding a Databricks OAuth token, exactly as a QGIS desktop user would connect. Run with QGIS's Python:
  R=/Applications/QGIS-final-4_2_3.app/Contents/Resources/python3.12   # its stdlib, needed from a shell
  PYTHONHOME=$R PYTHONPATH=$R:$R/site-packages:$R/lib-dynload \
    /Applications/QGIS-final-4_2_3.app/Contents/MacOS/python3.12 test/ogc-clients/qgis-render.py <service URL> <profile>
The token is only kept in a throwaway QGIS auth database and never printed.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import time

url, profile = sys.argv[1], sys.argv[2]
out = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'screenshots', 'ogc-qgis.png'))
token = json.loads(subprocess.run(['databricks', 'auth', 'token', '--profile', profile],
                                  capture_output=True, text=True, check=True).stdout)['access_token']
os.environ['QGIS_AUTH_DB_DIR_PATH'] = tempfile.mkdtemp(prefix='qgis-auth-')
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

from qgis.core import (QgsApplication, QgsAuthMethodConfig, QgsCoordinateReferenceSystem,  # noqa: E402
                       QgsCoordinateTransform, QgsDataSourceUri, QgsFillSymbol, QgsGraduatedSymbolRenderer,
                       QgsMapRendererSequentialJob, QgsMapSettings, QgsProject, QgsRasterLayer,
                       QgsRectangle, QgsRendererRange, QgsVectorLayer, Qgis)

contents = '/Applications/QGIS-final-4_2_3.app/Contents'
QgsApplication.setPrefixPath(contents.rsplit('/Contents', 1)[0], True)
QgsApplication.setPluginPath(f'{contents}/PlugIns/qgis')
os.environ.setdefault('PROJ_DATA', f'{contents}/Resources/qgis/proj')
app = QgsApplication([], True)
app.initQgis()
from qgis.PyQt.QtCore import QPointF, QRectF, QSize, Qt  # noqa: E402
from qgis.PyQt.QtGui import QColor, QFont, QPainter, QPainterPath  # noqa: E402

am = QgsApplication.authManager()
am.setMasterPassword('geolakelayers-showcase', True)
cfg = QgsAuthMethodConfig('APIHeader')
cfg.setName('GeoLakeLayers bearer')
cfg.setConfig('Authorization', f'Bearer {token}')
ok = am.storeAuthenticationConfig(cfg)
if isinstance(ok, tuple) and len(ok) > 1 and ok[1] is not None:
    cfg = ok[1]

# The northern Gulf coast, Galveston to the Mississippi Delta: ship channels, offshore platforms and the fairways
BBOX = QgsRectangle(-95.6, 27.6, -88.6, 30.6)


def oapif(typename):
    uri = QgsDataSourceUri()
    uri.setParam('url', url)
    uri.setParam('typename', typename)
    uri.setParam('pageSize', '4000')
    uri.setAuthConfigId(cfg.id())
    lyr = QgsVectorLayer(uri.uri(False), typename, 'OAPIF')
    if not lyr.isValid():
        sys.exit(f'{typename}: {lyr.dataProvider().error().message() if lyr.dataProvider() else "invalid"}')
    return lyr


basemap = QgsRasterLayer('type=xyz&zmin=0&zmax=16&url=https://server.arcgisonline.com/ArcGIS/rest/services/'
                         'Canvas/World_Dark_Gray_Base/MapServer/tile/%7Bz%7D/%7By%7D/%7Bx%7D', 'Dark Gray Canvas', 'wms')

hexes = oapif('hex_r7')
RAMP = ['#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf']
CUTS = [0, 4, 12, 34, 136, 10 ** 9]
ranges = []
for i, color in enumerate(RAMP):
    sym = QgsFillSymbol.createSimple({'color': color, 'outline_style': 'no'})
    sym.setOpacity(0.92)
    ranges.append(QgsRendererRange(CUTS[i], CUTS[i + 1], sym, f'{CUTS[i]}–{CUTS[i + 1]}'))
hexes.setRenderer(QgsGraduatedSymbolRenderer('ping_count', ranges))

for lyr in (basemap, hexes):
    QgsProject.instance().addMapLayer(lyr)

mercator = QgsCoordinateReferenceSystem('EPSG:3857')
extent = QgsCoordinateTransform(QgsCoordinateReferenceSystem('EPSG:4326'), mercator, QgsProject.instance()).transformBoundingBox(BBOX)
W, H = 1920, 1080
settings = QgsMapSettings()
settings.setLayers([hexes, basemap])
settings.setDestinationCrs(mercator)
settings.setOutputSize(QSize(W, H))
settings.setOutputDpi(144)
settings.setBackgroundColor(QColor('#1e2328'))
settings.setExtent(extent)
t0 = time.time()
job = QgsMapRendererSequentialJob(settings)
job.start()
job.waitForFinished()
img = job.renderedImage()

# Caption card, in the same style as the web showcase pages (pixel font sizes, so the output dpi doesn't scale them)
def px(family, size, bold=False):
    f = QFont(family)
    f.setPixelSize(size)
    f.setBold(bold)
    return f


p = QPainter(img)
p.setRenderHint(QPainter.RenderHint.Antialiasing)
card = QRectF(28, 28, 700, 200)
path = QPainterPath()
path.addRoundedRect(card, 14, 14)
p.fillPath(path, QColor(11, 32, 38, 228))
p.setPen(QColor('#eef2f3'))
p.setFont(px('Helvetica Neue', 22, bold=True))
p.drawText(QPointF(card.left() + 22, card.top() + 42), 'Northern Gulf of Mexico AIS traffic, July 4 2024')
p.setFont(px('Helvetica Neue', 15))
p.setPen(QColor(238, 242, 243, 205))
lines = [f'H3 r7 hexes colored by AIS pings, read by QGIS {Qgis.version().split("-")[0]} through its',
         'OGC API – Features provider with an API Header (Bearer) login.']
for i, text in enumerate(lines):
    p.drawText(QPointF(card.left() + 22, card.top() + 74 + i * 22), text)
for i, (color, label) in enumerate(zip(RAMP, ['1–4 pings', '4–12', '12–34', '34–136', '136+'])):
    x = card.left() + 22 + i * 112
    p.fillRect(QRectF(x, card.top() + 122, 16, 12), QColor(color))
    p.drawText(QPointF(x + 22, card.top() + 134), label)
p.setFont(px('Menlo', 12))
p.setPen(QColor(238, 242, 243, 150))
host = url.replace('https://', '')
import re  # noqa: E402
host = re.sub(r'geolakelayers-\d{10,}', 'geolakelayers-1234567890123456', host)
p.drawText(QPointF(card.left() + 22, card.top() + 166), 'OGC API – Features · ' + host)
p.drawText(QPointF(card.left() + 22, card.top() + 184), 'queried live as the signed-in user')
p.setFont(px('Helvetica Neue', 13))
p.setPen(QColor(238, 242, 243, 170))
p.drawText(QRectF(W - 420, H - 26, 408, 20), int(Qt.AlignmentFlag.AlignRight), 'Basemap: Esri, HERE, Garmin, © OpenStreetMap contributors')
p.end()
img.save(out)
print(f'saved {out} in {time.time() - t0:.0f} s')
app.exitQgis()
