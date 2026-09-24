import { SITE_URL } from "@/lib/sitemap";
import { topSpecialties, topCities } from "@/lib/facets";
import { DATA_VINTAGE, titleCase } from "@/lib/format";
import { query } from "@/lib/db";

// /llms.txt — a curated map of the site for LLM crawlers and answer engines (the llms.txt
// convention: https://llmstxt.org). Served as a route handler, not a file in public/, because the
// standalone server memoizes public/ at boot (see SEO.md) — a static file written there would 404.
// force-dynamic so counts/facets reflect the live registry; a 1-day in-process cache keeps the
// queries cheap, and every branch degrades to valid static text if the DB is unreachable.
export const dynamic = "force-dynamic";

type Link = { label: string; href: string };
type Snapshot = { providers: string | null; specialties: Link[]; cities: Link[] };

let cache: { value: Snapshot; at: number } | null = null;
const DAY = 86_400_000;

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < DAY) return cache.value;
  const empty: Snapshot = { providers: null, specialties: [], cities: [] };
  try {
    const [countRows, specs, cities] = await Promise.all([
      query<{ providers: string }>(`SELECT count(*)::text AS providers FROM providers`),
      topSpecialties(12),
      topCities(12),
    ]);
    const value: Snapshot = {
      providers: countRows[0]?.providers ?? null,
      specialties: specs.map((s) => ({ label: s.name, href: `/specialty/${s.slug}` })),
      cities: cities.map((c) => ({
        label: `${titleCase(c.city_name)}, ${c.state}`,
        href: `/in/${c.state.toLowerCase()}/${c.city_slug}`,
      })),
    };
    // Never memoize a poisoned empty read (transient DB blip / reload swap); cache only real data.
    if (value.providers && Number(value.providers) > 0) cache = { value, at: Date.now() };
    return value;
  } catch {
    return empty;
  }
}

export async function GET() {
  const { providers, specialties, cities } = await snapshot();
  const count = providers ? Number(providers).toLocaleString("en-US") : "9.5 million";

  const lines: string[] = [
    "# NPIRadar",
    "",
    `> Free NPI lookup and provider directory over the public NPPES registry — the ${DATA_VINTAGE}. ` +
      `Search ${count} US healthcare providers by NPI number, name, specialty, or city, and see each ` +
      `provider's taxonomy, credentials, and practice location. NPIRadar is an independent directory; ` +
      `it is not affiliated with or endorsed by CMS.`,
    "",
    "The National Provider Identifier (NPI) is a unique 10-digit number CMS assigns to every US",
    "healthcare provider — individuals (a doctor, dentist, nurse) and organizations (a clinic,",
    "hospital, pharmacy) — through the National Plan & Provider Enumeration System (NPPES). It appears",
    "on insurance claims and prescriptions. All provider data here is public-domain NPPES data from CMS.",
    "",
    "## Key pages",
    `- [Home / NPI lookup](${SITE_URL}/): search by NPI number or provider name, and what an NPI is.`,
    `- [Search](${SITE_URL}/search?q=): look up a provider by name or 10-digit NPI number.`,
    `- [Providers by specialty](${SITE_URL}/specialty): browse the provider directory by medical specialty.`,
    `- [NPI validator](${SITE_URL}/tools/npi-validator): check a 10-digit NPI's Luhn check digit (runs in-browser).`,
    `- [Bulk NPI lookup](${SITE_URL}/tools/bulk-lookup): look up to 100 NPI numbers at once, with CSV export.`,
    `- [NPPES explained](${SITE_URL}/nppes): what the NPPES NPI Registry contains, how CMS publishes it, how to search it.`,
    `- [NPI API docs](${SITE_URL}/npi-api): the free JSON API — single, bulk (100/request), and search endpoints.`,
    "",
    "## API",
    `- [Provider lookup JSON](${SITE_URL}/api/npi/1275073215): \`GET ${SITE_URL}/api/npi/{npi}\` returns a ` +
      `single provider as JSON (name, entity type, specialty, taxonomy, license, practice location, ` +
      `enumeration/last-updated dates). Free, CORS-open, no key. Returns 400 for a non-10-digit NPI, ` +
      `404 if not found. Source dataset: NPPES.`,
    `- Bulk lookup: \`POST ${SITE_URL}/api/npi\` with \`{"npis": [...]}\` (up to 100) returns ` +
      `\`{results, notFound, invalid}\`.`,
    `- Provider search: \`GET ${SITE_URL}/api/search?name=&specialty=&state=&city=&limit=&page=\` ` +
      `(at least one of name/specialty/state; city requires state; limit ≤ 50; page is 0-based).`,
    `- Rate limit: 600 tokens/min per IP shared across endpoints (lookup 1, bulk 1 per NPI, search 10); ` +
      `\`X-RateLimit-*\` headers on every response, 429 + \`Retry-After\` past it. Full docs: ${SITE_URL}/npi-api`,
  ];

  if (specialties.length) {
    lines.push("", "## Popular specialties");
    for (const s of specialties) lines.push(`- [${s.label}](${SITE_URL}${s.href})`);
  }
  if (cities.length) {
    lines.push("", "## Providers by city");
    for (const c of cities) lines.push(`- [${c.label}](${SITE_URL}${c.href})`);
  }

  lines.push(
    "",
    "## Notes",
    "- Data source: NPPES (National Plan & Provider Enumeration System), a public-domain CMS dataset.",
    `- Data vintage: ${DATA_VINTAGE}. Refreshed on the monthly NPPES release.`,
    "- Geo facets use each provider's *practice* location (not the mailing address).",
    "- Deactivated NPIs stay reachable but are excluded from the search index.",
  );

  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
