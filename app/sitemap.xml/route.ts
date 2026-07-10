import { countIndexableMoneyPages, countDemandProviders, dataVersion } from "@/lib/facets";
import { sitemapIndexXml, xmlResponse, notModified, notModifiedResponse, URLS_PER_SITEMAP } from "@/lib/sitemap";

// Sitemap index. force-dynamic (never executed at build, where the DB is unreachable); a 1-day
// in-process cache keeps the count(*)s to once per instance per day. Children carry a lastmod and the
// response a Last-Modified validator, so Google re-fetches sitemaps only after the monthly data load.
export const dynamic = "force-dynamic";

let cached: { moneyPages: number; demandProviders: number; at: number } | null = null;
const DAY = 86_400_000;

async function pageCounts(): Promise<{ moneyPages: number; demandProviders: number }> {
  if (cached && Date.now() - cached.at < DAY) return cached;
  const money = await countIndexableMoneyPages();
  const demandProviders = await countDemandProviders();
  cached = {
    moneyPages: money > 0 ? Math.ceil(money / URLS_PER_SITEMAP) : 0,
    demandProviders,
    at: Date.now(),
  };
  return cached;
}

export async function GET(req: Request) {
  const lastmod = await dataVersion();
  if (notModified(req, lastmod)) return notModifiedResponse(lastmod);

  let counts = { moneyPages: 0, demandProviders: 0 };
  try {
    counts = await pageCounts();
  } catch {
    /* DB down → still emit a valid (smaller) index */
  }

  const children: { loc: string; lastmod?: string }[] = [
    { loc: "/sitemaps/pages.xml", lastmod },
    { loc: "/sitemaps/specialties.xml", lastmod },
    { loc: "/sitemaps/cities.xml", lastmod },
  ];
  for (let i = 0; i < counts.moneyPages; i++) children.push({ loc: `/sitemaps/specialty-cities/${i}.xml`, lastmod });
  // Demand-gated providers only — one file, listed when the demand set is non-empty. This replaces the
  // former 185 flat /sitemaps/providers/N.xml files (~9.25M thin /npi/ URLs) that starved the hubs'
  // crawl budget. Provider pages stay crawlable via hub links; the old providers/[file] route still
  // serves (unlisted) so any in-flight crawls of previously-submitted files don't hard-404.
  if (counts.demandProviders > 0) children.push({ loc: "/sitemaps/providers-demand.xml", lastmod });

  return xmlResponse(sitemapIndexXml(children), lastmod);
}
