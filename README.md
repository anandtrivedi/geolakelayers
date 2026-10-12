# Databricks Data for ArcGIS Experience Builder

A custom Experience Builder widget that lists the Unity Catalog tables you can read and adds any of them to a
map as a live layer. Behind it is a Databricks App, the feature gateway, which serves each table as an ArcGIS
FeatureServer and runs every query with the signed-in user's Unity Catalog permissions.

## Screenshots

Four Unity Catalog tables added from the widget's table list: Maritime loitering indications (points), H3 places
density (polygons), highways (lines) and case locations, each pushed down to a serverless SQL warehouse per map extent.

![Four UC tables on one map](screenshots/four-uc-tables.png)

Maritime loitering indications, 78,723 contacts, served straight from `main.maritime.gold_anomaly_loitering`.

![Maritime loitering](screenshots/maritime-loitering.png)

## How it works

1. **Sign in.** The widget opens the gateway's `/auth/handoff` page in a popup. The Databricks login happens
   there, and the page posts the user's token back to the Experience Builder page (allow-listed origins only).
2. **Authorize requests.** An `esriConfig.request.interceptors` entry adds `Authorization: Bearer` to every SDK
   request bound for the gateway. The Databricks Apps front door validates it; CORS is answered by the gateway.
3. **Add layers.** Choosing a table adds `FeatureLayer(<gateway>/databricks/rest/services/<catalog.schema.table>/FeatureServer/0)`.
   The SDK does its normal FeatureServer paging and extent queries; the gateway turns them into SQL with
   `ST_Intersects` bbox filters, `LIMIT/OFFSET` paging and validated `where` clauses.

The gateway picks the geometry and object id per table: a GEOMETRY/GEOGRAPHY column, a WKT or WKB column, or
lon/lat doubles, plus an integer id column (`objectid`, `oid`, `fid`, `bigid`, `id`).

## Layout

| Path | What |
|---|---|
| `gateway/` | Databricks App (Node, Koop). Provider vendored from `koop-provider-databricks`, made per-table and on-behalf-of-user. |
| `widget/databricks-data/` | Experience Builder widget for Developer Edition 1.20 (ArcGIS Enterprise 12.1, JS SDK 5.0). |
| `test/index.html` | Same runtime path on plain ArcGIS Maps SDK 5.0, for testing outside Experience Builder. |
| `test/browser-test.mjs` | Headless end-to-end run of the test page against the deployed gateway. |

## Status

Verified 2026-10-12 against the deployed gateway on your-workspace: cross-origin sign-in and token handoff,
CORS preflight through the Apps front door, per-user queries, and point, polygon and polyline tables drawing
in the 5.0 SDK. Not yet run inside Experience Builder itself (needs Developer Edition 1.20) or registered on
the Portal.
