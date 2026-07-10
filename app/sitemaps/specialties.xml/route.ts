import { sitemapSpecialties, dataVersion } from "@/lib/facets";
import { urlsetXml, xmlResponse, notModified, notModifiedResponse, type SitemapUrl } from "@/lib/sitemap";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const lastmod = await dataVersion();
  if (notModified(req, lastmod)) return notModifiedResponse(lastmod);

  let urls: SitemapUrl[] = [{ loc: "/specialty" }];
  try {
    const slugs = await sitemapSpecialties();
    urls = urls.concat(slugs.map((s) => ({ loc: `/specialty/${s}` })));
  } catch {
    return new Response("Service unavailable", { status: 503 });
  }
  return xmlResponse(urlsetXml(urls), lastmod);
}
