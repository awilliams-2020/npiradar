import { sitemapDemandProviders, dataVersion } from "@/lib/facets";
import { urlsetXml, xmlResponse, notModified, notModifiedResponse, URLS_PER_SITEMAP, type SitemapUrl } from "@/lib/sitemap";

// Demand-gated provider sitemap: only /npi/ pages with real search demand (public.provider_sitemap_demand,
// seeded from GSC impressions). A single file — the demand set is a few hundred URLs, far under the 50k
// cap. Replaces the former 9.25M-URL flat provider sitemap that starved crawl budget for the money-page
// hubs. If the demand set ever exceeds 50k, add a [file] paginated variant like the other feeds.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const lastmod = await dataVersion();
  if (notModified(req, lastmod)) return notModifiedResponse(lastmod);

  let rows: { npi: string; lastmod: string | null }[];
  try {
    rows = await sitemapDemandProviders(URLS_PER_SITEMAP, 0);
  } catch {
    return new Response("Service unavailable", { status: 503 });
  }

  const urls: SitemapUrl[] = rows.map((r) => ({ loc: `/npi/${r.npi}`, lastmod: r.lastmod }));
  return xmlResponse(urlsetXml(urls), lastmod);
}
