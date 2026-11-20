"""Load a GeoLakeLayers OGC service through QGIS's own OGC API – Features provider (headless).

Run with QGIS's Python, which needs its own stdlib on PYTHONHOME/PYTHONPATH when started from a shell:
  R=/Applications/QGIS-final-4_2_3.app/Contents/Resources/python3.12
  PYTHONHOME=$R PYTHONPATH=$R:$R/site-packages:$R/lib-dynload \
    /Applications/QGIS-final-4_2_3.app/Contents/MacOS/python3.12 test/qgis-oapif.py <service landing URL> <profile> [collection,...]

The Databricks OAuth token comes from `databricks auth token` and is only kept in a throwaway QGIS auth
database (an "API Header" config, the same one a QGIS user would create). It is never printed.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

url, profile = sys.argv[1], sys.argv[2]
token = json.loads(subprocess.run(['databricks', 'auth', 'token', '--profile', profile],
                                  capture_output=True, text=True, check=True).stdout)['access_token']

auth_dir = tempfile.mkdtemp(prefix='qgis-auth-')
os.environ['QGIS_AUTH_DB_DIR_PATH'] = auth_dir
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

from qgis.core import (QgsApplication, QgsAuthMethodConfig, QgsDataSourceUri, QgsFeatureRequest,  # noqa: E402
                       QgsRectangle, QgsVectorLayer)

contents = '/Applications/QGIS-final-4_2_3.app/Contents'
QgsApplication.setPrefixPath(contents.rsplit('/Contents', 1)[0], True)
QgsApplication.setPluginPath(f'{contents}/PlugIns/qgis')
os.environ.setdefault('PROJ_DATA', f'{contents}/Resources/qgis/proj')
app = QgsApplication([], False)
app.initQgis()
from qgis.core import Qgis, QgsCoordinateReferenceSystem  # noqa: E402
print('CRS84 known:', QgsCoordinateReferenceSystem('OGC:CRS84').isValid(), '| srs.db:', QgsApplication.srsDatabaseFilePath())
print('QGIS', Qgis.version(), '| auth methods:', ', '.join(sorted(QgsApplication.authManager().authMethodsKeys())))

am = QgsApplication.authManager()
am.setMasterPassword('geolakelayers-test', True)
cfg = QgsAuthMethodConfig('APIHeader')
cfg.setName('GeoLakeLayers bearer')
cfg.setConfig('Authorization', f'Bearer {token}')
ok = am.storeAuthenticationConfig(cfg)
if isinstance(ok, tuple):
    ok, cfg = ok[0], (ok[1] if len(ok) > 1 and ok[1] is not None else cfg)
print('auth config stored:', bool(ok))
authcfg = cfg.id()


def layer(typename):
    uri = QgsDataSourceUri()
    uri.setParam('url', url)
    uri.setParam('typename', typename)
    uri.setAuthConfigId(authcfg)
    return QgsVectorLayer(uri.uri(False), typename, 'OAPIF')


# The collection list, as QGIS's connection dialog would fetch it
probe = layer('__none__')
collections = None
try:
    from qgis.core import QgsProviderRegistry
    md = QgsProviderRegistry.instance().providerMetadata('OAPIF')
    print('OAPIF provider:', 'present' if md else 'missing')
except Exception as e:  # noqa: BLE001
    print('provider check failed:', e)

ids = sys.argv[3].split(',') if len(sys.argv) > 3 else []
for cid in ids:
    t0 = time.time()
    lyr = layer(cid)
    if not lyr.isValid():
        err = lyr.dataProvider().error().message() if lyr.dataProvider() else lyr.error().message()
        print(f'[{cid}] INVALID: {err[:400]}')
        continue
    ext = lyr.extent()
    fields = [f.name() for f in lyr.fields()][:8]
    print(f'[{cid}] valid in {time.time() - t0:.1f}s | geom={lyr.geometryType()} crs={lyr.crs().authid()} '
          f'| extent=({ext.xMinimum():.2f},{ext.yMinimum():.2f},{ext.xMaximum():.2f},{ext.yMaximum():.2f}) | fields={fields}')
    # Fetch features in a small window around the extent's centre, like a map view
    # Los Angeles / Long Beach harbor, a busy AIS area, as a map view would ask for it
    req = QgsFeatureRequest().setFilterRect(QgsRectangle(-118.4, 33.6, -118.1, 33.8)).setLimit(2000)
    t1 = time.time()
    n = 0
    first = None
    for f in lyr.getFeatures(req):
        n += 1
        if first is None:
            first = f
    print(f'[{cid}] {n} features in the LA harbor window in {time.time() - t1:.1f}s'
          + (f' | first id={first.id()} geom={first.geometry().asWkt()[:60]}' if first else ''))
    errs = lyr.dataProvider().errors()
    if errs:
        print(f'[{cid}] provider errors: {[e[:200] for e in errs[:3]]}')

app.exitQgis()
