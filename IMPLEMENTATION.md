# npiradar — Implementation Plan

Phased so each step ships something and de-risks the next. Build the data layer before the app; ship a thin SEO
surface before scaling pages. Solo-dev cadence — each phase is a few focused sessions.

---

## Phase 0 — Data spike (de-risk first) ⏱ ~1 session — **mostly done (2026-05-24)**

Prove the dataset is workable before writing any app code.

- [x] Download the latest NPPES file + NUCC taxonomy + deactivation file. **Spiked on the weekly slice**
      (`...Weekly_V2.zip`, 6.4 MB) — identical column layout to the monthly, so the parser is built/tested cheaply.
- [x] Stream-parse the CSV — `pipeline/parse.ts` (csv-parse streaming) + shared mapping in `pipeline/lib/provider.ts`.
      ~8k rows/s → ~16 min projected for the 8M-row monthly.
- [x] `COPY` into a Postgres `providers` staging table (`pipeline/load.ts`); row counts, column mapping, taxonomy
      join, and practice-vs-mailing columns all confirmed. Loaded into the **shared `postgres` container, db `npiradar`**.
- [x] Spot-check NPIs against the official registry — 2 checked via the NPPES API (`?version=2.1&number=`),
      name/city/state/primary-taxonomy all matched exactly.
- [ ] **Remaining:** run the full monthly load for true full-state row counts (volume confidence only — correctness done).
- **Exit criteria:** ✅ a Postgres table you can query (`WHERE practice_state='TX' AND primary_taxonomy_code='207Q00000X'`
      returns real TX family-medicine providers) and trust.

**Spike findings — bake these into the loader:**
- Use the **`_V2`** files. CMS retired V1 on **2026-03-03**; bare/V1 names 404. Filenames carry the month/date and
  change monthly, so re-scrape the JS-rendered index (`download.cms.gov/nppes/NPI_Files.html`) for the current name.
- `<UNAVAIL>` and `""` → NULL. Dates are `MM/DD/YYYY` → ISO. ZIP is 9 digits, no hyphen (store raw, format on render).
- Primary taxonomy = the slot whose `…Primary Taxonomy Switch_N = Y`; fall back to slot 1 (fallback unused in the slice).
- **Practice ≠ mailing for ~10% of rows** (and either can be out-of-state) — geo facets use *practice* location.
- **Deactivated NPIs arrive as near-empty rows** (NPI + deactivation date only, blank entity type/name/address).
  In the slice: 854 of 33,383 deactivated → `noindex`/exclude from facets (their practice_state is NULL anyway).

## Phase 1 — MVP pages + deploy ⏱ ~3-4 sessions — **in progress (2026-05-24)**

Smallest thing Google can index.

- [x] Full load: **9,551,447 rows** into Postgres (UNLOGGED staging, deferred PK/indexes), taxonomy loaded,
      deactivation captured, indexes built. ~23 min single-process. Registry is ~9.5M now, not ~8M.
- [ ] Materialized views for facet counts (`mv_specialty_counts`, `mv_city_counts`, `mv_specialty_city_counts`).
- [~] Next.js 15 App Router app (`output: standalone`), merged into `~/npiradar/`:
  - [x] `/npi/[npi]` provider detail (ISR `revalidate` 30d, `dynamicParams`) + JSON-LD `Physician`/`MedicalOrganization`,
        NPI check-digit badge, `noindex` on deactivated. Facet query hits `idx_providers_state_taxonomy` in <1ms.
  - [x] Home (`force-dynamic`, live registry count) + `not-found` + `robots.txt`.
  - [ ] `/specialty/[slug]` and `/in/[state]/[city]` facet pages (paginated, ISR).
  - [ ] Provider search box → `/api/search` (Postgres trigram on name). (Home form posts to `/search` — route TODO.)
  - [ ] sitemap **index** + provider/facet child sitemaps (route handlers, generated from DB).
- [x] Dockerfile (Next standalone) + `~/projects/npiradar/docker-compose.yml` + Traefik labels for `npiradar.com`.
      **Deployed and serving** via Traefik over HTTPS. Using Traefik's **self-signed default cert** for now
      (`tls=true`, no certresolver) since the domain isn't registered; swap to `certresolver=default` once it is.
      App connects to the shared Postgres at `postgres:5432` on the `db` network.
      **Gotcha fixed:** the standalone runner must own `.next/cache` (`mkdir -p .next/cache && chown nextjs`) or
      ISR/`unstable_cache` writes fail with EACCES — see [[th3-sh0p-snapshot-serving-gotcha]] for the sibling lesson.
- [ ] Register `npiradar.com` + point Cloudflare at the server; then real TLS + submit sitemap to GSC.
- **Exit criteria:** live on `npiradar.com`, provider + facet pages rendering via ISR, sitemap submitted.

