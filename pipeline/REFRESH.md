# Monthly auto-refresh (cron-job.org → zero-downtime swap)

Automated monthly reload of the NPPES full file, triggered by an external **cron-job.org** HTTP ping.
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
        3. POST /api/revalidate    purge the app's ISR cache (live data already serving)
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
- Schedule: monthly, a few days in (CMS posts the full file the first weekend) — e.g. **day 8, 09:00**.
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
- **Disk:** the runner downloads to `/app/pipeline/data/monthly` (host `~/npiradar/...`). Peak ~22 GB
  (old + new 11 GB CSVs) before step 4 deletes the old one; keep headroom.
- **Rotate the secret:** change `REFRESH_SECRET` in `.env` + the cron-job.org job, then
  `docker compose -f ~/projects/npiradar/docker-compose.yml up -d` to re-inject it.

## Security notes

- The only public surface is `/internal/*` behind the bearer secret (`/healthz` is unauthed but leaks
  nothing). No docker socket is mounted — the ISR purge is an authed HTTP call, not a container recreate.
- Optional hardening: add a Traefik `IPAllowList` middleware for cron-job.org's published IP ranges.
