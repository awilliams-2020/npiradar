-- pipeline/facets.sql — the facet layer on top of providers/taxonomy.
--
-- Adds: taxonomy slugs, the indexes that back facet listings + name search, and the three
-- materialized views that drive the specialty / city / specialty×city pages, their counts,
-- sibling links, and facet sitemaps.
--
-- Run by `pipeline/load.ts --finalize` after the bulk load, and re-runnable by hand:
--   docker exec -i postgres psql -U postgres -d npiradar < pipeline/facets.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and DROP+CREATE for the MVs.
-- Slug algorithm is mirrored exactly in lib/slug.ts — keep the two in lockstep.

\set ON_ERROR_STOP on

-- 1. Taxonomy slugs (883 rows). Slug derives from display_name; several codes can share a slug
--    (e.g. specialization variants) — that's intended: one specialty page aggregates them.
ALTER TABLE taxonomy ADD COLUMN IF NOT EXISTS slug text;
UPDATE taxonomy
   SET slug = trim(both '-' FROM regexp_replace(lower(coalesce(display_name, classification, code)), '[^a-z0-9]+', '-', 'g'));
CREATE INDEX IF NOT EXISTS idx_taxonomy_slug ON taxonomy (slug);

-- 1b. Canonical US geography whitelist (50 states + DC + 5 territories + 3 military). NPPES
--     practice_state also carries ~1,000 foreign / free-text values (ONTARIO, BAJA CALIFORNIA, …);
--     the geographic facets below are restricted to this set so we don't build foreign facet pages.
--     Providers with a foreign practice location still get their own /npi page — just no geo facet.
DROP TABLE IF EXISTS us_states;
CREATE TABLE us_states (code text PRIMARY KEY);
INSERT INTO us_states (code) VALUES
  ('AL'),('AK'),('AZ'),('AR'),('CA'),('CO'),('CT'),('DE'),('DC'),('FL'),('GA'),('HI'),('ID'),('IL'),
  ('IN'),('IA'),('KS'),('KY'),('LA'),('ME'),('MD'),('MA'),('MI'),('MN'),('MS'),('MO'),('MT'),('NE'),
  ('NV'),('NH'),('NJ'),('NM'),('NY'),('NC'),('ND'),('OH'),('OK'),('OR'),('PA'),('RI'),('SC'),('SD'),
  ('TN'),('TX'),('UT'),('VT'),('VA'),('WA'),('WV'),('WI'),('WY'),
  ('PR'),('VI'),('GU'),('AS'),('MP'),('AA'),('AE'),('AP');

-- 2. Provider indexes for facet listings + name search. Partial (active rows only) to stay lean;
--    facet/search queries always include `deactivation_date IS NULL`, so the planner can use them.
SET maintenance_work_mem = '512MB';
CREATE INDEX IF NOT EXISTS idx_providers_state_city_tax
  ON providers (practice_state, practice_city, primary_taxonomy_code)
  WHERE deactivation_date IS NULL;
-- Name-ordered listings: city pages and specialty pages show providers ORDER BY last_name, org_name,
-- npi. Without an index in that order Postgres reads every provider in the facet and sorts (Houston:
-- 87k rows, ~770 ms); with it, a LATERAL per raw city / per code reads just one page (~5 ms).
CREATE INDEX IF NOT EXISTS idx_providers_city_name
  ON providers (practice_state, practice_city, last_name, org_name, npi)
  WHERE deactivation_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_providers_tax_name
  ON providers (primary_taxonomy_code, last_name, org_name, npi)
  WHERE deactivation_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_providers_lastname
  ON providers (last_name text_pattern_ops)
  WHERE deactivation_date IS NULL AND entity_type = 'individual';
CREATE INDEX IF NOT EXISTS idx_providers_orgname
  ON providers (org_name text_pattern_ops)
  WHERE deactivation_date IS NULL AND entity_type = 'org';

-- 3. Facet materialized views. UNIQUE index on each → REFRESH ... CONCURRENTLY on monthly reload.
DROP MATERIALIZED VIEW IF EXISTS mv_specialty_city_counts;
DROP MATERIALIZED VIEW IF EXISTS mv_city_counts;
DROP MATERIALIZED VIEW IF EXISTS mv_specialty_counts;

