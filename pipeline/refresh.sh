#!/usr/bin/env bash
# Monthly NPPES refresh in one command:
#   1. load the new full file — load.ts rebuilds providers + taxonomy + the facet MVs (facets.sql)
#   2. recreate the app container so caches clear and the live site serves the fresh data
#
# Why --force-recreate (not restart): the ISR render cache lives in the container's writable layer at
# .next/cache. `docker restart` reuses that layer, so 30-day-revalidate pages would stay STALE. Recreating
# the container from the image gives a fresh .next/cache, so every page re-renders against the new data on
# first hit. (In-memory caches — home count, sitemap index — clear on any restart.)
#
# Usage: pipeline/refresh.sh <npidata.csv> <nucc_taxonomy.csv>
set -euo pipefail

CSV="${1:?usage: pipeline/refresh.sh <npidata.csv> <nucc_taxonomy.csv>}"
TAXO="${2:?usage: pipeline/refresh.sh <npidata.csv> <nucc_taxonomy.csv>}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ~/npiradar
COMPOSE_DIR="${NPIRADAR_COMPOSE_DIR:-$HOME/projects/npiradar}"

echo "==> [1/2] loading $CSV (rebuilds providers + taxonomy + facet MVs; ~20-25 min)…"
( cd "$SRC_DIR" && npx tsx pipeline/load.ts "$CSV" --taxonomy "$TAXO" )

echo "==> [2/2] recreating npiradar container to clear ISR + in-process caches…"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" up -d --force-recreate npiradar

echo "==> done. The live site now serves the fresh data."
echo "    Reminder: bump DATA_VINTAGE in lib/format.ts if the release month changed (then redeploy)."
