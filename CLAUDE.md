# GeoLakeLayers

A Databricks App (`gateway/`) that serves Unity Catalog tables as ArcGIS FeatureServer layers and OGC API –
Features, plus an ArcGIS Experience Builder widget (`widget/databricks-data/`) that adds those tables to a map.
Queries run as the signed-in user, so Unity Catalog grants decide what each person sees.

Workspace-specific notes for your own deployment go in `CLAUDE.local.md` (gitignored).

## Layout
- `gateway/` — Node Databricks App, deployed with the bundle in `gateway/databricks.yml`.
  `provider/` is vendored from `koop-provider-databricks`; `provider/spec.js` resolves geometry column/format
  and object id per table. Routes: `/databricks/rest/services/<catalog.schema.table>/FeatureServer/0`,
  `/ogc/<service>/...`, `/api/*` (console), `/auth/handoff`, `/` (console, built from `gateway/console/`).
- `widget/databricks-data/` — ExB widget (Developer Edition 1.20 = Enterprise 12.1, JS SDK 5.0). Copy into
  `client/your-extensions/widgets/` of a Developer Edition install.
- `test/` — browser and console checks against a deployed gateway (gateway URL and profile are arguments).

## Dependencies
`gateway/package.json` has an `overrides` block for transitive packages with open advisories (basic-ftp via the
SQL driver's proxy-agent chain, qs via express, joi via Koop's featureserver and winnow). Koop's validators load and
coerce the same under joi 18 as 17 (checked 2026-11-02). `npm audit --omit=dev` is clean (2026-11-20). The full audit
still flags esbuild through vite 5 (console build only; the advisory is the dev server's): fixing it is a vite major.
`npm audit`'s "fix" for koop-core is a downgrade to 5.x; ignore it.

## Build, test, deploy
    cd gateway
    npm test                                  # gateway unit tests (node --test)
    npm run console:build                     # console -> gateway/public (committed; the app serves it)
    cp targets.example.yml targets.local.yml  # once: your hosts, warehouses, origins (gitignored)
    databricks bundle deploy -t <target> && databricks bundle run gateway -t <target>
Widget tests: `scripts/test-all.sh` (copies the widget into an ExB client and runs its jest).
Nothing workspace-specific is in the code: host from DATABRICKS_HOST (Apps runtime), warehouse from the
`sql-warehouse` app resource, everything else from bundle variables. One gateway per Unity Catalog metastore.
Compute size and Node heap are bundle variables (`compute_size`, default MEDIUM; `node_heap_mb`, default 3072);
raise both for big tables. The console's Server gauge (/api/load) shows heap, memory and requests in flight.

## How auth works
The Databricks Apps front door authenticates every request. The widget opens `/auth/handoff?origin=<page origin>`
in a popup; the user signs in there, and the page posts the forwarded user token (`x-forwarded-access-token`,
app `user_api_scopes: ["sql"]`) to the opener, only for origins in `ALLOWED_ORIGINS`. The widget adds
`Authorization: Bearer` to gateway requests via `esriConfig.request.interceptors`. Queries run on behalf of the
user (per-user DBSQL sessions in provider/connection.js); the app service principal needs no data grants.
The front door accepts OAuth tokens only, not personal access tokens.

## Table rules (spec.js): by type and content, NEVER by column name
Geometry: a GEOMETRY/GEOGRAPHY column by type; else STRING/BINARY columns sampled with try_to_geometry
(>=95% of 200 values parse; WKT/EWKT/GeoJSON/WKB; SRID from the data, 0 -> 4326). Lon/lat only by override.
Object id: override, else single-column integer UC primary key, else xxhash64 of the whole row => read-only.
The listing (lib/listing.js) applies the same integer-key rule, so what it shows as the id is what the layer gets.
Overrides live in a UC table (bundle var `layer_overrides_table`). The listing is metadata-only: native-geometry
tables + overrides + per-user "Scan schema" results. Keep ids < 2^53 (ArcGIS JS rounds larger).
information_schema spells BIGINT as `long`.

## Who configures what
- Gateway (bundle target, by a Databricks admin): ALLOWED_ORIGINS (the security boundary), ALLOWED_WAREHOUSES
  (+ the bound one), optional CATALOGS cap, editing switch, settings tables, directory of other gateways,
  OPEN_TABLES (bundle var `open_tables`): exact table names read as the app's service principal on the bound
  warehouse, so anyone who can sign in sees them; the SP needs SELECT; edits still run as the editor. Their `where`
  filters may call only allow-listed functions (validation.js restrictFunctions), since they run with the SP's grants.
- Widget settings (by the ExB app author): gateway URL, warehouse (sent as X-Databricks-Warehouse), catalogs
  (sent as ?catalogs=), viewer browsing switch, start-up layers.
- Never in widget config: origins, warehouse policy, rate limits, anything that swaps OBO for a shared credential.

## Widget notes
- Register the token interceptor with `unshift`: only the first matching `esriConfig.request` interceptor runs,
  and ExB installs a catch-all; otherwise gateway requests go out without the token.
- Layers added at runtime are not saved; `config.layers` (set in the settings panel) is what publishes. In the
  builder, runtime adds/removes reach the settings panel over a BroadcastChannel (src/sync.ts).
- Start-up layers are the widget's output data sources (src/outputs.ts; stable ids, schema saved), so other
  widgets connect to them in the builder. Consumers work on the `<id>-output` data view; layers.ts copies that
  view's where onto layer.definitionExpression. ExB creates those data sources with an unauthenticated fetch,
  so the widget hands it the definition (ServiceManager.setServiceInfo) and recreates any that failed before
  sign-in. The settings window has no SDK loaded: load esri/config through loadArcGISJSAPIModules there.
- Gateway: outStatistics and returnDistinctValues run as SQL over the whole table (Filter dropdowns, charts).
- ExB caches the widget icon path in widgets-info.json when the watcher starts; restart it after adding icon.svg.
- Screenshots in `screenshots/` must not show tokens, internal hostnames or other people's catalogs.
- Editing (gateway/edits.js): POST <layer>/applyEdits, gated by EDITING=true, the widget's allowEditing, and UC
  MODIFY (runs as the editor). Integer-id tables only; values are named SQL parameters. The Apps front door
  strips Authorization before the app, so the CSRF guard is the Origin allow-list. Test edits on scratch tables.

## OGC API – Features (gateway/ogc/)
- `/ogc/<service>/...`: Part 1 Core + GeoJSON + OAS30, Part 2 CRS (CRS84, EPSG:3857). A service is a named set
  of tables stored in the UC table `ogc_services_table` (`-` = off). Reads/writes run as the caller.
- Every statement ends with `/* geolakelayers:esri */`, `/* geolakelayers:ogc service=<name> */` or
  `/* geolakelayers:console */` (taggedSession in model.js), so query history tells the protocols apart; trailing so
  RT routing still reads SELECT first, and below the query cache so Esri and OGC pages share rows.
- Shared query path: `Model.queryFeatures` / `Model.collectionInfo` (model.js) under `layerSpec.store.run(spec)`;
  extra clauses + named params are appended, so the Esri SQL is byte-identical when there are none.
- Paging: next links carry `cursor=<last id>` (keyset) plus `offset` for prev. Unknown params -> 400.
- Console writes go through lib/http.js consoleOnly (same-origin JSON only).

## Lakehouse//RT (provider/sea.js + connection.js realtimeSession)
- RT accepts only the Statement Execution API, so sea.js calls the REST API with the caller's token.
- RT warehouses are recognized by type (warehouse_type REALTIME, cached); they only need to be allowed.
- A routing session sends SELECT/WITH/DESCRIBE/SHOW (information_schema included) to RT; writes, system
  tables and statements using a function RT lacks (ST_Simplify, plus any learned from refusals) go to the
  bound warehouse. Row filters/column masks are checked up front (on RT). Refusals are handled by kind
  (refusalOf); a circuit breaker covers RT outages.
- `node test/rt-contract.mjs <profile> <rt id> <regular id> <catalog.new_scratch_schema>` checks the RT
  behavior this relies on. Run it before changing the routing.
- docs/optimizations.md is the running list of performance changes and rejected ideas, with the reasons.
  Add to it whenever you change routing, caching or query shape.

## Geometry size
Esri tile queries carry maxAllowableOffset; `simplifyTolerance` (model.js) converts it to degrees and wraps the
geometry in ST_Simplify, so zoomed-out line and polygon tiles stay small.
