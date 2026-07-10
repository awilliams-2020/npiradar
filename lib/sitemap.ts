// Sitemap XML helpers. Served from route handlers (not public/) because the Next standalone server
// memoizes public/ at startup — anything DB-driven must be a live route. See SEO.md §3.

export const SITE_URL = "https://npiradar.com";
export const URLS_PER_SITEMAP = 50_000; // Google's per-file URL cap

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface SitemapUrl {
  loc: string; // site-absolute path, e.g. "/npi/123"; SITE_URL is prefixed here
  lastmod?: string | null;
}

export function urlsetXml(urls: SitemapUrl[]): string {
  const body = urls
    .map(
      (u) =>
        `<url><loc>${xmlEscape(SITE_URL + u.loc)}</loc>` +
        (u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : "") +
        `</url>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

export function sitemapIndexXml(children: { loc: string; lastmod?: string }[]): string {
  const body = children
    .map(
      (c) =>
        `<sitemap><loc>${xmlEscape(SITE_URL + c.loc)}</loc>` +
        (c.lastmod ? `<lastmod>${c.lastmod}</lastmod>` : "") +
        `</sitemap>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>`;
}

const SITEMAP_CACHE = "public, max-age=3600, s-maxage=86400";

/** "YYYY-MM-DD" → RFC-1123 date for Last-Modified (the data version is a calendar day, midnight UTC). */
function httpDate(lastmod: string): string {
  return new Date(lastmod + "T00:00:00Z").toUTCString();
}

/**
 * True when the client's cached copy is still current, so a route can answer 304 and skip the DB.
 * Sitemap contents only change with the monthly NPPES load (see `dataVersion`), so between loads every
 * conditional re-crawl becomes a free 304 instead of a full XML re-download — which is where Googlebot
 * had been spending the bulk of its crawl budget (GSC: ~79% "other file type", ~84% "refresh").
 */
export function notModified(req: Request, lastmod: string): boolean {
  const ims = req.headers.get("if-modified-since");
  if (!ims) return false;
  const since = Date.parse(ims);
  const mod = Date.parse(lastmod + "T00:00:00Z");
  return Number.isFinite(since) && Number.isFinite(mod) && since >= mod;
}

/** 304 Not Modified, carrying the same validators a 200 would. */
export function notModifiedResponse(lastmod: string): Response {
  return new Response(null, {
    status: 304,
    headers: { "Last-Modified": httpDate(lastmod), "Cache-Control": SITEMAP_CACHE },
  });
}

/** XML response with caching headers. When `lastmod` is given, adds a Last-Modified validator so the
 *  next crawl can be answered with a cheap 304 (see `notModified`). */
export function xmlResponse(xml: string, lastmod?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": SITEMAP_CACHE,
  };
  if (lastmod) headers["Last-Modified"] = httpDate(lastmod);
  return new Response(xml, { headers });
}
