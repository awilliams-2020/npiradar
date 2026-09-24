# npiradar — Current State (snapshot 2026-05-24)

A point-in-time picture of what is **actually built, loaded, and serving** — distinct from the plan in
`IMPLEMENTATION.md`. Update this when the state materially changes; it's the fastest way to re-orient.

> TL;DR: The full NPPES monthly is loaded (9.55M rows) and the site is **live behind Traefik**, serving the
> home page and provider-detail pages via ISR. The **ranking surface is not built yet** — no sitemap, no facet
> pages, no search route, no internal linking. Those are the next body of work (see `SEO.md`).

---

## Infrastructure (running)

| Piece | State |
|---|---|
| **App container** `npiradar` | Up — Next.js 15.5.18 `output: standalone`, listening on `:3000`, on the `traefik` + `db` networks. |
| **Routing** | Traefik routes `Host(npiradar.com) \|\| Host(www.npiradar.com)` → container. |
| **TLS** | **Live Let's Encrypt cert (2026-05-24)** — `certresolver=default` (HTTP-01), SAN `npiradar.com` + `www.npiradar.com`, valid to 2026-08-22. HTTP→HTTPS 301. (Note: combined cert fails atomically if any SAN's DNS is missing — `www` must resolve before issuance.) |
| **Database** | Shared `postgres` container (TimescaleDB pg15), host port **5433**, db **`npiradar`**, creds `postgres:<password>`. App reaches it in-network at `postgres:5432`; host-run pipeline uses `localhost:5433`. |
| **Deploy layout** | `~/projects/npiradar/` = `docker-compose.yml` + `.env`; `~/npiradar/` = source + `Dockerfile`. ([[deploy-convention-traefik-compose]]) |
| **CDN** | **Not in front yet.** Cloudflare is planned to cache rendered HTML by URL; until the domain is live, ISR + the container's `.next/cache` is the only caching layer. |

Rebuild & redeploy:
```bash
cd ~/projects/npiradar && docker compose up -d --build   # rebuilds from ~/npiradar via the compose build context
```

## Data (loaded)

Full **May 2026 monthly** NPPES file loaded (not the weekly slice). Counts as of this snapshot:

| Metric | Value |
|---|---|
| providers (total) | **9,551,447** |
| providers (active, `deactivation_date IS NULL`) | **9,189,862** |
| taxonomy codes (NUCC) | 883 |
| distinct primary taxonomies in use (active) | 871 |
| distinct `(state, city)` (active) | 40,987 |
| distinct `(state, city, taxonomy)` (active) | 1,080,199 |
| Data vintage string (`lib/format.ts → DATA_VINTAGE`) | `NPPES — May 2026 release` |

**Schema:** two tables, both `UNLOGGED` (rebuildable from the monthly file — no WAL cost).
- `providers` — PK on `npi`; btree indexes on `practice_state`, `primary_taxonomy_code`, `(practice_state, primary_taxonomy_code)`. Columns: see `pipeline/lib/provider.ts → PROVIDER_COLUMNS`.
- `taxonomy` — PK on `code`; `grouping / classification / specialization / display_name / section` from the NUCC set.

**Facet layer (added 2026-05-24, `pipeline/facets.sql`):** `taxonomy.slug`; a `us_states` whitelist (59 codes —
NPPES carries ~1,000 foreign/junk `practice_state` values, excluded from geo facets); partial provider indexes
`(practice_state, practice_city, primary_taxonomy_code)`, `last_name`, `org_name` (active rows, for facets + name
search); and three materialized views — `mv_specialty_counts` (870), `mv_city_counts` (37,720), and
`mv_specialty_city_counts` (1,083,981; 5,194 at the ≥200-provider index threshold). Each MV has a UNIQUE index for
`REFRESH … CONCURRENTLY`.

## App routes (built)

