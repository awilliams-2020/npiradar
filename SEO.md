# npiradar — SEO Plan

The whole thesis is SEO: rank a programmatic directory over the free NPPES dataset against weak pSEO incumbents and
the clunky official CMS registry. This doc is the concrete plan — what to build, in what order, and why — tied to
the keyword research. Status markers reflect the 2026-05-24 snapshot (`STATUS.md`).

---

## 1. The opportunity (from keyword research)

Source: `~/project-research/keywords-pseo-reference.json` + `research.md`. **Every term in the cluster is LOW
competition.**

| Query cluster | Volume/mo | Target page | Status |
|---|---|---|---|
| `npi lookup` / `npi finder` / `npi number search` / `doctor npi lookup` / `national provider identifier lookup` (one big LOW family) | **~301k** | **Home** + working search | home ✅ / search ❌ |
| `npi registry` / `national npi registry` / `npi number registry` | **~165k** | Home + an `/npi-registry` explainer angle | ❌ |
| `national provider identifier number` (+ variants) | **~135k** | Home / "what is an NPI" content block | ❌ |
| `nppes npi registry` / `nppes registry lookup` | **~33k** | Home + NPPES explainer | ❌ |
| `npi number lookup` / `find npi number` / `find my npi number` | **~27k** | Home + search + `/tools/npi-validator` | ❌ |
| `npi search` / `npi locator` | **~15k** | Home + search | ❌ |
| **The long tail:** `[doctor name] npi`, `[npi number]`, `[name] npi number` | **~8.1M addressable** | **`/npi/[npi]` provider pages** | ✅ |
| Specialty + local intent: `[specialty] in [city]`, `[specialty] [state]` | large, bounded | **facet + money pages** | ❌ |
| `npi check digit` / `npi validator` / `is this npi valid` | small but tool-intent + link magnet | **`/tools/npi-validator`** | ❌ |

**Reading of the data:** the *head* (300k+) is generic lookup/registry intent → it's won by the **home page + a fast
search box**, not by any one deep page. The *money* is in the **8.1M long tail** of provider-name and NPI-number
queries → provider detail pages (already built; need to be discoverable). Specialty×city facets capture the
mid-tail local intent. The validator is a cheap link magnet. This matches `ARCHITECTURE.md §3`.

**Competitive read:** incumbents are npilookup.io / npi-lookup.org (thin pSEO) and the official CMS registry
(authoritative but clunky, poor UX, no facets). We beat them on: per-page utility, structured data, internal
linking, and facet/local pages they don't have.

---

## 2. Page taxonomy → keyword mapping

| Pattern | Example | Order of count | Primary intent | Status |
|---|---|---|---|---|
| Home | `/` | 1 | head: "npi lookup / registry" | ✅ (needs head-term copy + working search) |
| Provider detail | `/npi/1234567890` | ~9.2M | `[name] npi`, `[npi]` | ✅ |
| Search | `/search?q=` | 1 | the "lookup" action | ❌ (home form 404s) |
| Specialty | `/specialty/internal-medicine` | ~870 | `[specialty] npi` / "find a [specialty]" | ❌ |
| City / state | `/in/tx/houston` | ~41k | local: "doctors in [city]" | ❌ |
| **Specialty × city** | `/internal-medicine/houston-tx` | ~1.08M (thresholded) | **highest-intent local** | ❌ |
| Validator tool | `/tools/npi-validator` | 1 | `npi check digit` + backlinks | ❌ |
| Bulk lookup tool | `/tools/bulk-lookup` | 1 | billing/credentialing pros | ❌ |

---

## 3. Sitemaps (the crawl-discovery backbone)

pSEO lives or dies on Google **finding and justifying** the pages. With ~9.2M indexable URLs, sitemaps are not
optional — they're how the long tail gets crawled.

### Delivery: route handlers, not files in `public/`

The Next standalone server **memoizes `public/` at startup** ([[th3-sh0p-snapshot-serving-gotcha]]) — files written
there post-boot 404. So **every sitemap is a route handler that reads Postgres**, not a generated file:

- Use Next's metadata sitemap convention with dynamic segments, or plain `app/<path>/route.ts` returning
  `Content-Type: application/xml`.
- Each handler is cached (`export const revalidate = 86400`) so the DB query runs at most daily per URL, then it's
  CDN-cached. 50k URLs of XML is a few MB — fine to generate on demand and cache.

