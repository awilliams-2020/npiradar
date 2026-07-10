#!/usr/bin/env bash
# fetch-monthly.sh — resolve, download, and unzip the latest NPPES monthly full-replacement file.
#
# CMS publishes the monthly full file as:
#   https://download.cms.gov/nppes/NPPES_Data_Dissemination_<Month>_<Year>[_Vn].zip
# The version suffix (_V2, _V3, …) is unpredictable, and the listing page (NPI_Files.html) is
# JS-rendered — a static scrape finds no links. So we PROBE candidate URLs with a *ranged* GET
# (plain HEAD is unreliable on download.cms.gov — it returns a bogus 10-byte length) and pick the
# newest reissue that is a real zip.
#
# Output contract: on success the LAST line of stdout is the absolute path to the extracted
# npidata_pfile CSV; all logging goes to stderr. So callers can do:
#     CSV="$(pipeline/fetch-monthly.sh | tail -1)" && load "$CSV"
#
# Modes:
#   (default)        resolve → download → unzip → print CSV path
#   --resolve-only   just print the resolved URL (no download) — used by the runner to cheaply
#                    decide whether CMS has anything newer than what's loaded
#
# Env:
#   NPIRADAR_DATA_DIR   where to download/extract (default ~/npiradar/pipeline/data/monthly)
#
# Disk: the zip is ~1.1GB and the extracted npidata CSV is ~11GB. Keep ~25GB headroom (old + new).
set -euo pipefail

DEST="${NPIRADAR_DATA_DIR:-$HOME/npiradar/pipeline/data/monthly}"
BASE="https://download.cms.gov/nppes"
MIN_BYTES=$((200 * 1024 * 1024)) # a real monthly zip is ~1GB+; reject stubs/redirects/error pages
RESOLVE_ONLY=0
[ "${1:-}" = "--resolve-only" ] && RESOLVE_ONLY=1

log() { echo "fetch-monthly: $*" >&2; }

# probe URL → on success prints the advertised total byte size and returns 0; else returns 1.
# Range-GET the first 4 bytes so we both confirm the ZIP local-file magic (PK\x03\x04) and read the
# real total from the Content-Range header (HEAD's Content-Length lies here).
probe() {
  local url="$1" hdr total magic
  hdr="$(curl -fsS --max-time 30 -r 0-3 -D - -o /tmp/fm_magic "$url" 2>/dev/null)" || return 1
  magic="$(xxd -p /tmp/fm_magic 2>/dev/null || true)"
  [ "$magic" = "504b0304" ] || return 1
  total="$(printf '%s' "$hdr" | tr -d '\r' | grep -i '^content-range:' | sed -E 's@.*/([0-9]+).*@\1@')"
  [ -n "$total" ] && [ "$total" -ge "$MIN_BYTES" ] || return 1
  echo "$total"
}

# Try current month, then previous month (the new file lands a few days into the month). Within a
# month prefer the highest reissue version. First real zip wins.
resolve_url() {
  local months=() off mon suf url total
  for off in 0 1; do
    months+=("$(date -d "$(date +%Y-%m-01) -${off} month" +'%B_%Y')")
  done
  for mon in "${months[@]}"; do
    for suf in _V5 _V4 _V3 _V2 ""; do
      url="${BASE}/NPPES_Data_Dissemination_${mon}${suf}.zip"
      if total="$(probe "$url")"; then
        log "resolved ${url} ($((total / 1024 / 1024)) MB)"
        echo "$url"
        return 0
      fi
    done
  done
  log "ERROR: no monthly file found for: ${months[*]}"
  return 1
}

main() {
  local url zip csv_in_zip
  url="$(resolve_url)"

  if [ "$RESOLVE_ONLY" = "1" ]; then
    echo "$url"
    return 0
  fi

  mkdir -p "$DEST"
  zip="${DEST}/$(basename "$url")"

  log "downloading → ${zip}"
  curl -fL --retry 5 --retry-delay 10 --retry-all-errors -C - -o "$zip" "$url" 1>&2

  log "verifying zip integrity…"
  unzip -tqq "$zip" >/dev/null || { log "ERROR: corrupt download: ${zip}"; exit 1; }

  # The provider file is npidata_pfile_<start>-<end>.csv (NOT *_fileheader.csv, and not the
  # othername/pl/endpoint side files).
  csv_in_zip="$(unzip -Z1 "$zip" | grep -E '^npidata_pfile_[0-9]+-[0-9]+\.csv$' | head -1)"
  [ -n "$csv_in_zip" ] || { log "ERROR: no npidata_pfile CSV inside ${zip}"; exit 1; }

  log "extracting ${csv_in_zip}…"
  unzip -o "$zip" "$csv_in_zip" -d "$DEST" 1>&2

  log "done; removing zip to save disk"
  rm -f "$zip"

  # Output contract: final stdout line = the CSV path.
  echo "${DEST}/${csv_in_zip}"
}

main
