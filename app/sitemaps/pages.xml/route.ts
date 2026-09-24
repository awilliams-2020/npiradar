import { urlsetXml, xmlResponse, type SitemapUrl } from "@/lib/sitemap";

// Static/hand-maintained URLs (home, tools, and the NPPES + API explainers). No DB → safe to prerender.
// /search is intentionally omitted (UX entry, not an indexable page).
export const dynamic = "force-static";

export function GET() {
  const urls: SitemapUrl[] = [
    { loc: "/" },
    { loc: "/tools/npi-validator" },
    { loc: "/tools/bulk-lookup" },
    { loc: "/nppes" },
    { loc: "/npi-api" },
  ];
  return xmlResponse(urlsetXml(urls));
}
