# Databricks Data widget

An ArcGIS Experience Builder widget that adds Unity Catalog tables to a map as live layers. Viewers sign in
with Databricks and see only what Unity Catalog lets them see. It needs a **GeoLakeLayers** gateway, the
Databricks App in [`gateway/`](../../gateway), which serves the tables. GeoLakeLayers also works without this
widget for OGC clients such as QGIS and GDAL.

## Compatibility

| | Tested |
|---|---|
| Experience Builder Developer Edition | 1.20 |
| ArcGIS Enterprise | 12.1 (pairs with Developer Edition 1.20) |
| ArcGIS Maps SDK for JavaScript | 5.0 |
| GeoLakeLayers | 0.1.0 |

Widget version: see `manifest.json`. Other Experience Builder versions may work but haven't been tried.

## Before you install

A Databricks admin deploys GeoLakeLayers (see the root [README](../../README.md)) and adds the address of your
Experience Builder (for example `https://localhost:3001`, or your Portal) to the gateway's `allowed_origins`.
Without that, the sign-in popup closes and nothing loads.

## Install

**Developer Edition:** copy this folder to `client/your-extensions/widgets/databricks-data` and restart the
client's `npm start` once, since it picks up new widgets only when it starts.

**Portal's own Experience Builder:** build the widget in Developer Edition, host
`client/dist/widgets/databricks-data` on an HTTPS web server that sends CORS headers for your Portal, then
register the URL of its `manifest.json` in Portal as an **Experience Builder widget** item.

## Using it

Authors add the widget next to a map, pick that map, add the gateway URL (the console's Map and ArcGIS tabs show it),
sign in, and choose the SQL warehouse, which catalogs viewers may browse, and the tables that load when the
app opens. Viewers sign in once; Databricks layers then work with Map Layers, Legend, Table and pop-ups.

Editing is enforced by the gateway's `editing` setting and the person's MODIFY grant on the table. The
widget's **Allow editing Databricks layers** switch only shows or hides editing in the app.

What each client needs, and troubleshooting: [docs/guide.md](../../docs/guide.md).
