# Using LakeGate

LakeGate connects Unity Catalog tables to two mapping worlds: ArcGIS Experience Builder apps, and clients that speak OGC API – Features. The data isn't copied anywhere. Every request runs on a Databricks SQL warehouse as the person (or service principal) making it, so Unity Catalog grants decide what each user sees. This guide covers where LakeGate fits and what each client needs. It doesn't walk through clicks in Experience Builder or other tools, because those screens change between releases.

## Pick the path for your client

| You're working in | Use | Sign-in |
|---|---|---|
| ArcGIS Experience Builder | The **Databricks Data** widget, pointed at this gateway's URL | The widget signs viewers in with Databricks |
| QGIS, GDAL/OGR, OpenLayers, Leaflet, MapLibre, ArcGIS OGCFeatureLayer | An **OGC service** (OGC API – Features) | Databricks OAuth token as a Bearer header |
| Python, notebooks, pipelines | An OGC service, or a table's FeatureServer URL | Databricks OAuth token as a Bearer header |
| ArcGIS Map Viewer or ArcGIS Pro, "add layer from URL" | Not supported yet | These clients can't send a Databricks sign-in |

Personal access tokens aren't accepted. Use an OAuth token for yourself (`databricks auth token`) or for a service principal (client credentials). Tokens expire after about an hour, so long-running jobs should fetch a new one.

## Experience Builder

Databricks Data is a custom widget. An ArcGIS administrator makes it available once, either in Experience Builder Developer Edition or by registering it as a custom widget in the organization's Experience Builder. A Databricks admin adds that Experience Builder's address to the gateway's allowed origins.

App authors add the widget to an experience, usually next to the map, and give it the gateway URL shown on this console's Overview. They sign in once, then choose:

- the SQL warehouse the app's queries run on,
- which catalogs viewers may browse, if any,
- the tables that load when the app opens.

Viewers sign in to Databricks the first time they open the app. Databricks tables then behave like other map layers in Map Layers, Legend, Table and pop-ups. If the author turns on editing and the gateway allows it, viewers can edit layers whose tables have an integer id, as long as they have MODIFY on the table.

Several workspaces can feed one app. Each has its own gateway and its own sign-in.

## OGC clients

An OGC service is a named set of tables. Create one in the **OGC services** tab; each table becomes a collection. The service's landing page URL is what you give a client, and the client follows the links from there. Each service has an engine, the warehouse its queries run on. Lakehouse//RT warehouses suit interactive maps best.

Anything that speaks OGC API – Features and can send an `Authorization` header works. In QGIS, that's a WFS / OGC API – Features connection to the service's landing page, with an **API Header** authentication configuration that sends `Authorization: Bearer <token>`. Tested with QGIS 4.2. Responses are GeoJSON in CRS84 by default, or EPSG:3857 on request. Results come in pages; clients follow the `next` link.

## Scripts and notebooks

Use the OGC endpoints for GeoJSON, or a table's FeatureServer URL with the Esri REST query parameters you already know. Both need the Bearer header. Results are limited per request, so page through them.

## What the Databricks admin sets up

- One gateway per Unity Catalog metastore, deployed from the repo's bundle. Workspaces that share a metastore share one gateway: it can serve any catalog bound to its own workspace, and people sign in to that workspace. A workspace on another metastore (another region, or GovCloud) needs its own gateway; the `directory` setting lists the others in each console.
- Allowed origins: the Experience Builder and Portal addresses that may call the gateway from a browser.
- Allowed warehouses: the warehouses apps and OGC services may run on. Users also need CAN USE on them.
- Unity Catalog grants on the data, plus SELECT on the gateway's own settings tables: OGC services and layer overrides.

## When something doesn't work

- **The sign-in popup closes and nothing loads.** The page's address probably isn't in the gateway's allowed origins.
- **A table is missing or a layer is empty.** The user needs USE CATALOG, USE SCHEMA and SELECT on it, and CAN USE on the warehouse.
- **401 from a script.** The token is missing, expired, or a personal access token.
- **Slow maps on a big table.** Use a Lakehouse//RT warehouse, or create a map-optimized copy from Explore data.