## Phase 2 — Interlinking + facets at scale ⏱ ~2-3 sessions

Turn orphan pages into a crawlable, authoritative directory.

- [ ] `/[specialty]/[city-state]` money pages from `mv_specialty_city_counts` (skip/`noindex` thin ones).
- [ ] Internal-link graph: provider → specialty/city/specialty×city; facet → sibling facets + "nearby cities".
- [ ] Breadcrumbs + `BreadcrumbList` JSON-LD; `ItemList` on facet pages.
- [ ] `noindex` deactivated NPIs and near-empty facets; canonical discipline.
- [ ] Full sitemap coverage (all detail + indexable facet URLs), prioritized.
- **Exit criteria:** every page reachable by internal links within a few hops; GSC indexed-page count climbing.

## Phase 3 — Tools (link magnets + tool-intent traffic) ⏱ ~1-2 sessions

- [ ] `/tools/npi-validator` — deterministic client-side check-digit validation (algorithm below). Targets
      `npi number validator` / `npi check digit`. Zero backend.
- [ ] `/tools/bulk-lookup` — paste/upload many NPIs → table + CSV export (calls `/api/npi/[npi]` batch).
- [ ] Optional: `/api/npi/[npi]` public JSON endpoint (seeds the future freemium API + invites backlinks).

## Phase 4 — Freshness + monetization ⏱ ongoing

- [ ] Automate the monthly refresh (download full file → load → refresh MVs → bump cache version / purge CDN).
      Apply weekly incrementals + deactivation file between monthly drops.
      Loader is built: `pipeline/load.ts` (UNLOGGED staging, deferred PK/indexes, `synchronous_commit=off` — kind
      to the shared instance) with `--prepare`/`--shard i/N`/`--finalize` modes; `pipeline/load-parallel.ts` fans
      out N workers. Prefer single-process first; the `--shard` workers each re-tokenize the whole file, so the
      realistic parallel win is ~2× (physical-split the CSV if you ever need more).
- [ ] Add affiliate placements (billing/credentialing/malpractice/telehealth) on high-traffic pages.
- [ ] Formalize the provider-data API (freemium tiers) once there's developer demand.
- [ ] Display ads once volume justifies.

---

## NPI validation algorithm (for the Phase 3 tool)

NPIs carry a Luhn check digit computed over the 9-digit base **prefixed with `80840`** (the ISO issuer prefix for
US health applications). Pure function, no data needed:

```ts
// lib/npi.ts
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const base = "80840" + npi.slice(0, 9); // 14 digits fed to Luhn
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = +base[base.length - 1 - i];
    if (i % 2 === 0) {           // double every 2nd digit from the right
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === +npi[9];
}
// Worked example: 1234567893 → base 80840123456789 → sum 67 → check 3 → matches 10th digit ⇒ valid.
```

---

## Concrete decisions still open (resolve as you build)

- **Search backend:** start Postgres trigram; add Meilisearch/Typesense only if name autocomplete feels slow at scale.
- **Name slug in URL:** `/npi/{npi}` (canonical) vs `/npi/{npi}/{name-slug}` (prettier). Keep bare-npi canonical regardless.
- **City slugging:** decide canonical form for `City, ST` → slug (lowercase, dash, ascii-fold) and store it (don't recompute per request).
- **Pagination depth for facets:** cap indexable pagination (e.g. first N pages) to avoid index bloat on huge cities.

---

## Infrastructure (use the shared stack — not a throwaway container)

The home server already runs a shared **`postgres`** container (TimescaleDB pg15) on the external **`db`** network,
host port **5433**, creds `postgres:<password>`. Each project gets its own database (cf. `confession_board`, `theqrcode`).

- Spike DB created: `npiradar`. Pipeline (host-run) → `postgresql://postgres:<password>@localhost:5433/npiradar`.
- The Phase 1 web app's compose+env live in **`~/projects/npiradar/`** (split layout), joining the `db` + `traefik`
  external networks like `confession-board`; in-network DSN is `postgresql://postgres:<password>@postgres:5432/npiradar`.

## First commands (Phase 0 kickoff)

```bash
cd ~/npiradar
npm install                                  # pipeline deps: csv-parse, pg, pg-copy-streams, tsx

# create the spike DB in the shared instance (NOT a new container)
docker exec postgres psql -U postgres -c "CREATE DATABASE npiradar;"

# parse (inspect + stats) then load (COPY into staging), pointed at the weekly slice:
npx tsx pipeline/parse.ts pipeline/data/weekly/npidata_pfile_*.csv --taxonomy pipeline/data/nucc_taxonomy_251.csv
npx tsx pipeline/load.ts  pipeline/data/weekly/npidata_pfile_*.csv --taxonomy pipeline/data/nucc_taxonomy_251.csv

# scaffold the app later: npm create next-app@latest . -- --ts --app --eslint
```
