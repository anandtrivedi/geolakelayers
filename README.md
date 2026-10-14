# Databricks Data for ArcGIS Experience Builder

An Experience Builder widget that puts Unity Catalog tables on an ArcGIS map as live layers, backed by
**ArcGateway**, a small Databricks App that serves those tables as ArcGIS FeatureServer layers. Authors pick
tables from one or more Databricks workspaces; viewers sign in with Databricks and see only what Unity Catalog
lets them see. Nothing is copied into ArcGIS: every pan and zoom is a query on a Databricks SQL warehouse.

![Published experience with Unity Catalog layers](screenshots/published-app-layers.png)

## How it fits

![Architecture: ArcGIS clients, ArcGateway per workspace, SQL warehouse and Unity Catalog](screenshots/architecture.png)

- **Databricks Data widget** (`widget/databricks-data/`): signs the user in to each workspace, lists the
  tables they can use, and adds them to the map as Experience Builder data sources, so Map Layers, Legend,
  Table and Filter treat them like any other layer.
- **ArcGateway** (`gateway/`): a Databricks App, one per workspace. It turns ArcGIS FeatureServer requests
  (extent, paging, filters, counts) into SQL and runs them **as the signed-in user**. Map Viewer, ArcGIS Pro
  and SDK apps can use its layer URLs too. It also publishes sets of tables as **OGC API – Features**
  services for QGIS, GDAL, OpenLayers, MapLibre and pipelines (see [OGC API – Features](#ogc-api--features)).
- **Your data stays in Unity Catalog.** Any table with geometry can be a layer: a GEOMETRY/GEOGRAPHY
  column, WKT, WKB or GeoJSON in a text or binary column, or longitude/latitude columns (see
  [How tables are read](#how-tables-are-read)).

A Databricks sign-in belongs to one workspace, so each workspace runs its own ArcGateway (same code, one
bundle). Workspaces that share a metastore see the same catalogs and can share one gateway.

## Deployment

You need: a recent Databricks CLI (built with v1.17) with a profile for each workspace, Databricks Apps enabled
with user authorization, a serverless SQL warehouse, and ArcGIS Enterprise 11.0 or later (this project is
built and tested against 12.1).

### 1. Deploy ArcGateway to a workspace

ArcGateway is a Databricks Asset Bundle in `gateway/`. Each workspace is a target in
`gateway/databricks.yml`:

```yaml
targets:
  myworkspace:
    workspace:
      host: https://<workspace>.cloud.databricks.com
    variables:
      warehouse_id: <serverless warehouse id>          # queries run here unless an author picks another allowed one
      allowed_origins: https://<portal-host>,https://localhost:3001   # browser origins that may call the gateway
      # optional:
      allowed_warehouses: <id>,<id>                    # extra warehouses authors may pick
      catalogs: "-"                                    # cap on listable catalogs; "-" = none
      directory: prod=https://arcgateway-....databricksapps.com;gov=https://arcgateway-....databricksapps.us
```

Then deploy and start it:

```bash
cd gateway
databricks bundle deploy -t myworkspace --profile <profile>
databricks bundle run gateway -t myworkspace --profile <profile>
```

The app is created as `arcgateway`, open to account users (`CAN_USE`), with user authorization for SQL, and
the warehouse bound as an app resource. Its URL is printed at the end
(`https://arcgateway-<workspace-id>.<region>.databricksapps.com`). Open it in a browser to check it: the
console shows who you are, the workspace, warehouse and allowed origins, and lets you browse tables and
preview them on a map.

![ArcGateway console](screenshots/arcgateway-overview.png)

![Exploring a catalog in the console](screenshots/arcgateway-explore.png)

What users need in Databricks: `CAN_USE` on the app (the bundle grants it to account users), `CAN_USE` on the
warehouse, and `USE CATALOG` / `USE SCHEMA` / `SELECT` on the tables. Queries run as the user, so the app's
service principal needs no data grants.

To add a workspace later: add a target, deploy it, and add the new gateway to `directory` in every target so
authors can pick it from a list.

### 2. Set up Experience Builder Developer Edition

Custom widgets are built with Developer Edition. Pick the version that matches your Portal: Enterprise 12.1
pairs with Developer Edition **1.20** (ArcGIS Maps SDK 5.0). Download it from Esri's Developer Edition
downloads page (needs an ArcGIS account), unzip it, and install its two parts:

```bash
cd ArcGISExperienceBuilder/server && npm ci && npm start          # https://localhost:3001
cd ArcGISExperienceBuilder/client && npm ci && npm start          # widget compiler (watch mode)
```

Copy the widget into the client and restart the compiler once (it picks up new widgets at start):

```bash
cp -R widget/databricks-data ArcGISExperienceBuilder/client/your-extensions/widgets/
```

Developer Edition signs in to Portal with an OAuth app. In Portal, create **New item → Developer credentials →
OAuth 2.0 credentials for user authentication**:

![Choosing user authentication](screenshots/portal-developer-credentials.png)

Add `https://localhost:3001/` as a redirect URL, then give Developer Edition your Portal URL and the new client
ID the first time you open https://localhost:3001.

![Redirect URLs on the credentials item](screenshots/portal-redirect-urls.png)

Add `https://localhost:3001` to the gateway's `allowed_origins` and redeploy it if you haven't.

### 3. Use it in Portal's own Experience Builder (optional)

To make the widget available to everyone in Portal's built-in Experience Builder, host the compiled widget
(`client/dist/widgets/databricks-data`) on a web server that is anonymous, HTTPS with a publicly trusted
certificate, and sends CORS headers for your Portal. Then, as a Portal administrator, add **New item →
Application → Experience Builder widget** with the URL of its `manifest.json`. Add the Portal's address to
each gateway's `allowed_origins`.

## Building an app

1. Add a **Map**, and the **Databricks Data** widget, ideally inside a **Widget Controller** on the map so it
   opens as a panel. Add **Map Layers** and **Legend** (a sidebar works well).
2. In the Databricks Data settings, sign in to a workspace. Its card holds the gateway URL, the SQL warehouse
   and the catalogs viewers can browse. **Add workspace** lists the other gateways from the directory.
3. Under **Layers to load when the app opens**, tick tables in the workspace ▸ catalog ▸ schema ▸ table tree.
   **Show selected only** reviews the picks.
4. Save and publish. Viewers click **Sign in** once per workspace; the start-up layers load, and if browsing
   is on they can add more from the chosen catalogs.

![Workspace card in the widget settings](screenshots/settings-workspace-card.png)

![Two workspaces (prod and gov) in one app, with Map Layers](screenshots/builder-two-workspaces.png)

To see a layer's rows, add a **Table** widget, pick the map, and turn on **Display layers generated at
runtime**. Clicking a feature shows its fields when the Map widget's pop-ups are enabled.

## Editing

Databricks layers can be edited with Experience Builder's **Edit** widget or an editable **Table**. Three
switches have to agree:

1. **Gateway (Databricks admin):** `editing: "true"` in the workspace's bundle target. Off by default; while
   it's off, layers advertise only `Query` and edit requests are refused.
2. **App (author):** **Allow editing Databricks layers** in the widget's settings (Viewers section). Each
   workspace card says whether its gateway allows editing.
3. **Unity Catalog (per person):** edits run as the person editing, so they need `MODIFY` on the table.

Editable tables have a real integer id: a single-column primary key, or an id column picked as an override.
Tables with a derived id and map-optimized copies stay read-only. Each save is SQL on the Delta table (`INSERT` / `UPDATE` / `DELETE`), so
it takes a second or two: right for corrections, reviews and batch attribute updates, not for high-volume
capture. New features get the next id after the table's current maximum, and there is no row versioning
(the last save wins). For heavy transactional editing, a Lakebase-backed feature service is the better fit.

Edits are accepted only from origins in `allowed_origins` (and the gateway's own pages); values are sent as
SQL parameters and column names are checked against the table.

## How tables are read

ArcGateway works out each table's geometry and object id from column types and values, never from
column names.

- Geometry: a GEOMETRY or GEOGRAPHY column is used by its type (another SRID is reprojected to 4326).
  Otherwise ArcGateway samples the table's text and binary columns with `try_to_geometry`; a column whose
  values parse as WKT, EWKT, GeoJSON or WKB (95% of 200 sampled values) is the geometry, in the SRID the
  values carry, else 4326.
- Object id: the table's Unity Catalog primary key when it is a single integer column. Otherwise an id
  derived from a hash of the whole row: stable while the row doesn't change, fine for viewing, but those
  layers are read-only.
- Listing: the catalog tree lists tables with a GEOMETRY/GEOGRAPHY column straight from metadata. Geometry
  stored as text or binary needs the values, so it is found when a table is opened, or for a whole schema
  with **Scan schema** in the console's Explore tab. **Open table** opens any table by name.

When that isn't right (geometry in two longitude/latitude columns, a mostly empty geometry column, the
wrong one of two geometry columns, or a real id column without a declared primary key), set an override:
Explore → a table → **How it's read → Change**. Overrides are kept in a Unity Catalog table
(`layer_overrides_table` in the bundle) and apply to everyone who uses the table through this gateway.
**Create overrides table** makes it once and grants SELECT to account users; grant MODIFY on it to the
people who should set overrides. Pick an id column only if its values are unique and never change:
ArcGIS selects, pages and edits by it.

To make a table editable without an override, declare its primary key:
`ALTER TABLE c.s.t ALTER COLUMN id SET NOT NULL; ALTER TABLE c.s.t ADD CONSTRAINT t_pk PRIMARY KEY (id)`.

## OGC API – Features

Besides ArcGIS layers, ArcGateway publishes OGC API – Features services: pick tables in the console, save
them under a name, and each table becomes a collection at
`https://<gateway>/ogc/<service>/collections/<table>/items`. Responses are GeoJSON. The service implements
Part 1 (Core, GeoJSON, OpenAPI 3.0) and Part 2 (CRS84 and EPSG:3857).

Turning it on (Databricks admin): set `ogc_services_table` in the bundle target to a Unity Catalog table
name, for example `main.arcgateway.ogc_services`, and redeploy. Then open the console's **OGC services**
tab and use **Create table** once (it needs CREATE TABLE on that schema). Grant SELECT on the table to the
people and service principals that read services, and MODIFY to the people who define them.

Defining a service: **OGC services → New service**, tick tables in the catalog tree, set a title per
table and optionally a time field (enables `datetime` filtering), and save. The service's card lists its
landing page, conformance, OpenAPI, collection and items URLs, with copyable `curl` and GDAL commands and
a map preview.

| Path | What it returns |
|---|---|
| `/ogc/<service>` | Landing page (links to the API definition, conformance and collections) |
| `/ogc/<service>/conformance` | Conformance classes |
| `/ogc/<service>/api` | OpenAPI 3.0 definition, with each collection's queryable fields |
| `/ogc/<service>/collections` | One collection per table: extent, time range, CRS list |
| `/ogc/<service>/collections/<id>/items` | Features as GeoJSON, paged with `next` links |
| `/ogc/<service>/collections/<id>/items/<fid>` | One feature |
| `/ogc/<service>/collections/<id>/queryables` | Fields that can be filtered with `?field=value` |

Items accept `bbox` (and `bbox-crs`), `crs` (CRS84 or `http://www.opengis.net/def/crs/EPSG/0/3857`),
`limit` (default 100, at most `MAX_ROWS`), `offset`, `datetime` (instant or interval, for collections with
a time field), `properties` (fields to return) and `field=value` filters on queryable fields. Bounding boxes
are 2D (four numbers). Unknown parameters are refused with a 400, as
the standard requires, so a typo never returns the whole table.

Who can call it: everything still goes through the Databricks Apps front door, so clients need a
Databricks OAuth token. Personal access tokens are not accepted.

- Browser maps on the gateway's own pages use the session; on another site they need an allow-listed
  origin and a Bearer token, the same way the Experience Builder widget signs in.
- Scripts and pipelines send `Authorization: Bearer <token>`. For a person:
  `databricks auth token --host <workspace URL>`. For a service principal: its OAuth M2M token from
  `<workspace>/oidc/v1/token` (client credentials). The service principal needs CAN_USE on the app,
  CAN_USE on the warehouse and SELECT on the tables.

```bash
TOKEN=$(databricks auth token --host https://<workspace> | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" "https://<gateway>/ogc/<service>/collections/<id>/items?limit=10&bbox=-77.2,38.8,-76.9,39.0"
GDAL_HTTP_HEADERS="Authorization: Bearer $TOKEN" ogrinfo -ro -so "OAPIF:https://<gateway>/ogc/<service>"
```

Queries run as the caller, exactly like the ArcGIS layers, so Unity Catalog grants (and row filters and
column masks) decide what each client gets. Collections the caller can't read are left out of their
collection list. The services are read-only.

## Configuration reference

Gateway (bundle variables → app environment; list settings use `-` for "none" because Databricks Apps
rejects empty values):

| Setting | Default | What it does |
|---|---|---|
| `warehouse_id` | required | Bound warehouse; the default for every query |
| `allowed_warehouses` | `-` | Extra warehouses authors may pick; anything else is refused (403) |
| `allowed_origins` | `-` | Browser origins allowed by CORS and by the sign-in handoff |
| `catalogs` | `-` | Optional cap on which catalogs can be listed |
| `exclude_catalogs` | `system,samples,hive_metastore,__databricks_internal` | Never listed |
| `directory` | `-` | Other gateways, `name=url;name=url`, shown in the console and the widget |
| `MAX_ROWS` | `4000` | Features per page |
| `BIG_TABLE_FEATURES` | `250000` | Above this, layers draw only when zoomed in (about zoom 9) |
| `editing` | `"false"` | Master switch for editing on this gateway |
| `layer_overrides_table` | `-` | Unity Catalog table holding geometry/id overrides; `-` turns overrides off |
| `ogc_services_table` | `-` | Unity Catalog table holding OGC API service definitions; `-` turns OGC API off |

Widget (set in the builder): workspaces (name, gateway URL, warehouse, catalogs viewers can browse), whether
viewers can browse and add tables, whether layers can be edited, start-up layers.

## Security model

- Every request passes the Databricks Apps front door; queries run with the caller's own token, so Unity
  Catalog grants (including row filters and column masks) apply per person.
- The sign-in popup hands the token only to allow-listed origins. Tokens live in memory, never in storage;
  in the builder they are shared between its windows, never in published apps.
- The browser never sends SQL. Table, column and catalog names are checked as plain identifiers; `where`
  clauses are validated; bounding boxes are built from numbers.
- Caches are per user. "Optimize for maps" only replaces tables ArcGateway wrote itself.

## Performance

- Layers above 250,000 features draw only when zoomed in; the widget says so on the layer's row.
- Repeated map requests are cached per user for 5 minutes; warehouse sessions are reused.
- For big tables, use **Optimize for maps** in the console (Explore data → a table). It writes a copy with
  native GEOMETRY and per-row bounding boxes, clustered on them, so map views read only nearby files. The
  original table is not changed.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Sign-in popup says "This site can't be reached" | The workspace card points at an old or wrong gateway URL. Fix the URL in its card. |
| "Could not read the workspace" / "gateway did not answer" | The sign-in expired (about an hour) or the gateway was restarting. Use **Retry** or sign in again. |
| Layer doesn't appear in Map Layers | Its row says "not shown in Map Layers": the data source couldn't be created and a plain layer was added. Check the browser console. |
| Layer disappears when zooming out | It has more than 250,000 features; zoom in, or optimize the table. |
| Requests fail with CORS errors | The page's origin isn't in the gateway's `allowed_origins`. |
| A catalog shows "No map-ready tables" | None of its tables has a GEOMETRY/GEOGRAPHY column. Use **Scan schema** for geometry stored as text or binary, or open a table and set its geometry under **How it's read**. |
| A layer can't be edited | Its id is derived. Declare a primary key, or pick its id column under **How it's read**. |

## Development

- `gateway/console/`: the console (React + TypeScript, Vite). `npm run console:build` writes `gateway/public/`,
  which is deployed as static files.
- `gateway/provider/`: adapted from `koop-provider-databricks`; `spec.js` works out each table's geometry and id.
- Tests: `cd gateway && npm test` (node:test, no network; Databricks SQL is faked) and the widget's jest
  tests in `widget/databricks-data/tests/`, which run inside a Developer Edition client.
  `scripts/test-all.sh` runs both (set `EXB_CLIENT` to the Developer Edition `client` folder).
- `test/index.html` and `test/browser-test.mjs`: the widget's request path on plain ArcGIS Maps SDK, run
  headless against a deployed gateway. `test/console-shots.mjs` screenshots the console.
- `CLAUDE.md` has the design notes and known gotchas.

## Repository layout

| Path | What it is |
|---|---|
| `widget/databricks-data/` | Experience Builder widget (runtime, settings, shared sign-in, tree) |
| `gateway/` | ArcGateway Databricks App and its bundle (`databricks.yml`) |
| `gateway/console/` | Console source; built into `gateway/public/` |
| `test/` | Browser tests and screenshot scripts |
| `screenshots/` | Images in this README |
