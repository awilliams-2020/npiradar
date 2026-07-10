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
| CDN / cache | **Cloudflare** in front | Caches rendered HTML by URL → 8M pages served cheaply on first crawl |
| Deploy | Traefik + docker-compose | Per `~/projects/<name>` (compose+env) / `~/npiradar` (source+Dockerfile) convention |

Alternative considered: **Astro** (great for content at scale) — viable, but Next reuses existing infra + experience. See `ARCHITECTURE.md`.

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
