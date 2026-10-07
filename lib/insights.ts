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

// National stats scan ~1M rows (opNational ~7 s, oigNational ~0.3 s) and change only when a dataset loads,
// so they're cached per instance for a day, stale-while-revalidate: once a value exists no request waits
// on the scan again; an expired one is served while one background recompute replaces it. Concurrent
// first requests share one computation. instrumentation.ts warms both at startup (warmInsights), so the
// first visitor after a deploy or restart doesn't pay the 7 s either.
const DAY = 86_400_000;
// On globalThis, not module scope: Next bundles instrumentation.ts separately from the pages, so each gets
// its own copy of this module, and a module-level Map warmed at startup would never be seen by a page.
const g = globalThis as unknown as { _npiInsights?: { memo: Map<string, { at: number; v: unknown }>; inflight: Map<string, Promise<unknown>> } };
const { memo, inflight } = (g._npiInsights ??= { memo: new Map(), inflight: new Map() });
function compute<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((v) => { if (v !== null) memo.set(key, { at: Date.now(), v }); return v; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function daily<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (!hit) return compute(key, fn);
  if (Date.now() - hit.at >= DAY) {
    compute(key, fn).catch((e) => console.error(`insights: refresh of ${key} failed:`, e)); // keep serving the old value
  }
  return hit.v as T;
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

/** Payments + exclusions for the active providers of one city, or one specialty in it. Read from
 *  mv_facet_insights (pipeline/facets.sql §5), which is precomputed per facet: computing it live joined
 *  every provider in the facet to op_npi_year (~1-1.5 s for a large city). A facet with no row has no
 *  paid or excluded provider; the year comes from any row. Null if the view isn't built yet. */
export function facetInsights(state: string, citySlug: string, specialtySlug = ""): Promise<FacetInsights | null> {
  return orNull(async () => {
    const r = await query<{ year: number | null; paid: number | null; total_usd: string | null; excluded: number | null; top: RankedProvider[] | null }>(
      `SELECT y.year, f.paid, f.total_usd::text AS total_usd, f.excluded, f.top
         FROM (SELECT year FROM mv_facet_insights LIMIT 1) y
         LEFT JOIN mv_facet_insights f ON f.state = $1 AND f.city_slug = $2 AND f.specialty_slug = $3`,
      [state, citySlug, specialtySlug]);
    if (r.length === 0) return null; // view empty: nothing loaded
    const a = r[0];
    // The view's top list carries no city/state (the page already names the place).
    const top = (a.top ?? []).map((t) => ({ ...t, city: null, state }));
    return { year: a.year, paid: a.paid ?? 0, totalUsd: a.total_usd ?? "0", topRecipients: top, excluded: a.excluded ?? 0 };
  });
}

export const usd = (s: string | number) =>
  Number(s).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Fills the national caches. Called once at server start by instrumentation.ts. */
export async function warmInsights(): Promise<void> {
  const t = Date.now();
  await Promise.all([opNational(), oigNational()]);
  console.log(`insights: warmed national stats in ${Date.now() - t} ms`);
}