### Structure: a sitemap index + child sitemaps

`/sitemap.xml` → a **sitemap index** pointing at child sitemaps (Google's limits: 50k URLs **and** 50 MB per file).

| Child sitemap | URLs | Files (÷50k) |
|---|---|---|
| Facets: specialty | ~870 | 1 |
| Facets: city/state | ~41k | 1 |
| Facets: specialty×city (above thinness threshold) | ~ tens–hundreds k | a few |
| Tools + static (home, /search landing) | <20 | 1 |
| **Provider detail (active only)** | **~9.2M** | **~184** |

Provider child sitemaps are paginated deterministically — `/sitemaps/providers/[page].xml`, page N = NPIs
`OFFSET N*50000 ORDER BY npi`, or keyset by NPI range (faster at depth). Exclude deactivated NPIs (they're
`noindex` anyway). `lastmod` = `last_update_date`. Keep `<priority>`/`<changefreq>` minimal (Google largely ignores
them); spend the signal on facets via internal linking instead.

> **Submit `/sitemap.xml` to Google Search Console** once the domain is live with real TLS. `robots.txt` already
> advertises it. This is the single highest-leverage action for getting the long tail crawled.

---

## 4. On-page SEO (per template)

**Provider `/npi/[npi]`** — ✅ mostly done. Has per-page title/description, `canonical`, JSON-LD
`Physician`/`MedicalOrganization`, `noindex` on deactivated. **To add:** Open Graph/Twitter tags;
`BreadcrumbList` JSON-LD; internal links to its specialty/city/specialty×city pages (§5); optional name slug
(`/npi/{npi}/{name-slug}` 301→ canonical bare-NPI). Watch title length on long org names.

**Home `/`** — needs head-term optimization: an H1 + intro that naturally carries "NPI lookup", "NPI registry",
"national provider identifier", and a short "What is an NPI / NPPES" explainer block (captures the 135k+
definitional intent and adds non-thin content). Working search box is the conversion of the head term.

**Facet pages (to build)** — unique `<title>`/meta per facet (`Internal Medicine Providers in Houston, TX — NPIRadar`),
canonical, `ItemList` JSON-LD over the listed providers, a real intro sentence (specialty/location description, count),
`BreadcrumbList`. `noindex` thin/empty facets (§6).

**Site-wide** — add Open Graph defaults in `app/layout.tsx`; a default OG image; `metadataBase` already set.

---

## 5. Internal linking (turn 9.2M orphans into a directory)

This is the difference between "millions of orphan pages" and "an interlinked directory" — and it's currently
**missing entirely**. The crawl graph:

- **Provider → facets:** every provider page links to its specialty page, its city page, and its specialty×city
  page. (Three links that inject every provider into the facet hierarchy.)
- **Facet → providers:** facet pages paginate their providers (cap indexable pagination depth — e.g. first N pages —
  to avoid index bloat on huge cities).
- **Facet → sibling facets:** "Other specialties in Houston", "Internal Medicine in nearby cities", "Internal
  Medicine by state". Builds topical clusters and spreads crawl equity.
- **Breadcrumbs** on every deep page: Home › Specialty › City › Provider, with `BreadcrumbList` JSON-LD.

---

## 6. Thin-content & duplication controls

Google penalizes thin/doorway directories — the #1 risk here.

- `noindex, follow` on **deactivated NPIs** (done) and on **near-empty facets** (e.g. a specialty×city with <N
  providers) — keep them crawlable/linked but out of the index.
- One **canonical** per page; bare `/npi/{npi}` stays canonical even if a name-slug variant exists.
- Cap facet **pagination** indexing depth; `rel=canonical` deep pages to page 1 or use `?page=` with care.
- Genuine per-page utility (specialty explainer, counts, map, "same practice / same city" lists) so pages aren't
  pure data dumps. This is a ranking lever, not just a penalty shield.

---

## 7. Technical SEO

- **robots.txt** — present, `Allow: /` + sitemap line. Once facets exist, consider disallowing `/search?` (faceted
  query noise) and any infinite-pagination traps.
- **Real TLS + Cloudflare** — register `npiradar.com`, point DNS, switch Traefik to `certresolver=default`, put
  Cloudflare in front to cache rendered HTML by URL (the economics that make 9.2M ISR pages viable). Until then the
  self-signed cert blocks indexing.
- **Core Web Vitals** — pages are server-rendered, minimal CSS, no client JS framework weight beyond Next runtime;
  in good shape. Keep provider pages light.
- **Freshness** — `DATA_VINTAGE` in the footer + `lastmod` in sitemaps signal recency; wire up cache-busting on
  monthly reload (`pipeline/README.md → Monthly refresh`) so fresh data actually ships.

---

## 8. Measurement

- **Google Search Console** — verify the domain, submit `/sitemap.xml`, watch **indexed-page count** climb (the
  pSEO health metric) and the Performance report for which clusters earn impressions.
- **Bing Webmaster Tools** — cheap second channel; submit the same sitemap.
- Track: indexed pages, impressions by query cluster (§1), and which facet depths convert to clicks → prune/expand
  the indexable facet set accordingly.

---

## 9. Build order (highest leverage first)

Each step is independently shippable. Current status in brackets.

1. **Materialized views** + slugs + facet indexes. `[x]` **Done 2026-05-24** — `pipeline/facets.sql`:
   `taxonomy.slug`, `us_states` whitelist, partial composite + name indexes, and the three MVs.
   Re-run by `load.ts --finalize` each monthly load.
2. **Sitemaps** — index + provider child sitemaps (route handlers, DB-driven, cached). `[x]` **Done** —
   `/sitemap.xml` index + `/sitemaps/providers/[n].xml` (184 × 50k) + facet sitemaps (specialties, cities,
   specialty-cities, pages) = 193 children total.
3. **`/search`** — `[x]` **Done** — `/search?q=` redirects 10-digit NPIs to `/npi/{npi}`, else prefix name search
   over the partial `last_name`/`org_name` indexes. Fixes the broken home form. (`/api/search` JSON endpoint deferred.)
4. **Facet pages** — `[x]` **Done** — `/specialty`, `/specialty/[slug]`, `/in/[state]`, `/in/[state]/[city]`
   (paginated, ISR, `ItemList`, intros, canonical, pagination-depth `noindex`).
5. **Internal linking** — `[x]` **Done** — provider→specialty/city/specialty×city, facet→siblings + nearby,
   `BreadcrumbList` on every deep page, header nav, home links to top specialties/cities.
6. **Money pages** — `[x]` **Done** — `/specialty/[slug]/[citystate]` from `mv_specialty_city_counts`; rendered
   for all, `noindex` + excluded from sitemap below 5 providers (264,860 indexable of 1.07M).
7. **On-page polish** — `[x]` **Done** — OG/Twitter defaults in layout, head-term home title + "What is an NPI?"
   explainer. (Name slugs on `/npi` URLs still deferred — bare NPI stays canonical.)
8. **Validator tool** `/tools/npi-validator` — `[x]` **Done** — client-side check-digit validation + explainer.
9. **Go live** — register domain ✅, DNS ✅, real Let's Encrypt TLS ✅ (`certresolver=default`, 2026-05-24).
   Cloudflare **deferred** (ISR caches on-box; not needed at zero traffic). **Remaining: submit `/sitemap.xml` to
   Google Search Console** — the last step, and now the only thing between this and ranking.

**Post-launch enhancements (done 2026-05-24):**
- **Public `/api/npi/[npi]` JSON API** (CORS-open, no key) — backlink magnet + freemium-API seed.
- **`/tools/bulk-lookup`** — paste ≤100 NPIs → table + CSV; consumes the API. Second link magnet.
- **OG images** — default branded card (`app/opengraph-image.tsx`) plus **per-page** cards for provider / specialty /
  money / city pages (`app/_og/card.tsx` + `opengraph-image.tsx` in each route), `summary_large_image`.
- **Radar favicon** — `app/icon.svg` (shows in tabs + Google SERP).
- **Monthly-refresh cache-bust** — `pipeline/refresh.sh` (load + `--force-recreate`, since `restart` won't clear ISR).
- **Copy pass** — stripped AI-isms (em-dash overuse, repeated "from the public NPPES registry" tagline, cloned triads)
  per [[copy-no-ai-smell]]; nav spacing + breadcrumb/mobile styling fixes.

> URL scheme chosen 2026-05-24: money pages nest under `/specialty/[slug]/[citystate]` (e.g.
> `/specialty/internal-medicine-physician/houston-tx`) — avoids a root-level catch-all footgun. Specialty slugs
> come from the NUCC display name (`internal-medicine-physician`, not `internal-medicine`).
</content>
