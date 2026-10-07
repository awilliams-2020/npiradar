#!/usr/bin/env bash
# refresh-run.sh — one full monthly refresh, spawned detached by refresh-server.ts.
#
# Steps:
#   1. fetch the latest CMS monthly file (fetch-monthly.sh)
#   2. load it into the `staging` schema and atomically swap → `live` (load-parallel.ts --schema staging --swap)
#   3. purge the app's ISR cache (authed POST to /api/revalidate)
#   4. delete the monthly CSVs (~11 GB) once the load has succeeded
# Outcome (success/fail) is written back to public.refresh_runs(id=$RUN_ID) via refresh-state.mjs.
#
# Required env: RUN_ID, DATABASE_URL, REFRESH_SECRET.
# Optional env: NUCC_CSV, REFRESH_WORKERS, APP_INTERNAL_URL, NPIRADAR_DATA_DIR.
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # /app (the mounted ~/npiradar)
NUCC="${NUCC_CSV:-$SRC_DIR/pipeline/data/nucc_taxonomy_251.csv}"
WORKERS="${REFRESH_WORKERS:-4}"
APP_URL="${APP_INTERNAL_URL:-http://npiradar:3000}"
: "${RUN_ID:?RUN_ID required}"
: "${DATABASE_URL:?DATABASE_URL required}"
: "${REFRESH_SECRET:?REFRESH_SECRET required}"

state() { node "$SRC_DIR/pipeline/refresh-state.mjs" "$@"; }
fail()  { echo "[refresh] FAILED: $*" >&2; state fail "$RUN_ID" "$*"; exit 1; }

echo "[refresh] run $RUN_ID starting $(date -u +%FT%TZ)"

echo "[refresh] (1/4) fetching latest monthly…"
CSV="$(bash "$SRC_DIR/pipeline/fetch-monthly.sh" | tail -1)" || fail "fetch-monthly failed"
[ -s "$CSV" ] || fail "fetched CSV missing/empty: $CSV"

echo "[refresh] (2/4) loading $CSV into staging + swapping to live…"
( cd "$SRC_DIR" && npx tsx pipeline/load-parallel.ts "$CSV" --taxonomy "$NUCC" --schema staging --swap --workers "$WORKERS" ) \
  || fail "load/swap failed"

echo "[refresh] (3/4) purging ISR cache…"
curl -fsS --max-time 60 -X POST -H "Authorization: Bearer $REFRESH_SECRET" "$APP_URL/api/revalidate" >/dev/null \
  || echo "[refresh] WARN: revalidate call failed (data is live; pages refresh on their own 30-day cycle)" >&2

echo "[refresh] (4/4) deleting the monthly CSVs…"
# All *_pfile_* CSVs, this release's included (~11 GB): the data is in Postgres now, and rollback uses
# the `old` schema, not the file. Only reached on success; a failed run keeps its files for a retry.
find "$(dirname "$CSV")" -maxdepth 1 -name '*_pfile_*.csv' -delete 2>/dev/null || true

state success "$RUN_ID" "loaded $(basename "$CSV")"
echo "[refresh] run $RUN_ID done $(date -u +%FT%TZ)"
