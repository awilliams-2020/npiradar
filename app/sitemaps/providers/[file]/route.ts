import { query } from "@/lib/db";
import { dataVersion } from "@/lib/facets";
import { urlsetXml, xmlResponse, notModified, notModifiedResponse, URLS_PER_SITEMAP, type SitemapUrl } from "@/lib/sitemap";

// One child sitemap = up to 50k active providers. Page N's starting NPI is precomputed in
// mv_provider_sitemap_pages (pipeline/facets.sql); we keyset-scan from it, which is a pkey range scan
// and stays ~constant-time at any depth — unlike OFFSET N*50k, which is O(offset) and times out
// Googlebot on deep pages (page 183 ≈ 52s). Deactivated NPIs are excluded (they're noindex), exactly
// the rows that were left out when the page boundaries were computed.
export const dynamic = "force-dynamic";

interface Row {
  npi: string;
  lastmod: string | null;
}

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const m = /^(\d+)\.xml$/.exec(file);
  if (!m) return new Response("Not found", { status: 404 });
  const page = Number(m[1]);

  // Answer unchanged re-crawls with a 304 before touching the DB. The page set can only change when the
  // data version advances, so a 304 never masks a page that has since 404'd within the same version.
  const lastmod = await dataVersion();
  if (notModified(req, lastmod)) return notModifiedResponse(lastmod);

  let rows: Row[] = [];
  try {
    // Out-of-range page → the scalar subquery is NULL → `npi >= NULL` matches nothing → 404 below.
    rows = await query<Row>(
      `SELECT npi, to_char(last_update_date, 'YYYY-MM-DD') AS lastmod
         FROM providers
        WHERE deactivation_date IS NULL
          AND npi >= (SELECT start_npi FROM mv_provider_sitemap_pages WHERE page = $1)
        ORDER BY npi
        LIMIT $2`,
      [page, URLS_PER_SITEMAP],
    );
  } catch {
    return new Response("Service unavailable", { status: 503 });
  }

  if (rows.length === 0) return new Response("Not found", { status: 404 }); // past the last page
  const urls: SitemapUrl[] = rows.map((r) => ({ loc: `/npi/${r.npi}`, lastmod: r.lastmod }));
  return xmlResponse(urlsetXml(urls), lastmod);
}
