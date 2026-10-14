#!/bin/bash
# Run the gateway tests (node:test) and the widget tests (jest inside an Experience Builder Developer
# Edition client), in parallel. Logs go to test-logs/. Exits non-zero if either suite fails.
#
#   scripts/test-all.sh
#   EXB_CLIENT=/path/to/ArcGISExperienceBuilder/client scripts/test-all.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXB_CLIENT="${EXB_CLIENT:-$HOME/Documents/gitprojects/exb-dev/1.20/client}"
LOGS="$ROOT/test-logs"
mkdir -p "$LOGS"

(cd "$ROOT/gateway" && npm test) > "$LOGS/gateway.log" 2>&1 &
gateway=$!

widget_status=skipped
if [ -d "$EXB_CLIENT/your-extensions/widgets" ]; then
  rsync -a --delete "$ROOT/widget/databricks-data/" "$EXB_CLIENT/your-extensions/widgets/databricks-data/"
  # --forceExit: auth.ts keeps a 30 s expiry timer running for the life of the page
  (cd "$EXB_CLIENT" && npx jest --runInBand --forceExit your-extensions/widgets/databricks-data) > "$LOGS/widget.log" 2>&1 &
  widget=$!
  if wait "$widget"; then widget_status=pass; else widget_status=fail; fi
fi
if wait "$gateway"; then gateway_status=pass; else gateway_status=fail; fi

echo "gateway: $gateway_status  ($(grep -E '^ℹ (pass|fail) ' "$LOGS/gateway.log" | tr '\n' ' '))"
echo "widget:  $widget_status  ($(grep -E '^Tests:' "$LOGS/widget.log" 2>/dev/null || echo "no Developer Edition client at $EXB_CLIENT"))"
echo "logs:    $LOGS/"
[ "$gateway_status" = pass ] && [ "$widget_status" != fail ]