-- one row per specialty slug: provider count + a display name. Drives /specialty index + page headings.
CREATE MATERIALIZED VIEW mv_specialty_counts AS
  SELECT t.slug,
         max(t.display_name) AS display_name,
         max(t.grouping)     AS grouping,
         count(*)            AS n
    FROM providers p JOIN taxonomy t ON t.code = p.primary_taxonomy_code
   WHERE p.deactivation_date IS NULL
   GROUP BY t.slug;
CREATE UNIQUE INDEX ON mv_specialty_counts (slug);

-- one row per (state, city slug): the raw city spellings (to filter providers by the composite
-- index), a representative display name, and the active count. Drives /in/[state]/[city].
CREATE MATERIALIZED VIEW mv_city_counts AS
  SELECT practice_state AS state,
         trim(both '-' FROM regexp_replace(lower(practice_city), '[^a-z0-9]+', '-', 'g')) AS city_slug,
         mode() WITHIN GROUP (ORDER BY practice_city) AS city_name,
         array_agg(DISTINCT practice_city)           AS raw_cities,
         count(*)                                    AS n
    FROM providers
   WHERE deactivation_date IS NULL AND practice_city IS NOT NULL
     AND practice_state IN (SELECT code FROM us_states)
   GROUP BY state, city_slug;
CREATE UNIQUE INDEX ON mv_city_counts (state, city_slug);

-- one row per (state, city slug, specialty slug): the money-page driver (~1.08M rows).
CREATE MATERIALIZED VIEW mv_specialty_city_counts AS
  SELECT p.practice_state AS state,
         trim(both '-' FROM regexp_replace(lower(p.practice_city), '[^a-z0-9]+', '-', 'g')) AS city_slug,
         t.slug              AS specialty_slug,
         mode() WITHIN GROUP (ORDER BY p.practice_city) AS city_name,
         max(t.display_name) AS specialty_name,
         count(*)            AS n
    FROM providers p JOIN taxonomy t ON t.code = p.primary_taxonomy_code
   WHERE p.deactivation_date IS NULL AND p.practice_city IS NOT NULL
     AND p.practice_state IN (SELECT code FROM us_states)
   GROUP BY state, city_slug, t.slug;
CREATE UNIQUE INDEX ON mv_specialty_city_counts (state, city_slug, specialty_slug);
CREATE INDEX ON mv_specialty_city_counts (specialty_slug);       -- "this specialty in other cities"
CREATE INDEX ON mv_specialty_city_counts (state, city_slug);     -- "other specialties in this city"

-- 4. Provider sitemap page boundaries. The provider sitemaps paginate the ~9.2M active /npi pages
--    into 50k-URL files. OFFSET pagination is O(offset) — tens of seconds at depth (page 183 ≈ 52s),
--    which times out Googlebot. Instead we precompute each file's starting NPI once here; the route
--    keyset-scans from it (`WHERE npi >= start_npi ORDER BY npi LIMIT 50000`), a pkey range scan that
--    is fast at any depth. One row per file (page 0..N-1); count(*) of this MV = the number of provider
--    sitemaps, which app/sitemap.xml reads so the index and the children can't drift apart.
--    50000 MUST match URLS_PER_SITEMAP in lib/sitemap.ts. Deactivated NPIs are excluded (noindex),
--    exactly the rows the keyset scan then skips.
DROP MATERIALIZED VIEW IF EXISTS mv_provider_sitemap_pages;
CREATE MATERIALIZED VIEW mv_provider_sitemap_pages AS
  WITH ranked AS (
    SELECT npi, (row_number() OVER (ORDER BY npi) - 1) / 50000 AS page
      FROM providers
     WHERE deactivation_date IS NULL
  )
  SELECT page, min(npi) AS start_npi, count(*) AS n
    FROM ranked
   GROUP BY page;
CREATE UNIQUE INDEX ON mv_provider_sitemap_pages (page);

