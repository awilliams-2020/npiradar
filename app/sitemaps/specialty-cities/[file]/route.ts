import { sitemapMoneyPages, dataVersion } from "@/lib/facets";
import { cityStateSlug } from "@/lib/slug";
import { urlsetXml, xmlResponse, notModified, notModifiedResponse, URLS_PER_SITEMAP, type SitemapUrl } from "@/lib/sitemap";

// Specialty×city money pages above the indexable threshold (n >= INDEXABLE_MIN), paginated 50k/file.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = /^(\d+)\.xml$/.exec(file);
  if (!m) return new Response("Not found", { status: 404 });
  const page = Number(m[1]);

  const lastmod = await dataVersion();
  if (notModified(req, lastmod)) return notModifiedResponse(lastmod);

  let rows: { state: string; city_slug: string; specialty_slug: string }[];
  try {
    rows = await sitemapMoneyPages(URLS_PER_SITEMAP, page * URLS_PER_SITEMAP);
  } catch {
    return new Response("Service unavailable", { status: 503 });
  }

  if (rows.length === 0) return new Response("Not found", { status: 404 });
  const urls: SitemapUrl[] = rows.map((r) => ({
    loc: `/specialty/${r.specialty_slug}/${cityStateSlug(r.city_slug, r.state)}`,
  }));
  return xmlResponse(urlsetXml(urls), lastmod);
}
