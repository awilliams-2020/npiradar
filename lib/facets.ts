import { query } from "@/lib/db";

// Query layer for the facet pages (specialty / city / specialty×city), their sibling links, and the
// facet sitemaps. Reads the materialized views from pipeline/facets.sql + the providers indexes.

export const PAGE_SIZE = 50; // providers listed per facet page
export const INDEXABLE_MIN = 5; // a specialty×city page is indexed only at/above this provider count
export const MAX_INDEXED_PAGE = 10; // paginate beyond this → noindex (avoid deep-pagination index bloat)

// Data version = the latest NPPES "last update" date. It only advances with the monthly load, so it
// doubles as a sitemap Last-Modified / lastmod stamp. Cached per-instance for a day so the one uncached
// max() over ~9M rows runs at most once per instance per day (sitemap conditional requests are cheap).
let dataVersionCache: { date: string; at: number } | null = null;
export async function dataVersion(): Promise<string> {
  const DAY = 86_400_000;
  if (dataVersionCache && Date.now() - dataVersionCache.at < DAY) return dataVersionCache.date;
  let date = new Date().toISOString().slice(0, 10); // fail-open: today's date → re-crawl, never serve stale
  try {
    const rows = await query<{ c: string | null }>(
      `SELECT to_char(max(last_update_date), 'YYYY-MM-DD') AS c FROM providers`,
    );
    if (rows[0]?.c) date = rows[0].c;
  } catch {
    /* DB down → keep today's date; the routes themselves return 503 in that case anyway */
  }
  dataVersionCache = { date, at: Date.now() };
  return date;
}

export interface ProviderListItem {
  npi: string;
  entity_type: "individual" | "org" | null;
  org_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  credential: string | null;
  practice_city: string | null;
  practice_state: string | null;
  specialty: string | null;
}

const LIST_COLS = `p.npi, p.entity_type, p.org_name, p.first_name, p.middle_name, p.last_name,
  p.credential, p.practice_city, p.practice_state, t.display_name AS specialty`;
const LIST_ORDER = `ORDER BY p.last_name NULLS LAST, p.org_name NULLS LAST, p.npi`;

// ---- specialty ---------------------------------------------------------------
export interface Specialty { slug: string; display_name: string; grouping: string | null; n: number }

export async function getSpecialty(slug: string): Promise<Specialty | null> {
  const r = await query<{ slug: string; display_name: string; grouping: string | null; n: string }>(
    `SELECT slug, display_name, grouping, n::text AS n FROM mv_specialty_counts WHERE slug = $1`,
    [slug],
  );
  return r[0] ? { ...r[0], n: Number(r[0].n) } : null;
}

async function specialtyCodes(slug: string): Promise<string[]> {
  const r = await query<{ code: string }>(`SELECT code FROM taxonomy WHERE slug = $1`, [slug]);
  return r.map((x) => x.code);
}

export async function providersBySpecialty(slug: string, limit: number, offset: number): Promise<ProviderListItem[]> {
  const codes = await specialtyCodes(slug);
  if (codes.length === 0) return [];
  return query<ProviderListItem>(
    `SELECT ${LIST_COLS} FROM providers p LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.primary_taxonomy_code = ANY($1) AND p.deactivation_date IS NULL
      ${LIST_ORDER} LIMIT $2 OFFSET $3`,
    [codes, limit, offset],
  );
}

// ---- city --------------------------------------------------------------------
export interface City { state: string; city_slug: string; city_name: string; raw_cities: string[]; n: number }

export async function getCity(state: string, citySlug: string): Promise<City | null> {
  const r = await query<{ state: string; city_slug: string; city_name: string; raw_cities: string[]; n: string }>(
    `SELECT state, city_slug, city_name, raw_cities, n::text AS n
       FROM mv_city_counts WHERE state = $1 AND city_slug = $2`,
    [state, citySlug],
  );
  return r[0] ? { ...r[0], n: Number(r[0].n) } : null;
}

export async function providersByCity(state: string, rawCities: string[], limit: number, offset: number): Promise<ProviderListItem[]> {
  return query<ProviderListItem>(
    `SELECT ${LIST_COLS} FROM providers p LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.practice_state = $1 AND p.practice_city = ANY($2) AND p.deactivation_date IS NULL
      ${LIST_ORDER} LIMIT $3 OFFSET $4`,
    [state, rawCities, limit, offset],
  );
}

