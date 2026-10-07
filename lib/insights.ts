import { query } from "@/lib/db";

// Aggregates over the Open Payments (public.op_*) and OIG exclusion (public.oig_exclusions) tables, for the
// landing pages and the facet pages. Every function returns null when its tables aren't loaded yet (42P01),
// so a page renders without the section instead of failing.

const missing = (e: unknown) => (e as { code?: string }).code === "42P01";

async function orNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

// National stats scan ~1M rows; they only change when a dataset loads, so cache per instance for a day.
const DAY = 86_400_000;
const memo = new Map<string, { at: number; v: unknown }>();
async function daily<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.v as T;
  const v = await fn();
  if (v !== null) memo.set(key, { at: Date.now(), v });
  return v;
}

export interface RankedProvider { npi: string; name: string; specialty: string | null; city: string | null; state: string | null; total_usd: string }

const NAME_SQL = `COALESCE(p.org_name, concat_ws(' ', p.first_name, p.last_name))`;

// ── Open Payments, national ──────────────────────────────────────────────────────────────────────────

export interface OpNational {
  years: { program_year: number; total_usd: string; recipients: number; payments: number }[];
  latestYear: number;
  natures: { nature: string; total_usd: string }[];
  specialties: { specialty: string; slug: string | null; total_usd: string; recipients: number }[];
  topRecipients: RankedProvider[];
  topRecipientNatures: { nature: string; n: number }[]; // main payment type among topRecipients
}

export function opNational(): Promise<OpNational | null> {
  return daily("opNational", () => orNull(async () => {
    const years = await query<OpNational["years"][number]>(
      `SELECT program_year, sum(total_usd)::text AS total_usd, count(*)::int AS recipients, sum(payments)::int AS payments
         FROM public.op_npi_year GROUP BY program_year ORDER BY program_year DESC`);
    if (years.length === 0) return null;
    const y = years[0].program_year;
    const [natures, specialties, topRecipients, topRecipientNatures] = await Promise.all([
      query<OpNational["natures"][number]>(
        `SELECT nature, sum(total_usd)::text AS total_usd FROM public.op_npi_nature
          WHERE program_year = $1 GROUP BY nature ORDER BY sum(total_usd) DESC LIMIT 12`, [y]),
      query<OpNational["specialties"][number]>(
        `SELECT t.display_name AS specialty, t.slug, sum(o.total_usd)::text AS total_usd, count(*)::int AS recipients
           FROM public.op_npi_year o JOIN providers p ON p.npi = o.npi JOIN taxonomy t ON t.code = p.primary_taxonomy_code
          WHERE o.program_year = $1 GROUP BY t.display_name, t.slug ORDER BY sum(o.total_usd) DESC LIMIT 15`, [y]),
      query<RankedProvider>(
        `SELECT o.npi, ${NAME_SQL} AS name, t.display_name AS specialty, p.practice_city AS city,
                p.practice_state AS state, o.total_usd::text AS total_usd
           FROM public.op_npi_year o JOIN providers p ON p.npi = o.npi
           LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
          WHERE o.program_year = $1 ORDER BY o.total_usd DESC LIMIT 25`, [y]),
      query<{ nature: string; n: number }>(
        `WITH top AS (SELECT npi FROM public.op_npi_year WHERE program_year = $1 ORDER BY total_usd DESC LIMIT 25),
              main AS (SELECT DISTINCT ON (n.npi) n.npi, n.nature FROM public.op_npi_nature n JOIN top USING (npi)
                        WHERE n.program_year = $1 ORDER BY n.npi, n.total_usd DESC)
         SELECT nature, count(*)::int AS n FROM main GROUP BY nature ORDER BY n DESC`, [y]),
    ]);
    return { years, latestYear: y, natures, specialties, topRecipients, topRecipientNatures };
  }));
}

// ── OIG exclusions, national ─────────────────────────────────────────────────────────────────────────

export interface OigNational {
  npis: number;
  active: number;
  asOf: string | null;
  byType: { excl_type: string; n: number }[];
  recent: (RankedProvider & { excl_date: string | null; excl_type: string })[];
}

