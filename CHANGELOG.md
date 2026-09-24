# Changelog

All notable changes to npiradar are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