| Route | Rendering | SEO features |
|---|---|---|
| `/` | `force-dynamic`, 1-day count cache | head-term title/desc, canonical, OG/Twitter, "What is an NPI?" block, internal links to top specialties/cities, working search form |
| `/search?q=` | `force-dynamic`, `noindex` | NPI (10 digits) → 307 to `/npi/{npi}`; else name prefix search (last/org name) |
| `/npi/[npi]` | ISR 30d, `dynamicParams` | title/desc, canonical, JSON-LD `Physician`/`MedicalOrganization` + `BreadcrumbList`, validity badge, `noindex` on deactivated, **internal links to its specialty/city/specialty×city** |
| `/specialty` | `force-dynamic` | index of all 870 specialties |
| `/specialty/[slug]` | ISR 30d, `dynamicParams` | title/desc, canonical, `ItemList`+`BreadcrumbList` JSON-LD, paginated, links to top cities (money pages) |
| `/specialty/[slug]/[citystate]` | ISR 30d, `dynamicParams` | **money page**; `noindex` if <5 providers or page >10; sibling links (other specialties in city, same specialty other cities) |
| `/in/[state]` | ISR 30d, `dynamicParams` | state → city index (US states only) |
| `/in/[state]/[city]` | ISR 30d, `dynamicParams` | city page; `ItemList`+`BreadcrumbList`, links to specialties-in-city + other cities |
| `/tools/npi-validator` | static + client component | client-side check-digit validator (link magnet), explainer content |
| `/tools/bulk-lookup` | static + client component | paste ≤100 NPIs → table + CSV export; consumes the public API |
| `/api/npi/[npi]` | route handler, CORS-open | public JSON provider lookup (200/404/400); backlink magnet + freemium-API seed |
| `/opengraph-image` + per-route `opengraph-image` | `next/og` | 1200×630 social cards — default + per-page (provider / specialty / money / city) via `app/_og/card.tsx`; `summary_large_image` |
| `/icon.svg` | static | radar favicon (browser tabs + SERP) |
| `/_not-found` · `/robots.txt` | static | robots advertises `/sitemap.xml` |
| `/sitemap.xml` | route handler | **index** (193 children): pages + specialties + cities + 6 money-page files + 184 provider files |
| `/sitemaps/providers/[n].xml` | route handler | 50k active providers each (`/npi/{npi}` + per-record `lastmod`) |
| `/sitemaps/specialties.xml` · `cities.xml` · `specialty-cities/[n].xml` · `pages.xml` | route handlers | facet + static URLs. Index thresholds (`lib/facets.ts`): specialty×city ≥200 providers, city ≥250; below → `noindex, follow` and out of the sitemap (cut 2026-09-24, ≈10.7k URLs total) |

Root layout sets `metadataBase`, OG/Twitter defaults, header nav (Search · Specialties), and CMS attribution.

## Known gaps / next steps

Most of the SEO surface is built. Remaining:

- **Go-live progress:** ✅ domain registered, ✅ DNS (apex + www → 46.110.4.68), ✅ real Let's Encrypt TLS live.
  **Remaining: submit `/sitemap.xml` to Google Search Console** (verify the domain property, then add the sitemap).
  Cloudflare **deliberately deferred** — Next ISR already caches rendered pages on-box, and Traefik `ratelimit` +
  `traefik-ai-monitor` cover abuse; a CDN's edge/bandwidth/DDoS role isn't needed at zero traffic. Add later (with a
  Cloudflare Origin Cert or DNS-01, so it doesn't break Let's Encrypt) only if crawl load / bandwidth justifies it.
- **Monthly refresh cache-bust** — handled by `pipeline/refresh.sh` (load + `--force-recreate`). Note: a plain
  `docker restart` does **not** clear `.next/cache` (ISR), so use the script / `--force-recreate`. Weekly
  incrementals + deactivation-file handling still not wired (monthly full replace only).
- **Deep-pagination & search depth** — facet pagination is capped at 10 indexable pages; name search is whole-string
  prefix only (no fuzzy/multi-token). Both fine for v1.
- **Not built:** name slugs on provider URLs (bare NPI stays canonical); per-page dynamic OG images (one default card
  for all pages today); weekly-incremental loading.

## Pointers

- How to run/refresh the data pipeline → **`pipeline/README.md`**
- SEO build plan (sitemaps, facets, interlinking, structured data) → **`SEO.md`**
- System design & rationale → `ARCHITECTURE.md` · Phased plan → `IMPLEMENTATION.md`
</content>
</invoke>
