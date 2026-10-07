# npiradar — Architecture

System design for serving a pSEO site over the ~8M-record NPPES dataset. The central constraint shapes everything:
**we have millions of pages and one developer.** That rules out full static generation and rules in
on-demand rendering + CDN caching over a queryable datastore.

---

## 1. Data source: NPPES

CMS publishes NPPES via the **Data Dissemination** files (verify current URL at dissemination time —
historically `download.cms.gov/nppes/NPI_Files.html`):

- **Full replacement file** — monthly. The main `npidata_pfile_YYYYMMDD-YYYYMMDD.csv` is ~9 GB uncompressed,
  ~8M+ rows, ~330 columns (most are repeating taxonomy/identifier/other-name groups).
- **Weekly incremental files** — deltas between monthly drops.
- **Deactivation file** — NPIs that have been deactivated (must be suppressed/marked).
- **NUCC taxonomy code set** — small reference file mapping taxonomy codes → human specialty names/groups.
- **NPPES API** (`npiregistry.cms.hhs.gov/api`, rate-limited JSON) — *not* used for serving (too slow/limited);
  useful only for spot-checks and possibly a "report incorrect data" recheck.

We ingest the **bulk file into our own Postgres** and serve from there. The API is never in the request path.

### Columns we keep (the rest are dropped at load)

NPI, entity type code (1 = individual, 2 = organization), provider name fields (first/last/org/credential),
sole-proprietor flag, primary taxonomy code + license/state, practice-location address (line, city, state, zip,
phone), enumeration date, last-update date, deactivation flag/date, and the secondary taxonomy codes (for
"also practices as" facets). **Mailing address is dropped** (can be a home address — see §7).

---

## 2. Data model (Postgres)

```
providers
  npi              bigint primary key
  entity_type      smallint           -- 1 individual, 2 org
  first_name, last_name, middle_name, credential   text
  org_name         text
  sole_proprietor  boolean
  primary_taxonomy text  references taxonomies(code)
  license_no, license_state  text
  addr_line, city, state, zip, phone   text         -- PRACTICE location only
  enumeration_date date
  last_updated     date
  deactivated      boolean default false
  -- derived for routing/SEO:
  slug             text                -- "jane-smith" (name) for pretty URLs (npi remains canonical id)

taxonomies                            -- from NUCC code set (~870 rows)
  code        text primary key        -- e.g. "207R00000X"
  display     text                    -- "Internal Medicine"
  grouping    text                    -- "Allopathic & Osteopathic Physicians"
  classification, specialization  text
  slug        text                    -- "internal-medicine"

provider_taxonomies                   -- secondary taxonomies (many-to-many)
  npi bigint, taxonomy_code text

-- Facet aggregates (materialized views, refreshed after each load):
mv_specialty_counts          (taxonomy_code, count)
mv_city_counts               (state, city, count)
mv_specialty_city_counts     (taxonomy_code, state, city, count)   -- drives /specialty/city pages + sitemaps
```

**Indexes:** PK on `npi`; GIN trigram on `last_name`/`org_name` (search); btree on `(state, city)`,
`(primary_taxonomy)`, `(primary_taxonomy, state, city)`; partial index `WHERE NOT deactivated`.

**Load:** transform the CSV with a streaming parser → `COPY` into a staging table → upsert into `providers`
(full file is an authoritative replace; incrementals upsert by NPI; deactivation file flips `deactivated`).
COPY-loading 8M rows is minutes, not hours.

---

## 3. URL & page taxonomy

| Pattern | Example | Count (order) | Value |
|---|---|---|---|
| Provider detail | `/npi/1234567890` | ~8M | long-tail (`[name] npi`, `[npi number]`) |
| Org detail | `/npi/1987654320` | ~1M | same |
| Specialty | `/specialty/internal-medicine` | ~870 | mid-head |
| City/state | `/in/tx/houston` | ~30k | local intent |
| **Specialty × city** | `/internal-medicine/houston-tx` | large, bounded by `mv_specialty_city_counts` | **highest-intent money pages** |
| Tools | `/tools/npi-validator`, `/tools/bulk-lookup` | few | tool-intent + link magnets |
| Search | `/search?q=` | 1 | UX entry |

`npi` is the **canonical identifier** in the URL (stable, unique, exactly what people paste). A name slug may be
appended for readability (`/npi/1234567890/jane-smith`) but the bare `/npi/{npi}` is canonical and self-sufficient.

---

## 4. Rendering strategy (the scale decision)

**Per-request rendering, not ISR or build-time SSG** (corrected 2026-10-07). Pre-rendering 8M pages at build
is infeasible for a solo dev (multi-hour builds, enormous deploys). The plan was on-demand ISR, but it never took
effect, and it now stays off on purpose:

