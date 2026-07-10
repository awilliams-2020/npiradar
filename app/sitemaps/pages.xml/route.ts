import { urlsetXml, xmlResponse, type SitemapUrl } from "@/lib/sitemap";

// Static/hand-maintained URLs (home, and later the tools pages). No DB → safe to prerender.
// /search is intentionally omitted (UX entry, not an indexable page).
export const dynamic = "force-static";

export function GET() {
  const urls: SitemapUrl[] = [
    { loc: "/" },
    { loc: "/tools/npi-validator" },
    { loc: "/tools/bulk-lookup" },
  ];
  return xmlResponse(urlsetXml(urls));
}
