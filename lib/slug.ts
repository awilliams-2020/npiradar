// URL slug helpers. The slugify() here MUST mirror the SQL slug expression in pipeline/facets.sql:
//   trim(both '-' from regexp_replace(lower(s), '[^a-z0-9]+', '-', 'g'))
// Slugs are matched against the slug columns the MVs were built with — if these drift, lookups miss.

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Money-page segment: "houston-tx" = `${citySlug}-${state}`. */
export function cityStateSlug(citySlug: string, state: string): string {
  return `${citySlug}-${state.toLowerCase()}`;
}

/** Parse "winston-salem-nc" → { citySlug: "winston-salem", state: "NC" }. State = trailing 2 letters. */
export function parseCityState(seg: string): { citySlug: string; state: string } | null {
  const m = /^(.+)-([a-z]{2})$/.exec(seg);
  if (!m || !m[1]) return null;
  return { citySlug: m[1], state: m[2].toUpperCase() };
}
