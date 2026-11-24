# Optimizations: what we changed, what we didn't, and why

A running list. Add an entry when you change routing, caching or query shape, and when you decide against
an idea, so nobody has to rediscover the reason. Newest first within each section. Evidence is what was
measured; if an entry has none, say so.

## Done

### 2026-11-20: layer-info samples skip ORDER BY; timed-out statements are cancelled; identical work is shared

Measured first (`system.query.history`, statements tagged `geolakelayers:*`, last 30 days on a test workspace): ordinary
tile and page SQL is fast (Esri on the regular warehouse p50 0.4 s, on RT 0.06 s; OGC on RT 0.17 s), and the
warehouse's result cache already serves 30% of Esri statements on the regular warehouse (0% on RT). More than
90% of all Esri warehouse time was nine statements on one table without an integer key
(`ais_tracks_10y_2015_2024`, row-hash ids), 2026-11-09:

- **The layer-info sample row** (`FeatureServer/0`: one row for the geometry type) was
  `... ORDER BY objectid LIMIT 1`. With a hashed id, that hashes every row (`ST_AsBinary` of every track
  included) and reads 148 GB for one row: 10-17 min, run 7 times in 10 minutes. Now `buildQuery(..., { anyRow })`
  drops the ORDER BY for that sample (any row will do); pages keep theirs, so paging stays stable.
- **`QUERY_TIMEOUT_SECONDS` wasn't enforced.** The Thrift driver sends `queryTimeout` but the warehouse ran
  the statements to the end; the request gave up and the statement kept the warehouse busy.
  `executeAndRecord` now cancels the statement at the timeout + 5 s (`QUERY_TIMEOUT_GRACE_MS`) and fails the
  request. Console statements (`runSql` in server.js: Optimize, scans) keep their own timeouts and aren't cut.
- **Identical concurrent work ran once per request.** Feature queries (same user, warehouse and SQL), counts
  and extents now join a statement already running (`singleFlight`), so a retried or duplicated layer-info
  request costs one statement.
- **A whole-table extent that times out is remembered for one TTL** (5 min) and the layer is served
  without an extent, instead of rescanning on every layer-info request. Other extent failures are retried.
  The extent itself (MIN/MAX over every envelope) is still a full scan; on the 10-year table it took 5-6 min.

Browser side, from the same review: CORS preflights are cached for 2 h (was 10 min; every gateway request
carries `Authorization`, so each new URL needs one), and the console's content-hashed `/assets/*` are cached
as immutable. Feature responses still carry no cache headers; see Open.

### 2026-11-02: the listing's primary-key rule matches the resolver's

`listTables` (now `lib/listing.js`) joined `key_column_usage` for single-column primary keys but never looked
at the key column's type, so a table with a single STRING key was listed with that column as its id while
`spec.js` served it with a derived id and refused edits. The listing query now joins the key column's type
from `information_schema.columns` and requires an integer type (`long` for BIGINT). One extra join on a
query that already reads `information_schema.columns`; not measured separately.

### 2026-11-02: filters on open tables use a function allow-list

Open tables run as the app's service principal. Their `where` clauses now pass
`validateWhereClause(where, { restrictFunctions: true })`: only comparison, string, number, date, cast and
spatial (ST_*, H3) functions may be called. The deny-list of functions that reach beyond the table stays for
every table (it covers the caller-run case, where the only one at risk is the caller); the allow-list is for the
case where a new Databricks builtin could otherwise run with the app's grants. No query shape change.

### 2026-10-19: Lakehouse//RT routing from measured behavior, not assumptions

Proposed changes were reviewed by five models (GPT, Gemini, Qwen, GLM, Fable). Every one of them said to
test what RT actually does before changing the routing, so that came first.

