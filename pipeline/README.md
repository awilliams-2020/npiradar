# npiradar — Data Pipeline Runbook

How to get the NPPES dataset from CMS into the `npiradar` Postgres database, and how to refresh it monthly.

The pipeline is three small scripts sharing one row-mapping module:

| Script | Role |
|---|---|
| `pipeline/lib/provider.ts` | Single source of truth for the NPPES column mapping + data fixes. Imported by both other scripts so they can't drift. Pure functions. |
| `pipeline/parse.ts` | **Inspect only.** Streams the CSV, prints samples + data-quality stats, optionally writes NDJSON. Touches no DB. Use it to sanity-check a new monthly file before loading. |
| `pipeline/load.ts` | **The loader.** DDL → `COPY` into `UNLOGGED` staging → PK/indexes → ANALYZE + verification. Runs host-side against port 5433. |
| `pipeline/load-parallel.ts` | Fan-out orchestrator: spawns N `load.ts --shard` workers. ~2× at best (each worker re-tokenizes the whole file); prefer single-process. |

All paths below are relative to `~/npiradar`. The pipeline runs **on the host** (not in a container) and talks to
the shared Postgres on `localhost:5433`, db `npiradar`.

---

## Prerequisites

```bash
cd ~/npiradar
npm install                       # csv-parse, pg, pg-copy-streams, tsx
# DB exists already; to recreate from scratch:
docker exec postgres psql -U postgres -c "CREATE DATABASE npiradar;"
```

`DATABASE_URL` defaults to `postgresql://postgres:<password>@localhost:5433/npiradar` (the host-published port of the
shared container). Override via env if needed. **Don't** point the host pipeline at `postgres:5432` — that name only
resolves inside the `db` Docker network.

---

## Step 1 — Download the NPPES files (manual)

CMS publishes the dissemination files at the JS-rendered index
**`download.cms.gov/nppes/NPI_Files.html`**. There is no stable URL — **the filename carries the date and changes
every month**, so open the page and grab the current link. Download into `pipeline/data/`:

- **Full monthly replacement** — `NPPES_Data_Dissemination_<Month>_<Year>_V2.zip` (~1 GB zip, ~9 GB CSV, ~9.5M rows).
  This is the authoritative file; a full load replaces everything.
- **NUCC taxonomy code set** — `nucc_taxonomy_NNN.csv` (small; maps taxonomy code → specialty name/grouping).
  Published separately by NUCC; the version number bumps a couple times a year.
- *(optional, for incrementals)* the **weekly** files and the **deactivation** file.

**Gotchas baked in from the Phase 0 spike:**
- **Use the `_V2` files.** CMS retired V1 on 2026-03-03; bare/V1 filenames now 404.
- The zip expands to several `*_pfile_*.csv` files — the one you load is **`npidata_pfile_<dates>.csv`** (the others:
  `pl_` practice locations, `othername_`, `endpoint_` — not used by the current loader).
- The `*_fileheader.csv` siblings are just the header row; ignore them.

After unzip, the layout looks like `pipeline/data/monthly/npidata_pfile_20050523-20260510.csv` +
`pipeline/data/nucc_taxonomy_251.csv` (current as of the May 2026 load).

## Step 2 — Inspect (optional but recommended on a new file)

Confirms the column layout still matches and surfaces data-quality numbers before you commit to a load. Streams —
safe on the 9 GB file.

```bash
npx tsx pipeline/parse.ts pipeline/data/monthly/npidata_pfile_*.csv \
  --taxonomy pipeline/data/nucc_taxonomy_251.csv
# add --limit 100000 for a fast spot-check, or --out parsed.ndjson to dump mapped rows
```

It prints sample mapped providers, entity/deactivation/missing-field counts, top states & taxonomies, and — the
important one — **whether every primary taxonomy code resolved against the NUCC set**. `buildColIndex()` throws if an
expected NPPES column is missing, so a schema change fails loudly here rather than silently nulling columns.

## Step 3 — Load

**Single process does everything** (prepare DDL + load taxonomy + COPY providers + build PK/indexes + verify):

```bash
npx tsx pipeline/load.ts pipeline/data/monthly/npidata_pfile_*.csv \
  --taxonomy pipeline/data/nucc_taxonomy_251.csv
```

