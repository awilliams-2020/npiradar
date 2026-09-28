import { pool } from "@/lib/db";

// Durable per-day usage counters for the public JSON API, so "is anyone using it?" has an answer
// months from now. Traefik's access log only keeps ~3 days and the app's stdout is lost on the monthly
// --force-recreate, so neither can. Lives in `public`, beside refresh_runs, because the monthly refresh
// swaps `live`/`staging` and would take the table with it.
//
// One row per (day, endpoint, source, caller) — a rollup, not a request log, so it stays small:
//   endpoint  lookup (GET /api/npi/{npi}) | bulk (POST /api/npi) | search (GET /api/search)
//   source    site = our own /tools/bulk-lookup (Origin/Referer is npiradar.com); external = anyone else
//   caller    client IP with the last block zeroed (IPv4 /24, IPv6 /48) — the same granularity Matomo
//             keeps. Not hashed: a hash of an IPv4 address is reversible by brute force, so it would
//             hide nothing, and a /24 can be whois'd to see WHO is integrating.
// Query recipes: README.md → "API usage".

const DDL = `
CREATE TABLE IF NOT EXISTS public.api_usage (
  day       date    NOT NULL,
  endpoint  text    NOT NULL,
  source    text    NOT NULL,
  caller    text    NOT NULL,
  requests  integer NOT NULL DEFAULT 0,
  units     integer NOT NULL DEFAULT 0,
  limited   integer NOT NULL DEFAULT 0,
  last_ua   text,
  PRIMARY KEY (day, endpoint, source, caller)
)`;

let ready: Promise<unknown> | undefined;

function endpointOf(req: Request): string {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/api/search")) return "search";
  if (path === "/api/npi" || path === "/api/npi/") return "bulk";
  if (path.startsWith("/api/npi/")) return "lookup";
  return path;
}

function maskIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/i, "").match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (v4) return `${v4[1]}.0`;
  if (ip.includes(":")) {
    // Expand "::" so a compressed address ("2001:db8::1") still yields its first three groups.
    const [head, tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return groups.slice(0, 3).join(":") + "::";
  }
  return ip; // "unknown" or anything unparseable
}

function sourceOf(req: Request): string {
  const from = req.headers.get("origin") || req.headers.get("referer") || "";
  return /^https?:\/\/(www\.)?npiradar\.com(\/|$)/i.test(from) ? "site" : "external";
}

// Fire-and-forget: never awaited by the request path, and every failure is swallowed — usage stats
// must not add latency to, or break, a free public API.
export function recordUsage(req: Request, ip: string, units: number, limited: boolean): void {
  const caller = maskIp(ip);
  const ua = (req.headers.get("user-agent") || "").slice(0, 200);
  ready ??= pool.query(DDL).catch((e) => {
    ready = undefined; // retry the DDL on the next call
    throw e;
  });
  ready
    .then(() =>
      pool.query(
        `INSERT INTO public.api_usage AS u (day, endpoint, source, caller, requests, units, limited, last_ua)
         VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3, 1, $4, $5, $6)
         ON CONFLICT (day, endpoint, source, caller) DO UPDATE SET
           requests = u.requests + 1,
           units    = u.units + EXCLUDED.units,
           limited  = u.limited + EXCLUDED.limited,
           last_ua  = EXCLUDED.last_ua`,
        [endpointOf(req), sourceOf(req), caller, limited ? 0 : units, limited ? 1 : 0, ua],
      ),
    )
    .catch(() => {});
}