**RT contract test (`test/rt-contract.mjs`).** Builds scratch tables (one with a row filter, one with a
column mask, one that gets a filter between reads, a view, every column type the gateway handles), runs
the statements the gateway sends on an RT warehouse, writes a report to `testimages/rt-contract.json` and
drops the schema. Why: the routing relies on RT behavior that is Beta and mostly undocumented. Re-run it
after RT changes and before changing `realtimeSession`. Results on a test workspace, 2026-10-19:

| What | Result |
|---|---|
| Table with a row filter or column mask | Refused, `UNSUPPORTED_FEATURE` "A table with row filters, column masks, or ABAC policies is not supported" (also for COUNT and DESCRIBE) |
| Row filter added between two reads | RT served the unfiltered rows for about 10 s, then refused |
| information_schema right after the change | Showed the new filter at once, on RT |
| DESCRIBE, SHOW, information_schema on RT | Work; DESCRIBE reports `geometry(4326)` |
| `SELECT * … LIMIT 0` result manifest | GEOMETRY and GEOGRAPHY come back as `STRING` (on both warehouse types) |
| Views | Served |
| ST_Simplify, ST_Envelope_Agg | Refused, "Function `x` is not supported in Lakehouse//RT" |
| ST_AsGeoJSON, try_to_geometry, xxhash64, ST_SRID, MIN/MAX of ST_XMin/ST_YMax | Work |

**Metadata runs on RT.** DESCRIBE, SHOW and information_schema queries (layout detection, primary keys,
the policy check) now go to the RT warehouse instead of the regular one. Why: they work there, and they
were the main reason an RT-backed layer or OGC service still woke the regular warehouse, which is a cold
start of several seconds when it has stopped. System tables still go to the regular warehouse (not tested
on RT).

**Row filter / column mask check kept, now on RT.** Before a table's first RT read the gateway asks
information_schema whether it has a row filter or column mask; governed tables are read on the regular
warehouse. The answer is shared by all callers for 10 minutes. The check now runs on RT and falls back to
the regular warehouse if RT can't run it. Why kept: RT does fail closed, but it served a newly filtered
table for about 10 s, and information_schema was current immediately. If the check itself fails, RT's own
refusal is the backstop.

**Refusals sorted by kind** (`refusalOf` in `provider/connection.js`). Before, one pattern decided between
"pin the table for 6 h" and "pin for 10 min". Now:

| Kind | Effect |
|---|---|
| caller (permissions, missing table, bad SQL) | Error returned, not retried |
| governed | Table read on the regular warehouse for 6 h |
| function | Statements using that function go to the regular warehouse; the table stays on RT |
| unsupported (another feature) | Table on the regular warehouse for 6 h |
| transient (5xx, 429, timeouts, network) | Retried on the regular warehouse; counted by the circuit breaker; table not pinned |
| unknown | Table on the regular warehouse for 10 min |

Why: an RT outage used to pin every table it touched for 10 minutes, so all reads went to the regular
warehouse long after RT recovered; and one statement with an unsupported function pinned the whole table.
`/api/realtime` reports counts per kind.

**Unsupported functions learned from refusals.** ST_Simplify is known; any other function RT names in a
refusal is added to the list for 6 hours. Why: the ST_Simplify rule was hard-coded, and RT is gaining
functions in both directions while it's in Beta, so a fixed list goes stale.

**Circuit breaker per RT warehouse.** Five transient failures within a minute send every statement to the
regular warehouse for 30 s (doubling up to 5 min while it keeps failing); after the cool-down one failure
reopens it. Why: without it, every request during an RT incident waited for RT to fail first, then retried.
The breaker doesn't stop the load landing on the regular warehouse; that warehouse has to be sized for it,
or kept warm (see Open).

**OGC service definitions read on the service's engine.** The definition is cached per caller for a
minute and was always read on the bound warehouse, so even an all-RT service woke the regular warehouse.
The store now remembers each service's engine from any read and looks it up there, only if that engine is
still allowed; if the caller can't use it, the bound warehouse answers. Why: this was the last statement
on an ordinary OGC read that needed the regular warehouse.

