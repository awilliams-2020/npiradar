# npiradar

**A programmatic-SEO healthcare-provider lookup site on the free public NPPES (NPI) dataset.**
Domain: `npiradar.com`. Solo-dev project, chosen 2026-05-23 after multi-round SERP research.

## What it is

The U.S. government (CMS) publishes the **National Plan & Provider Enumeration System (NPPES)** — every
healthcare provider's **NPI** (National Provider Identifier), name, specialty (taxonomy), practice location,
and credentials. It's ~8M+ records, public domain, downloadable in full.

npiradar turns that dataset into an SEO surface:

- **A page per provider / organization** (`/npi/1234567890`) — name, NPI, specialty, practice location, credentials, structured data.
- **Faceted index pages** — by specialty (`/specialty/internal-medicine`), by city/state (`/in/tx/houston`), and the money pages: specialty × city (`/internal-medicine/houston-tx`).
- **Tools** — an NPI validator (deterministic check-digit math → SEO + link magnet) and bulk lookup.

## Why this project (the SEO thesis)

The winning pattern from the research: **pSEO reference-lookup on a free, complete public dataset where the
incumbents are weak pSEO sites, not mega-brands.** NPI scored best of every candidate tested:

- **~8.1M/mo** addressable search, **LOW** competition across the cluster (head term `npi lookup` ≈ 301k/mo).
- **Free + complete data** — no data-cost moat working against us (unlike VIN, where rich data is paid).
- **Beatable SERP** — the clunky official CMS registry ranks #1, then a swarm of low-quality pSEO sites
  (npilookup.io, npi-lookup.org). No Bankrate/Canva/Amazon wall.
- **Dev-native build** — ingest a dataset, template pages, generate sitemaps. No novel product risk.

Full research trail (all rounds, every GO/NO-GO verdict): `~/project-research/research.md`.

## Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router, `output: standalone`)** | On-demand ISR renders millions of pages without pre-building; matches existing Traefik/compose deploy (theqrcode, balance) |
| Data store | **PostgreSQL** | 8M+ rows, faceted queries, trigram name search; COPY-load from NPPES CSV |
| Search | Postgres trigram (MVP) → Meilisearch/Typesense (optional later) | Provider name autocomplete |
| CDN / cache | **None** — Next ISR `.next/cache` on-box | Traefik terminates TLS and serves every request directly; no Cloudflare |
| Analytics | **Matomo site 9** (matomo.redbudway.com), JS-only | `app/_components/matomo.tsx`. JS-only on purpose: the scraper never runs JS, so Matomo counts real people. Audit: `docker exec -e IDSITE=9 -i th3-sh0p node - < ~/scripts/seo/matomo-audit.cjs` |
| API usage | **`public.api_usage`** (Postgres), daily rollup | `lib/usage.ts`, written from the shared API guard. Matomo can't see API calls (no JS), so this is the only long-lived record. See **API usage** below. |
| Deploy | Traefik + docker-compose | Per `~/projects/<name>` (compose+env) / `~/npiradar` (source+Dockerfile) convention |

Alternative considered: **Astro** (great for content at scale) — viable, but Next reuses existing infra + experience. See `ARCHITECTURE.md`.

## API usage

Is anyone using the free API? Added 2026-09-28 to answer that over months, which neither Traefik's log
(~3 days) nor container stdout (lost on the monthly recreate) can. `lib/usage.ts` upserts one row per
`(day UTC, endpoint, source, caller)` for every call that reaches the rate limiter (bad requests
rejected earlier aren't counted). `endpoint` is `lookup` | `bulk` | `search`; `source` is `site` (our own
`/tools/bulk-lookup`, by Origin/Referer) or `external`; `caller` is the client IP with its last block zeroed (IPv4 /24, IPv6 /48 — Matomo's granularity);
`units` is rate-limit cost (NPIs looked up; search = 10); `limited` counts 429s.

```bash
PSQL='docker exec -i postgres psql -U postgres -d npiradar'
# External demand by month: calls, distinct callers, callers seen on 2+ days (= real integrations)
$PSQL -c "SELECT date_trunc('month',day)::date m, endpoint, sum(requests) calls, count(DISTINCT caller) callers
          FROM api_usage WHERE source='external' GROUP BY 1,2 ORDER BY 1,2"
$PSQL -c "SELECT caller, count(DISTINCT day) days, sum(requests) calls, max(last_ua) ua
          FROM api_usage WHERE source='external' GROUP BY 1 HAVING count(DISTINCT day)>1 ORDER BY calls DESC"
```

Read it as: repeat external callers with non-browser UAs (curl, python-requests, a named app) are the
only real signal of paid-tier demand. One-off hits are people or bots poking the docs.

## Repo layout (planned)

```
~/npiradar/                 # source + Dockerfile (this dir)
  README.md
  ARCHITECTURE.md           # system design, rendering strategy, data model, SEO
  IMPLEMENTATION.md         # phased build plan + concrete tasks
  app/                      # Next.js App Router (added in Phase 1)
  lib/                      # npi validation, db, queries
  pipeline/                 # NPPES download → parse → load scripts
  Dockerfile
~/projects/npiradar/        # docker-compose.yml + .env (deploy side, per convention)
```

## Status

- [x] Direction + domain chosen (`npiradar.com`)
- [ ] Domain registered (user)
- [ ] Phase 0: NPPES data spike (download + load sample → Postgres)
- [ ] Phase 1: MVP pages + ISR + deploy
- See `IMPLEMENTATION.md` for the full plan.

## Data & ethics note

NPPES is public-domain U.S. government data; republishing is permitted. NPI data is **not PHI** — HIPAA does not
apply. Still: show **practice** (business) locations, not provider home/mailing addresses where distinguishable,
and provide a correction/removal contact. See `ARCHITECTURE.md → Legal & data hygiene`.
