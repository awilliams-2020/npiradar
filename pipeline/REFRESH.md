# Monthly auto-refresh (self-scheduled check → zero-downtime swap)

Automated reload of each NPPES monthly full file. **The refresh server checks CMS itself every 6 hours**
(added 2026-10-07) and loads a release within hours of it posting. CMS posts around the second weekend,
on no fixed day; the old monthly cron on the 1st left the data 3–7 weeks old. The external
**cron-job.org** POST below still works as a backup trigger. Overlapping triggers are harmless: a
trigger returns `200 up_to_date` when nothing is newer and `409` while a run is going.

Each load also brings in the release's three side files (`othername`, `pl`, `endpoint`) →
`provider_other_names`, `provider_locations`, `provider_endpoints`. They are shown on `/npi/[npi]` and
returned by `GET /api/npi/{npi}`.

Before each swap, `load.ts --diff staging` records what changed per NPI into
`public.provider_changes`. That table is permanent history, outside the swapped schemas. It can't be
rebuilt, so it is the one table here that must be backed up. See CHANGELOG 2026-10-07.

The same 6-hourly check also runs `pipeline/leie.ts` (HHS OIG exclusion list → `public.oig_exclusions`).
It logs one `leie:` line per check. By hand: `docker exec npiradar-refresh npx tsx pipeline/leie.ts`.

Then `pipeline/openpayments.ts` (CMS Open Payments, latest 3 program years → `public.op_npi_*`), skipped
while an NPPES run is going. A no-op unless CMS published or corrected a year; a real load is ~9 GB per
year and ~15 min. By hand: `docker exec npiradar-refresh npx tsx pipeline/openpayments.ts [--years 2025]`.
Built 2026-05-24. See also `pipeline/README.md` (the manual pipeline) and `STATUS.md`.

## How it works

```
cron-job.org  --(monthly POST, Bearer secret)-->  https://npiradar.com/internal/refresh
                                                            │  (Traefik → npiradar-refresh:8080)
                                                            ▼
                                              refresh-server.ts  (returns 202 in <1s)
                                                            │  spawns detached
                                                            ▼
                                                   refresh-run.sh
        1. fetch-monthly.sh        resolve+download+unzip the latest CMS monthly zip
        2. load-parallel.ts        load into the `staging` schema, then ATOMIC swap → `live`
        3. POST /api/revalidate    refresh the cached static pages (provider pages render per request)
        4. cleanup                 delete the previous month's CSV
```

**Why a 202, not the work inline:** cron-job.org times out a request after ~30s, but a refresh takes
~20 min. So the endpoint validates, dedupes, and spawns the job detached, returning immediately.

**Zero downtime:** the loader builds everything (providers/taxonomy/MVs/indexes) in a `staging`
schema, then renames `staging`→`live` (retiring the old `live`→`old`) inside a single transaction.
Readers see the switch atomically; in-flight queries finish against the old tables. The DB default
`search_path = live, public` (set on first swap) + the app pool's pinned `search_path` mean new
connections pick up `live`. The previous month is kept as schema `old` for one-generation rollback.

## Endpoints (Traefik: `Host(npiradar.com) && PathPrefix(/internal/)`, priority 100)

| Method + path | Auth | Returns |
|---|---|---|
| `GET /internal/healthz` | none | `{"ok":true}` |
| `GET /internal/status` | Bearer | last 5 runs from `public.refresh_runs` |
| `POST /internal/refresh` | Bearer | `202 started` / `200 up_to_date` / `409 already_running` / `502 resolve_failed` |

Auth header: `Authorization: Bearer <REFRESH_SECRET>` (in `~/projects/npiradar/.env`, injected into
both the app and runner containers).

## ONE-TIME SETUP (you)

### 1. cron-job.org job
- URL: `https://npiradar.com/internal/refresh`
- Method: **POST**
- Header: `Authorization: Bearer <REFRESH_SECRET>`  (copy from `~/projects/npiradar/.env`)
- Schedule: optional backup to the built-in 6-hourly check. It was day 1, 04:00 UTC through 2026-10.
  Firing more often is harmless: the server returns `200 up_to_date` until a newer file appears.
- Enable cron-job.org's failure notification (it flags any non-2xx response).

### 2. First activation (the one ~20-min, live-flipping step — run supervised)
This is intentionally **not** automated on deploy: the first run replaces `public`-served data with the
`live` schema. Trigger it by hand and watch it:
```bash
SECRET=$(grep '^REFRESH_SECRET=' ~/projects/npiradar/.env | cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $SECRET" https://npiradar.com/internal/refresh   # -> {"status":"started","runId":N,...}
docker exec npiradar-refresh sh -c 'tail -f /tmp/refresh-*.log'                            # watch progress
curl -s -H "Authorization: Bearer $SECRET" https://npiradar.com/internal/status | jq       # state: success
```
(From this box you can't curl your own public domain — no NAT hairpin. Trigger from elsewhere, or
`docker exec npiradar-refresh curl ... http://127.0.0.1:8080/internal/refresh`.)

## Operations

- **Status / last runs:** `GET /internal/status` (table `public.refresh_runs`).
- **Logs:** `docker exec npiradar-refresh sh -c 'ls -t /tmp/refresh-*.log | head'` then `tail` it.
- **Rollback** (if a swap shipped bad data): `BEGIN; ALTER SCHEMA live RENAME TO bad; ALTER SCHEMA old
  RENAME TO live; COMMIT;` then `docker compose ... up -d --force-recreate npiradar` (or POST
  `/api/revalidate`). `old` is the prior month, kept until the next swap.
- **Disk:** the runner downloads to `/app/pipeline/data/monthly` (host `~/npiradar/...`). Peak ~13 GB
  (1.1 GB zip + 11 GB of CSVs) during a run; step 4 deletes the CSVs once the load succeeds (since
  2026-10-07), so nothing stays between runs.
- **Rotate the secret:** change `REFRESH_SECRET` in `.env` + the cron-job.org job, then
  `docker compose -f ~/projects/npiradar/docker-compose.yml up -d` to re-inject it.

## Security notes

- The only public surface is `/internal/*` behind the bearer secret (`/healthz` is unauthed but leaks
  nothing). No docker socket is mounted — the cache purge is an authed HTTP call, not a container recreate.
- Optional hardening: add a Traefik `IPAllowList` middleware for cron-job.org's published IP ranges.