-- 4b. Whole-table totals, read by the home page, llms.txt and the sitemap's data-version stamp. Each was a
--     count(*) / max() over ~9.8M rows (~0.5 s) run on the first request after every restart.
DROP MATERIALIZED VIEW IF EXISTS mv_provider_totals;
CREATE MATERIALIZED VIEW mv_provider_totals AS
  SELECT count(*) AS providers,
         count(*) FILTER (WHERE deactivation_date IS NULL) AS active,
         max(last_update_date) AS last_update
    FROM providers;

-- 5. Payments + exclusions per city and per specialty×city (the "Industry payments and exclusions"
--    block). Computed live it joined every provider in the facet to op_npi_year on each request:
--    ~1-1.5 s for a large city. Precomputed here (~20 s, ~100 MB) and read as one row. specialty_slug
--    '' = the whole city. Only facets with a paid or excluded provider have a row; no row = zero.
--    Rebuilt with each NPPES load (here) and REFRESHed by openpayments.ts / leie.ts after their loads
--    (pipeline/lib/insights.ts). Skipped if those tables don't exist yet (fresh database); the pages
--    then omit the block.
DROP MATERIALIZED VIEW IF EXISTS mv_facet_insights;
DO $do$
BEGIN
  IF to_regclass('public.op_npi_year') IS NULL OR to_regclass('public.oig_exclusions') IS NULL THEN
    RAISE NOTICE 'mv_facet_insights skipped: Open Payments / OIG tables not loaded yet';
    RETURN;
  END IF;
  EXECUTE $mv$
CREATE MATERIALIZED VIEW mv_facet_insights AS
WITH yr AS (SELECT max(program_year) AS y FROM public.op_npi_year),
k AS (SELECT npi FROM public.op_npi_year WHERE program_year = (SELECT y FROM yr)
      UNION SELECT npi FROM public.oig_exclusions),
pv AS (
  SELECT p.npi, p.practice_state AS state,
         trim(both '-' FROM regexp_replace(lower(p.practice_city), '[^a-z0-9]+', '-', 'g')) AS city_slug,
         t.slug AS specialty_slug, t.display_name AS specialty,
         COALESCE(p.org_name, concat_ws(' ', p.first_name, p.last_name)) AS name,
         o.total_usd,
         EXISTS (SELECT 1 FROM public.oig_exclusions e WHERE e.npi = p.npi) AS excluded
    FROM k JOIN providers p ON p.npi = k.npi
    LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
    LEFT JOIN public.op_npi_year o ON o.npi = p.npi AND o.program_year = (SELECT y FROM yr)
   WHERE p.deactivation_date IS NULL AND p.practice_city IS NOT NULL
     AND p.practice_state IN (SELECT code FROM us_states)),
lv AS (  -- each provider counts once at city level ('') and once under its specialty
  SELECT *, '' AS facet FROM pv
  UNION ALL SELECT *, specialty_slug FROM pv WHERE specialty_slug IS NOT NULL),
ranked AS (
  SELECT *, row_number() OVER (PARTITION BY state, city_slug, facet ORDER BY total_usd DESC NULLS LAST, npi) AS rk FROM lv)
SELECT state, city_slug, facet AS specialty_slug, (SELECT y FROM yr) AS year,
       count(total_usd)::int AS paid,
       coalesce(sum(total_usd), 0)::numeric(16,2) AS total_usd,
       count(*) FILTER (WHERE excluded)::int AS excluded,
       coalesce(jsonb_agg(jsonb_build_object('npi', npi, 'name', name, 'specialty', specialty, 'total_usd', total_usd::text)
                          ORDER BY rk) FILTER (WHERE rk <= 5 AND total_usd IS NOT NULL), '[]') AS top
  FROM ranked GROUP BY state, city_slug, facet$mv$;
  EXECUTE 'CREATE UNIQUE INDEX ON mv_facet_insights (state, city_slug, specialty_slug)';
END
$do$;

ANALYZE taxonomy;
ANALYZE mv_specialty_counts;
ANALYZE mv_city_counts;
ANALYZE mv_specialty_city_counts;
ANALYZE mv_provider_sitemap_pages;