## Already in place, and deliberately kept

- **Big-table guards don't depend on the engine.** Layers over 250,000 rows get a `minScale`, and OGC
  `numberMatched` is left out of filtered queries on them. Why: these protect payload size and drawing
  time, not just warehouse time. Keying them to RT would change a layer's behavior whenever a table falls
  back to the regular warehouse.
- **Stable paging.** Esri paging orders by the object id; OGC paging uses a keyset cursor on the id.
- **The engine is checked against the allow-list.** A service author can't point other people's
  requests at an arbitrary warehouse.

## Decided against

- **Schema from `SELECT * … LIMIT 0` instead of DESCRIBE** (2026-10-19). The result manifest reports
  GEOMETRY as STRING, so native geometry columns wouldn't be found. Not needed anyway: DESCRIBE runs on RT.
- **Saving each table's detected layout in the OGC service definition** (2026-10-19). Proposed so OGC
  reads could skip DESCRIBE on the regular warehouse. With DESCRIBE on RT that reason is gone, and a saved
  layout needs drift detection, which the result manifest can't fully give (it doesn't report geometry
  types). Measured after the change: about 2 s for three tables on a cold caller, then cached for
  10 minutes. Revisit if that becomes a complaint.
- **Dropping the policy check and relying on RT to refuse.** RT served a newly filtered table for about
  10 s, too long for a policy that was just added.
- **Relaxing minScale or the count guard when the engine is RT.** See "Already in place".
- **Simplifying geometry in Node (Douglas-Peucker) so line and polygon tiles can stay on RT.** It moves
  full-resolution geometry to the gateway and blocks its event loop exactly when tiles are heaviest. Lines
  and polygons with `maxAllowableOffset` keep going to the regular warehouse for ST_Simplify.
- **Unity Catalog REST API for policy metadata.** Would need an OAuth scope beyond `sql`, so every user
  would see a new consent prompt. Not needed now that information_schema runs on RT.

## Open

- **HTTP caching of feature responses.** Koop sets no `Cache-Control` and advertises
  `supportsQueryWithCacheHint: false`. Candidates: an ETag from the table's Delta version so a revalidation
  returns 304 without running SQL; short `private` max-age for `cacheHint` tile queries on read-only layers;
  `Vary: Authorization`; an admin switch (feature data on disk may not suit every deployment) and
  `Clear-Site-Data` on sign-out. Never Koop's own provider cache: its default key is the URL and query, with no
  user, so under on-behalf-of it would hand one user's rows to another.
- **Whole-table extents on very large tables** are a full scan (5-6 min on 10 years of tracks). Options: persist
  the extent (table property or the settings schema) once computed, or derive it from bbox columns where the
  map-optimized copy has them.
- **Precomputed simplified geometry per zoom band** in the map-optimized copy, so line and polygon tiles
  can stay on RT. Only worth it if line/polygon tiles turn out to be a large share of traffic. If built:
  grants copied from the source, no copies of governed tables, and a refresh schedule.
- **The first service lookup after a restart.** Measured 2026-10-19 on a test workspace (`ais-demo`, three
  tables, RT engine): the first `/collections` call after a deploy took 10 s, of which about 7 s was
  opening the Thrift connection and session to the bound warehouse for the service lookup (the engine
  isn't known until that read). Layout detection, extents and counts for the three tables on RT took
  about 2 s together; the same call warm took 0.2 s, and item pages 0.25–0.75 s warm. `/api/realtime`
  showed 27 statements on RT, none sent to the regular warehouse. Options if this matters: open the bound
  warehouse connection at startup, or try an allowed RT warehouse first for service lookups.
- **A small always-warm regular warehouse** for what RT can't serve (governed tables, edits, simplified
  tiles, fallbacks). A cost decision for each gateway's admin; worth documenting with numbers.
- **GovCloud (no RT).** The routing never engages there; unit tests cover the regular path. Check a GovCloud
  gateway after the next deploy.