// ---- specialty × city (money page) -------------------------------------------
export interface SpecialtyCity { state: string; city_slug: string; specialty_slug: string; city_name: string; specialty_name: string; n: number }

export async function getSpecialtyCity(state: string, citySlug: string, specialtySlug: string): Promise<SpecialtyCity | null> {
  const r = await query<Omit<SpecialtyCity, "n"> & { n: string }>(
    `SELECT state, city_slug, specialty_slug, city_name, specialty_name, n::text AS n
       FROM mv_specialty_city_counts WHERE state = $1 AND city_slug = $2 AND specialty_slug = $3`,
    [state, citySlug, specialtySlug],
  );
  return r[0] ? { ...r[0], n: Number(r[0].n) } : null;
}

export async function providersBySpecialtyCity(
  state: string, rawCities: string[], specialtySlug: string, limit: number, offset: number,
): Promise<ProviderListItem[]> {
  const codes = await specialtyCodes(specialtySlug);
  if (codes.length === 0) return [];
  return query<ProviderListItem>(
    `SELECT ${LIST_COLS} FROM providers p LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.practice_state = $1 AND p.practice_city = ANY($2)
        AND p.primary_taxonomy_code = ANY($3) AND p.deactivation_date IS NULL
      ${LIST_ORDER} LIMIT $4 OFFSET $5`,
    [state, rawCities, codes, limit, offset],
  );
}

// ---- sibling / index links (crawl graph) -------------------------------------
export interface SlugCount { slug: string; name: string; n: number }
export interface CityRef { state: string; city_slug: string; city_name: string; n: number }

export async function topSpecialties(limit: number): Promise<SlugCount[]> {
  const r = await query<{ slug: string; name: string; n: string }>(
    `SELECT slug, display_name AS name, n::text AS n FROM mv_specialty_counts ORDER BY n DESC LIMIT $1`, [limit]);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}

export async function allSpecialties(): Promise<SlugCount[]> {
  const r = await query<{ slug: string; name: string; n: string }>(
    `SELECT slug, display_name AS name, n::text AS n FROM mv_specialty_counts ORDER BY display_name`);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}

export async function otherSpecialtiesInCity(state: string, citySlug: string, exclude: string, limit: number): Promise<SlugCount[]> {
  const r = await query<{ slug: string; name: string; n: string }>(
    `SELECT specialty_slug AS slug, specialty_name AS name, n::text AS n
       FROM mv_specialty_city_counts WHERE state = $1 AND city_slug = $2 AND specialty_slug <> $3
      ORDER BY n DESC LIMIT $4`, [state, citySlug, exclude, limit]);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}

export async function sameSpecialtyOtherCities(specialtySlug: string, exState: string, exCity: string, limit: number): Promise<CityRef[]> {
  const r = await query<{ state: string; city_slug: string; city_name: string; n: string }>(
    `SELECT state, city_slug, city_name, n::text AS n FROM mv_specialty_city_counts
      WHERE specialty_slug = $1 AND NOT (state = $2 AND city_slug = $3)
      ORDER BY n DESC LIMIT $4`, [specialtySlug, exState, exCity, limit]);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}

export async function topCitiesInState(state: string, exCity: string, limit: number): Promise<CityRef[]> {
  const r = await query<{ state: string; city_slug: string; city_name: string; n: string }>(
    `SELECT state, city_slug, city_name, n::text AS n FROM mv_city_counts
      WHERE state = $1 AND city_slug <> $2 ORDER BY n DESC LIMIT $3`, [state, exCity, limit]);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}

export async function topCities(limit: number): Promise<CityRef[]> {
  const r = await query<{ state: string; city_slug: string; city_name: string; n: string }>(
    `SELECT state, city_slug, city_name, n::text AS n FROM mv_city_counts ORDER BY n DESC LIMIT $1`, [limit]);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}

// ---- sitemap feeds -----------------------------------------------------------
export async function sitemapSpecialties(): Promise<string[]> {
  const r = await query<{ slug: string }>(`SELECT slug FROM mv_specialty_counts ORDER BY slug`);
  return r.map((x) => x.slug);
}

