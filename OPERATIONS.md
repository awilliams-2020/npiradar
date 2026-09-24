# npiradar — Operations

How the running service is deployed, what its public API surface is, and how the moving parts
(Postgres, Redis, Traefik) fit together. Change log at the bottom. For product/SEO state see
`STATUS.md`; for design rationale see `ARCHITECTURE.md`.

---

## Deploy

App code is baked into the image, so a plain container restart does **not** pick up source edits —
you must rebuild. Edit code in the source tree (`~/npiradar/…`), then build + deploy from the
`projects/` dir so compose adopts and recreates the existing containers:

```bash
docker compose -p npiradar \
  --project-directory /home/awilliams/projects/npiradar \
  -f /home/awilliams/projects/npiradar/docker-compose.yml \
  up -d --build
```

This rebuilds and recreates both `npiradar` (the app) and `npiradar-refresh` (the monthly NPPES
loader). npiradar is **not** blue/green — a single container serves; a recreate is the whole deploy.

**Local checks before deploying:** `npx tsc --noEmit` (the repo exposes no eslint binary).

---

## Runtime dependencies

| Dependency | How it's reached | Failure mode |
|---|---|---|
| **Postgres** (`postgres:5432`, db `npiradar`) | `DATABASE_URL`; app on the `db` network. `search_path=live,public`. | Query routes return **503** `{"error":"unavailable"}`. |
| **Redis** (`redis:6379`) | `REDIS_URL`; shared infra Redis, same `db` network as Postgres. Backs the API rate limiter only. | Limiter **fails open** (serves unlimited) — availability over abuse-prevention. Traefik's edge limit is still the backstop. |
| **Traefik** | Routes `Host(npiradar.com) \|\| Host(www.npiradar.com)`. Edge `ratelimit` middleware = coarse 100/min/IP backstop. | — |

Redis is optional-by-design: unset `REDIS_URL` or a Redis outage degrades the limiter to allow, it
never takes the API down.

---

## Public JSON API

CORS-open (`Access-Control-Allow-Origin: *`), no API key. Shared CORS + rate-limit preamble lives in
`lib/api.ts`; the limiter in `lib/ratelimit.ts` + `lib/redis.ts`.

| Endpoint | Purpose | Rate-limit cost |
|---|---|---|
| `GET /api/npi/{npi}` | Single provider lookup by NPI. 200 / 400 (`invalid_npi`) / 404 / 503. Success is `Cache-Control` cacheable. | **1** |
| `POST /api/npi` | Bulk lookup. Body `{ "npis": [...] }`, ≤100, one SQL round-trip. Returns `{ count, results, notFound, invalid }`. | **= number of valid NPIs** (1–100) |
| `GET /api/search` | Discovery. Params `name`, `specialty` (taxonomy slug), `state` (2-letter), `city` (slug), `limit` (≤50), `page`. Returns `{ query, page, limit, hasMore, results }`. | **10** |

**Search guardrails** (keep queries on an index, never a full scan):
- Requires at least one of `name`, `specialty`, `state` → else **400**.
- `city` requires `state` → else **400**.
- `specialty`/`city` slugs that don't resolve return an empty result set, not a scan.

Index paths: `name` → `last_name`/`org_name` `text_pattern_ops` partial indexes; `specialty` →
slug→taxonomy codes → `primary_taxonomy_code`; `state`+`city` → slug→`raw_cities` →
`(practice_state, practice_city, …)`.

### Rate limiting

Cost-weighted **fixed window per IP**, atomic in Redis (Lua `INCRBY`+`EXPIRE`). One shared token
budget across all three endpoints, so bulk/search can't dodge the limit by batching. Every response
(allow and deny) carries `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`; a 429
adds `Retry-After`. Guardrail 400s are rejected **before** the charge, so malformed requests are free.

Tunable via env (defaults in `lib/ratelimit.ts`):

| Env | Default | Meaning |
|---|---|---|
| `API_RATE_LIMIT` | `600` | tokens per window, per IP |
| `API_RATE_WINDOW` | `60` | window length, seconds |

Client IP is the first entry of `X-Forwarded-For` (set by Traefik). To make the limiter **fail
closed** instead (starve abuse during a Redis outage, at the cost of availability), change the
`catch` in `rateLimit()` to return `ok: false`.

### Verify a deploy

No curl in the alpine image — drive it with node's fetch from inside the container:

```bash
docker exec -i npiradar node -e '
(async()=>{
  const B="http://127.0.0.1:3000";
  let r=await fetch(B+"/api/npi/1306701685");
  console.log("single", r.status, r.headers.get("x-ratelimit-remaining"));
  r=await fetch(B+"/api/npi",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({npis:["1306701685","0000000000","12345"]})});
  console.log("bulk", r.status, JSON.stringify(await r.json()).slice(0,200));
  r=await fetch(B+"/api/search?specialty=occupational-therapist&state=ca&city=pasadena&limit=3");
  console.log("search", r.status, (await r.json()).results.length);
})();'
# Redis buckets (proves the limiter is live, not failing open):
docker exec -i redis redis-cli --scan --pattern 'rl:api:*'
```

---

## Change log

### 2026-07-13 — Public API: bulk + search endpoints, first-class rate limiting

**Why:** GSC showed real demand for programmatic access — e.g. the query *"ai tool that pulls bulk
practice locations based on npi free nppes"* — but the only endpoint was single-NPI lookup. An AI
agent could loop it but couldn't batch or discover, and there was no app-level rate limiting (only
Traefik's coarse edge limit).

**What shipped:**
- `POST /api/npi` — bulk lookup (≤100), single `WHERE npi = ANY(...)` round-trip
  (`lib/provider.ts → getProviders`). The `/tools/bulk-lookup` browser tool now makes **one** POST
  instead of a 100-way per-NPI client fan-out.
- `GET /api/search` — filtered discovery by name / specialty / state / city
  (`lib/facets.ts → searchProvidersApi`), with scan-avoidance guardrails.
- **Rate limiting as a shared primitive** — Redis-backed, cost-weighted, per-IP
  (`lib/redis.ts`, `lib/ratelimit.ts`, `lib/api.ts`). Applied to all three endpoints incl. the
  existing single lookup. Fails open on Redis outage.
- Infra: added `ioredis` dep + `serverExternalPackages`; `REDIS_URL=redis://redis:6379` in the
  `projects/npiradar` compose (app already on the `db` network with Redis).

**Verified in-container:** single/bulk/search all 200; weighted cost decrements the shared budget
(1 / N / 10); guardrails 400 without charging; 429 fires exactly at budget exhaustion with
`Retry-After`; Redis holds the `rl:api:<ip>` buckets. `tsc --noEmit` clean.

**Not done (follow-ups):** no API key / freemium tiering yet (single per-IP budget for all callers);
search `city` filter requires `state`; the bulk `MAX` (100) and rate budget (600/min) are untuned
starting points.
