# Changelog

All notable changes to npiradar are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — Registry history: month-over-month change log (2026-10-07)

**Why:** NPPES publishes only each provider's current record. History exists only if someone keeps it,
and it can't be backfilled, so every load we skip is lost for good. It is the one thing on a provider
page that CMS's own registry can't show.

**What changed:**
- `load.ts --diff <schema>` compares the freshly built schema with `live` and writes
  `public.provider_changes (release, npi, change, old_value, new_value)`. That table sits outside the swapped
  schemas, so it accumulates. Change types: `added`, `removed`, `deactivated`, `reactivated`,
  `practice_address`, `practice_phone`, `primary_taxonomy`, `name`, `credential`, `license`.
- `load-parallel.ts` runs it right before `--swap`. A failed diff is logged and never blocks the swap.
- `release` = the new file's `max(last_update_date)`. A same-release re-run is skipped, so it can't wipe
  that month's diff. Deactivated records arrive with fields blanked, so a (de)activation is recorded alone.
- Runs serially at `work_mem=64MB` (~25s on 9.8M rows). A parallel hash join at 256MB/worker overflowed
  postgres's 1GB `/dev/shm`.
- `/npi/[npi]` shows a "Registry history" section; `GET /api/npi/{npi}` adds `changes`.
- **First diff: the October 2026 release** (September vs September gave 0 differences, a sanity check).

### Changed — Real data-vintage label, 6-hourly refresh check, NPPES side files (2026-10-07)

**Why:** The site said "NPPES — May 2026 release" while serving the September file. `DATA_VINTAGE` was a
hand-bumped constant, missed for four loads, so Google and `llms.txt` readers saw a site 5 months stale.
The refresh also ran on the 1st while CMS posts around the second weekend, so data was 3–7 weeks old.
And every page was a strict subset of CMS's own registry: the loader discarded the three side files.

**What changed:**
- `dataVintage()` (`lib/facets.ts`) reads the last successful `refresh_runs.source_file` →
  "NPPES — September 2026 release". Used by the footer, the homepage Dataset JSON-LD, `llms.txt`, `/nppes`,
  `/npi-api`, `/tools/bulk-lookup`. At build (no DB) it falls back to "NPPES monthly release", so the
  static pages now `revalidate` daily.
- `refresh-server.ts` runs its own check every 6h (plus 60s after boot). No-op unless CMS has a newer file.
- `fetch-monthly.sh` also extracts `othername_`, `pl_` and `endpoint_pfile_*.csv`; `load.ts --side` COPYs them
  (in parallel with the provider shards) into `provider_other_names` (853k), `provider_locations`
  (1.19M, 776k NPIs) and `provider_endpoints` (598k: Direct, CONNECT, SOAP, FHIR…). Indexed on npi, LOGGED.
- `/npi/[npi]` shows Other names / Other practice locations / Electronic endpoints (first 25 of each).
  `GET /api/npi/{npi}` adds `otherNames`, `secondaryLocations`, `endpoints` (all rows) and their counts.
  Bulk `POST /api/npi` is unchanged.
- Homepage Dataset `creator` `GovernmentOrganization` → `Organization` (GSC: `Invalid object type for field "creator"`).

### Changed — Index-eligibility cut: 307k → ≈10.7k submitted URLs (2026-09-24)

**Why:** The 2026-09-24 search audit (`~/scripts/seo/audits/npiradar.md`) found 1 of 156 ranking pages
indexed (3/210 on 07-27), and 20 of 20 sampled sitemap URLs never discovered. Googlebot has dropped to about 40
requests a day. The tools pages and `/specialty` were still "URL is unknown to Google". Nearly half of all city
pages (17,734 of 37,850) had fewer than 5 providers, many of them NPPES address typos (`/in/az/cullman`,
`/in/mo/crystal-cty`). Google was declining the corpus as scaled thin content.

**What changed:**
- `INDEXABLE_MIN` 5 → **200** (specialty×city); new `CITY_INDEXABLE_MIN = 250` wired into the city page's
  robots meta and `cities.xml`. Below threshold a page is `noindex, follow`: still crawlable, linked, and
  unchanged for users.
- `SITEMAP_RULES_VERSION` floor on `dataVersion()`. Without it the 304 short-circuit (below) would hide the
  cut: Google's `If-Modified-Since` still matched the data version, so it would never re-fetch the smaller
  sitemaps. Bump it whenever inclusion rules change.
- New `/nppes` explainer and `/npi-api` docs page (in `pages.xml`, nav, home, `llms.txt`). Bulk-lookup is
  refocused on bulk and points to `/npi-api` instead of carrying the full API docs.