export function oigNational(): Promise<OigNational | null> {
  return daily("oigNational", () => orNull(async () => {
    const [counts, byType, recent] = await Promise.all([
      query<{ npis: number; active: number; as_of: string | null }>(
        `SELECT count(DISTINCT e.npi)::int AS npis,
                count(DISTINCT e.npi) FILTER (WHERE p.npi IS NOT NULL AND p.deactivation_date IS NULL)::int AS active,
                (SELECT to_char(max(loaded_at), 'YYYY-MM-DD') FROM public.dataset_loads WHERE dataset = 'leie') AS as_of
           FROM public.oig_exclusions e LEFT JOIN providers p ON p.npi = e.npi`),
      query<{ excl_type: string; n: number }>(
        `SELECT excl_type, count(DISTINCT npi)::int AS n FROM public.oig_exclusions GROUP BY excl_type ORDER BY n DESC`),
      query<OigNational["recent"][number]>(
        `SELECT e.npi, COALESCE(${NAME_SQL}, concat_ws(' ', e.first_name, e.last_name), e.business_name) AS name,
                t.display_name AS specialty, p.practice_city AS city, p.practice_state AS state, '0' AS total_usd,
                to_char(e.excl_date, 'YYYY-MM-DD') AS excl_date, e.excl_type
           FROM public.oig_exclusions e LEFT JOIN providers p ON p.npi = e.npi
           LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
          ORDER BY e.excl_date DESC NULLS LAST, e.npi LIMIT 15`),
    ]);
    return { npis: counts[0].npis, active: counts[0].active, asOf: counts[0].as_of, byType, recent };
  }));
}

// ── Per facet (city, or specialty × city) ────────────────────────────────────────────────────────────

export interface FacetInsights {
  year: number | null;
  paid: number; // providers in the facet with any general payment in `year`
  totalUsd: string;
  topRecipients: RankedProvider[];
  excluded: number; // active providers in the facet on the OIG list
}

/** Payments + exclusions for the active providers of one city (optionally one specialty in it). Uses
 *  the same filter as providersByCity / providersBySpecialtyCity, so it covers exactly the listed set. */
export function facetInsights(state: string, rawCities: string[], taxonomyCodes?: string[]): Promise<FacetInsights | null> {
  return orNull(async () => {
    const codeFilter = taxonomyCodes ? "AND p.primary_taxonomy_code = ANY($3)" : "";
    const params: unknown[] = taxonomyCodes ? [state, rawCities, taxonomyCodes] : [state, rawCities];
    const facet = `SELECT p.npi FROM providers p
      WHERE p.practice_state = $1 AND p.practice_city = ANY($2) ${codeFilter} AND p.deactivation_date IS NULL`;
    const yr = `(SELECT max(program_year) FROM public.op_npi_year)`;
    const [agg, top] = await Promise.all([
      query<{ year: number | null; paid: number; total_usd: string | null; excluded: number }>(
        `WITH f AS (${facet})
         SELECT ${yr} AS year,
                (SELECT count(*)::int FROM public.op_npi_year o JOIN f ON f.npi = o.npi WHERE o.program_year = ${yr}) AS paid,
                (SELECT sum(o.total_usd)::text FROM public.op_npi_year o JOIN f ON f.npi = o.npi WHERE o.program_year = ${yr}) AS total_usd,
                (SELECT count(DISTINCT e.npi)::int FROM public.oig_exclusions e JOIN f ON f.npi = e.npi) AS excluded`, params),
      query<RankedProvider>(
        `WITH f AS (${facet})
         SELECT o.npi, ${NAME_SQL} AS name, t.display_name AS specialty, p.practice_city AS city,
                p.practice_state AS state, o.total_usd::text AS total_usd
           FROM public.op_npi_year o JOIN f ON f.npi = o.npi JOIN providers p ON p.npi = o.npi
           LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
          WHERE o.program_year = ${yr} ORDER BY o.total_usd DESC LIMIT 5`, params),
    ]);
    const a = agg[0];
    return { year: a.year, paid: a.paid, totalUsd: a.total_usd ?? "0", topRecipients: top, excluded: a.excluded };
  });
}

export const usd = (s: string | number) =>
  Number(s).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
