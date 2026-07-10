import { sitemapStates, sitemapCities, dataVersion } from "@/lib/facets";
import { urlsetXml, xmlResponse, notModified, notModifiedResponse, type SitemapUrl } from "@/lib/sitemap";

// ~40k city pages + the ~56 state index pages. Comfortably under the 50k-per-file cap.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const lastmod = await dataVersion();
  if (notModified(req, lastmod)) return notModifiedResponse(lastmod);

  let urls: SitemapUrl[] = [];
  try {
    const [states, cities] = await Promise.all([sitemapStates(), sitemapCities()]);
    urls = states.map((s) => ({ loc: `/in/${s.toLowerCase()}` }));
    urls = urls.concat(cities.map((c) => ({ loc: `/in/${c.state.toLowerCase()}/${c.city_slug}` })));
  } catch {
    return new Response("Service unavailable", { status: 503 });
  }
  return xmlResponse(urlsetXml(urls), lastmod);
}
