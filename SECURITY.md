# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately through GitHub: on this repository's **Security** tab, choose
**Report a vulnerability** ([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Don't open a public issue. Include what you found, how to reproduce it and what it could affect. The maintainers
will acknowledge the report and follow up in the advisory on a best-effort basis.

GeoLakeLayers is a community project, not an official Databricks product, so Databricks' own security and support
channels don't cover it.

## Supported versions

Fixes go into the latest release on `main`. Redeploy the gateway (`databricks bundle deploy` and
`databricks bundle run gateway`) and rebuild the widget to pick them up.

## How GeoLakeLayers handles access

This is a summary for reviewers; the README's "Security model" section covers the same ground for operators.

**Who a request runs as.** Every request to the gateway passes the Databricks Apps front door, which authenticates
the user. The gateway runs each query with that user's forwarded OAuth token (on-behalf-of, `user_api_scopes:
["sql"]`), on a per-user SQL session, so Unity Catalog grants, row filters and column masks apply per person. The
app's service principal needs no data grants. The only exception is **open tables**: exact table names a Databricks
admin lists in the bundle variable `open_tables`, read as the service principal on the bound warehouse. Their
`where` filters may call only allow-listed functions, and edits to them still run as the editor.

**How the widget gets a token.** An Experience Builder page can't call the gateway with the Apps front-door cookie,
so the widget opens `/auth/handoff?origin=<page origin>` in a popup. The user signs in there (first party), and the
page hands the forwarded token to its opener with `postMessage`, with that exact origin as the target origin, and
only when the origin is in the gateway's `ALLOWED_ORIGINS`. If a first Databricks login drops the origin, the popup
comes back with `resume=1` and no origin; the page then calls `postMessage` once per allowed origin, and the browser
delivers each message only if the opener's origin matches that target. A window on an origin that isn't allowed
never receives the token. The handoff page is `no-store` and can't be framed. The widget keeps
the token in memory (never in storage) and adds it as `Authorization: Bearer` to gateway requests only. The front
door accepts OAuth tokens, not personal access tokens. `ALLOWED_ORIGINS` is set by a Databricks admin in the bundle;
the widget's own settings can't change it.

**What the browser can send.** The browser never sends SQL. Table, column and catalog names must be plain
identifiers; Esri `where` clauses and OGC filters are parsed and validated; geometry filters are built from numbers;
values travel as named SQL parameters. Unknown OGC parameters are refused. The warehouse a request may use is checked
against `ALLOWED_WAREHOUSES`.

**Writes.** Editing (`applyEdits`) is off unless the gateway sets `EDITING=true`, the widget allows it and the user
has Unity Catalog MODIFY; it runs as the editor, on integer-id tables only. The front door strips `Authorization`
before the app, so cross-site requests are blocked by the `Origin` allow-list. Console writes (OGC services, layer
overrides, Optimize) accept same-origin JSON only.

**Caching.** Server-side caches (query rows, specs, counts, extents) are keyed per user and warehouse. Concurrent
identical work is shared only within the same key. Statements that outlive `QUERY_TIMEOUT_SECONDS` are cancelled.