~23 min for the full ~9.5M-row file. What it does, and why it's kind to the shared instance:
- `UNLOGGED` staging tables → no WAL traffic (the data is reconstructible from the monthly file).
- `SET synchronous_commit = off` for the load session.
- PK + the three indexes (`practice_state`, `primary_taxonomy_code`, `(practice_state, primary_taxonomy_code)`) are
  built **once, after** the bulk COPY, with `maintenance_work_mem = 512MB`.
- Then `ANALYZE` + verification queries print row counts, the taxonomy-join miss count (should be 0), and a sample
  "TX family medicine" result so you can eyeball correctness.

**Parallel** (only if you need it — realistic win ~2×):
```bash
npx tsx pipeline/load-parallel.ts pipeline/data/monthly/npidata_pfile_*.csv \
  --taxonomy pipeline/data/nucc_taxonomy_251.csv --workers 4
```

**Advanced — manual phases** (what `load-parallel` orchestrates; rarely needed by hand):
```bash
npx tsx pipeline/load.ts <csv> --taxonomy <nucc.csv> --prepare      # DDL + taxonomy only
npx tsx pipeline/load.ts <csv> --shard 0/4                          # COPY rows where rowIndex % 4 == 0
npx tsx pipeline/load.ts <csv> --finalize                           # PK + indexes + ANALYZE + verify
```
Any explicit mode flag disables the implicit "do everything" run.

## Verify

`--finalize` prints the checks automatically. To re-run by hand:
```bash
docker exec postgres psql -U postgres -d npiradar -c "
  SELECT count(*) AS total,
         count(*) FILTER (WHERE deactivation_date IS NULL) AS active,
         (SELECT count(*) FROM taxonomy) AS taxonomy_codes
  FROM providers;"
```
Reference numbers (May 2026 load): 9,551,447 total · 9,189,862 active · 883 taxonomy codes.

---

## Monthly refresh

**One command** does the load + cache-bust:
```bash
pipeline/refresh.sh pipeline/data/monthly/npidata_pfile_*.csv pipeline/data/nucc_taxonomy_251.csv
```
It runs `load.ts` (which rebuilds providers + taxonomy + the facet MVs via `facets.sql`) then
`docker compose up -d --force-recreate npiradar` so the new data goes live. Full steps:

1. Download the new monthly `_V2` file (Step 1) + refresh the NUCC taxonomy if a newer version is out.
2. `parse.ts` spot-check (Step 2) — catch any NPPES schema change.
3. Run `pipeline/refresh.sh …` (or `load.ts` then the recreate by hand). A full load **drops and recreates** the
   tables (CASCADE drops the dependent MVs; `--finalize` rebuilds them), so it's an authoritative replace.
4. Bump the data-vintage string: `lib/format.ts → DATA_VINTAGE` (footer + freshness signal), then redeploy
   (`docker compose up -d --build`) so the new string ships.

> ### Why `--force-recreate`, not `restart`
> Provider/facet pages use ISR `revalidate = 30d`; that render cache lives in the container's writable layer at
> `.next/cache`. `docker restart` **reuses** that layer, so stale pages would persist up to 30 days — a plain
> restart is *not* enough. `up -d --force-recreate` starts a fresh container with an empty `.next/cache`, so every
> page re-renders against the new data on first hit. (In-memory caches — home count, sitemap index — clear on any
> restart.) `refresh.sh` does the recreate for you.
>
> Still not wired up: weekly incrementals + the deactivation file (monthly full replace is the only path), and a
> CDN purge (none needed while there's no CDN — see `SEO.md` on why Cloudflare is deferred).

## Troubleshooting

- **`expected column not found: "…"`** — NPPES changed the header. Update the name in `provider.ts → buildColIndex`.
- **`COPY` is slow / instance feels loaded** — you're competing with the live sites. Run single-process (default),
  off-peak; `synchronous_commit=off` + UNLOGGED already minimize the footprint.
- **EACCES on `.next/cache` (app, not pipeline)** — the standalone runner must own `.next/cache`; handled in the
  Dockerfile (`mkdir -p .next/cache && chown nextjs`). See [[th3-sh0p-snapshot-serving-gotcha]].
</content>