### Added — Public API: bulk + search endpoints with first-class rate limiting (2026-07-13)

**Why:** GSC surfaced real demand for programmatic access (e.g. *"ai tool that pulls bulk practice
locations based on npi free nppes"*), but the only endpoint resolved a single known NPI — no batch,
no discovery, and no app-level rate limiting beyond Traefik's coarse edge limit.

**What changed:**
- `POST /api/npi` — bulk lookup (≤100 NPIs) in one `WHERE npi = ANY(...)` round-trip
  (`lib/provider.ts → getProviders`). `app/tools/bulk-lookup/bulk.tsx` now makes one POST instead of
  a 100-way per-NPI client fan-out.
- `GET /api/search` — filtered discovery by `name` / `specialty` / `state` / `city`
  (`lib/facets.ts → searchProvidersApi`), with guardrails that keep every query on an index.
- **Rate limiting as a shared primitive** — Redis-backed, cost-weighted, per-IP (`lib/redis.ts`,
  `lib/ratelimit.ts`, `lib/api.ts`), applied to all three public endpoints. One token budget
  (default 600/min/IP); single = 1, bulk = N NPIs, search = 10. Emits `X-RateLimit-*` + `Retry-After`.
  Fails open if Redis is unreachable.
- Deps/infra: `ioredis` added (+ `serverExternalPackages`); `REDIS_URL=redis://redis:6379` in the
  `projects/npiradar` compose.

**Operational detail + verification commands:** see `OPERATIONS.md`.

### Changed — Sitemap crawl-budget efficiency (2026-06-14)

**Why:** A Search Console diagnosis (scripts in `~/project-research/gsc-diagnose.cjs`,
`gsc-inspect.cjs`) found indexation was crawl-starved, not quality-rejected. A random sample of
14 provider pages all came back *"URL is unknown to Google — never crawled,"* while the crawl-stats
export showed Googlebot spending **~84% of its budget on "refresh"** and **~79% on "other file
type."** Those non-HTML refresh hits are the sitemap XML files: every child sitemap was
`force-dynamic` with no `Last-Modified` and no `lastmod` on the index entries, so Google
re-downloaded the full set on every pass instead of being told they were unchanged.

NPPES data only changes with the monthly load, so sitemaps only change monthly. We now say so.

**What changed:**

- `lib/sitemap.ts`
  - `xmlResponse(xml, lastmod?)` now sets a `Last-Modified` validator when given a data version.
  - Added `notModified(req, lastmod)` and `notModifiedResponse(lastmod)` to answer conditional
    re-crawls (`If-Modified-Since`) with a cheap **304** instead of a full XML re-download.
- `lib/facets.ts`
  - Added `dataVersion()` — `max(last_update_date)` as a `YYYY-MM-DD` stamp, cached per-instance for
    a day (the one uncached `max()` over ~9M rows runs at most once per instance per day). Fails open
    to today's date so a DB blip triggers a re-crawl rather than serving a stale validator.
- Sitemap routes now stamp `Last-Modified` and short-circuit unchanged re-crawls to 304:
  - `app/sitemap.xml/route.ts` (index) — also adds `<lastmod>` to every child `<sitemap>` entry, so
    Google can skip child sitemaps it already has at that version.
  - `app/sitemaps/providers/[file]/route.ts`
  - `app/sitemaps/specialty-cities/[file]/route.ts`
  - `app/sitemaps/cities.xml/route.ts`
  - `app/sitemaps/specialties.xml/route.ts`
  - The provider/specialty-city routes 304 **before** querying the DB; safe because the page set can
    only change when `dataVersion` advances, so a 304 never masks a page that has since 404'd within
    the same data version.

**Expected effect:** Googlebot stops re-downloading unchanged sitemaps every pass, redirecting the
recovering crawl budget toward actual provider HTML pages — faster discovery/indexation of the
long tail. After each monthly load `dataVersion` advances and Google re-fetches all sitemaps once,
which is correct (the data did change).

**Verification:** `tsc --noEmit` clean. (No local eslint binary; repo exposes only a `build` script.)

### Investigated but intentionally not changed

- **Internal linking** — already solid: provider pages link to their specialty/city/specialty×city
  hubs (`LinkChips`), and hubs list providers with pagination (`ProviderList` + `Pager`). No change
  needed; the discovery gap was crawl budget, not the link graph.
- **`robots.txt` resilience** — served from `public/` by the Node app, so it goes down during an
  outage (GSC showed ~0.64% "robots.txt unavailable", which pauses crawl). Serving it from Traefik
  independent of the app would make crawl pauses impossible. Deferred — infra change, and reliability
  is already recovering. Tracked as a follow-up.