export async function sitemapStates(): Promise<string[]> {
  const r = await query<{ state: string }>(`SELECT DISTINCT state FROM mv_city_counts ORDER BY state`);
  return r.map((x) => x.state);
}

export async function sitemapCities(): Promise<{ state: string; city_slug: string }[]> {
  return query<{ state: string; city_slug: string }>(
    `SELECT state, city_slug FROM mv_city_counts ORDER BY state, city_slug`,
  );
}

/** Only specialty×city pages at/above the indexable threshold go in the sitemap (thin ones are noindex). */
export async function countIndexableMoneyPages(): Promise<number> {
  const r = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM mv_specialty_city_counts WHERE n >= $1`, [INDEXABLE_MIN]);
  return Number(r[0]?.c ?? 0);
}

export async function sitemapMoneyPages(limit: number, offset: number): Promise<{ state: string; city_slug: string; specialty_slug: string }[]> {
  return query<{ state: string; city_slug: string; specialty_slug: string }>(
    `SELECT state, city_slug, specialty_slug FROM mv_specialty_city_counts
      WHERE n >= $1 ORDER BY state, city_slug, specialty_slug LIMIT $2 OFFSET $3`,
    [INDEXABLE_MIN, limit, offset]);
}

// ---- demand-gated provider sitemap -------------------------------------------
// Only /npi/ pages with real search demand (>=1 GSC impression) are submitted, seeded into
// public.provider_sitemap_demand — in `public`, not `live`, so it survives the monthly staging→live
// swap. This replaces the former flat 9.25M-URL provider sitemap (185 files): on a low-authority domain
// Google's crawl budget was spread across millions of thin leaves and never reached the money-page hubs
// (GSC URL Inspection: nearly all URLs "unknown to Google"/never crawled). Provider pages remain live
// and crawlable via hub links — this governs only what we actively *submit*. Refresh the seed table from
// GSC periodically to admit newly-demanded providers.
export async function countDemandProviders(): Promise<number> {
  const r = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM provider_sitemap_demand d
       JOIN providers p ON p.npi = d.npi WHERE p.deactivation_date IS NULL`);
  return Number(r[0]?.c ?? 0);
}

export async function sitemapDemandProviders(limit: number, offset: number): Promise<{ npi: string; lastmod: string | null }[]> {
  return query<{ npi: string; lastmod: string | null }>(
    `SELECT d.npi, to_char(p.last_update_date, 'YYYY-MM-DD') AS lastmod
       FROM provider_sitemap_demand d
       JOIN providers p ON p.npi = d.npi
      WHERE p.deactivation_date IS NULL
      ORDER BY d.npi LIMIT $1 OFFSET $2`, [limit, offset]);
}

/** Name search: prefix match on last name (individuals) or org name (orgs). NPPES stores names in
 *  UPPER, so we uppercase the query; the partial text_pattern_ops indexes back the LIKE 'prefix%'.
 *  Whole-query prefix (so "smith" works; "john smith" matches an org/last-name starting that way). */
export async function searchProviders(q: string, limit: number): Promise<ProviderListItem[]> {
  const like = q.toUpperCase().replace(/[%_\\]/g, "\\$&") + "%";
  return query<ProviderListItem>(
    `SELECT ${LIST_COLS} FROM providers p LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.deactivation_date IS NULL AND (
              (p.entity_type = 'individual' AND p.last_name LIKE $1)
           OR (p.entity_type = 'org' AND p.org_name LIKE $1))
      ${LIST_ORDER} LIMIT $2`,
    [like, limit],
  );
}

/** Which specialties this provider's city offers — used to link a provider page into the money pages. */
export async function specialtiesForCity(state: string, citySlug: string, limit: number): Promise<SlugCount[]> {
  const r = await query<{ slug: string; name: string; n: string }>(
    `SELECT specialty_slug AS slug, specialty_name AS name, n::text AS n
       FROM mv_specialty_city_counts WHERE state = $1 AND city_slug = $2 ORDER BY n DESC LIMIT $3`,
    [state, citySlug, limit]);
  return r.map((x) => ({ ...x, n: Number(x.n) }));
}