- Provider, specialty, specialty×city, state and city pages, and their OG images, **render on every request**.
  They set `revalidate`, but none defines `generateStaticParams`, and Next 15 doesn't ISR a dynamic route
  without one, so the setting does nothing. Responses carry `cache-control: no-store`.
- Measured 2026-10-07: provider pages ~21 ms p50 / 64 ms p99 at ~22k hits/h (mostly crawlers); city and
  specialty pages 30-130 ms after the name-ordered indexes + `mv_facet_insights` (were 0.4-1.3 s); OG cards ~110 ms.
  Uncached rendering only works while every query is index-bound: a listing must use an index in its
  ORDER BY (`listByKeys` in `lib/facets.ts`), and per-facet aggregates must be precomputed (`facets.sql` §5). Caching ~9M provider pages would write each one to disk as it's crawled
  (tens of KB of HTML + RSC apiece), against 305 GB free, to save ~20 ms.
- So data is always live: a load is visible on the next request, with **no purge needed**. `/api/revalidate`
  only refreshes the genuinely static pages (`/about`, `/nppes`, the tools), which revalidate daily anyway.
- If this is ever revisited: add `generateStaticParams() { return [] }` to the route, then a data load must purge
  the affected paths (`revalidatePath('/npi/<npi>')`), and disk growth needs a bound.
- Detail pages are discovered via **sitemaps + facet interlinking** (§5), not pre-render.

This is the standard pSEO-at-scale pattern and keeps hosting on the existing single box.

---

## 5. Crawlability: sitemaps + internal linking

pSEO lives or dies on whether Google can *find and justify* the pages.

- **Sitemaps:** a sitemap **index** referencing many child sitemaps (50k URLs each → ~160+ files for detail pages).
  Generated from Postgres, served dynamically (`/sitemaps/providers-0001.xml`) or written to disk on refresh.
  Prioritize facet pages and high-signal providers; detail pages get lower priority but full coverage.
- **Internal linking (the crawl graph):** every provider page links → its specialty page, its city page, and its
  specialty×city page. Facet pages paginate through their providers and cross-link sibling facets
  ("Internal Medicine in nearby cities", "Other specialties in Houston"). This builds crawl paths **and** topical
  authority — the difference between "8M orphan pages" and "an interlinked directory."

---

## 6. SEO content quality (anti-thin-content)

Google penalizes thin/doorway pages — the #1 risk for any pSEO directory. Mitigations baked into the template:

- **Structured data (JSON-LD):** `Physician` / `MedicalBusiness` / `MedicalOrganization` per provider; `ItemList`
  on facet pages. Medical entities get rich treatment in search — a real ranking lever here.
- **Genuine per-page utility:** specialty explainer, taxonomy description, "providers in the same practice / same
  city / same specialty", map of practice location, NPI validity badge. Each page answers a real question, not just
  a data dump.
- Unique `<title>`/meta per page; canonical tags; clean breadcrumb trail; `noindex` on deactivated NPIs and
  empty/near-empty facet pages (avoid indexing thin facets).

---

## 7. Legal & data hygiene

- **Source:** NPPES, public domain (U.S. gov). Republishing permitted. Attribute the source + show data freshness date.
- **Not PHI:** the NPI registry is public professional data; HIPAA does not apply.
- **Address discipline:** show **practice (business) locations only**; **drop mailing addresses** (individuals'
  mailing addresses can be home addresses). Provide a visible **correction / removal-request contact** — provider
  directories do receive these, and honoring them cheaply avoids friction.
- No implication of endorsement by CMS/providers.

---

## 8. Deployment

Per the existing convention ([[deploy-convention-traefik-compose]]):

- **`~/npiradar/`** — source + `Dockerfile` (Next.js `output: standalone`).
- **`~/projects/npiradar/`** — `docker-compose.yml` + `.env`; Traefik labels for `npiradar.com`; services: `web`
  (Next standalone) + `db` (Postgres, persistent volume). Traefik terminates TLS (Let's Encrypt); no CDN.
- The **pipeline** (download/parse/load) runs as a scheduled job (cron/compose one-shot) monthly; it writes to the
  same Postgres and triggers cache revalidation.

> Watch-out (from prior Next standalone experience, [[th3-sh0p-snapshot-serving-gotcha]]): the standalone server
> memoizes `public/` at startup. Anything generated at runtime (e.g. sitemap files) must be served from a route
> handler or a mounted volume the server reads live — not dropped into `public/` post-boot.

---

## 9. Monetization (deferred until traffic)

Affiliate (medical billing / credentialing / malpractice insurance / telehealth platforms) · a freemium
**provider-data API** for healthtech devs · lead-gen for billing/credentialing services · display ads once volume
justifies. None of this is in the request path for v1 — ship the SEO surface first.
