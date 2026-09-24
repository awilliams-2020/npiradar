import { rateLimit, clientIp, rateHeaders, type RateResult } from "@/lib/ratelimit";

// Shared preamble for the public JSON API (single lookup, bulk, search) so CORS + rate limiting are
// identical everywhere and can't drift between routes.

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export type Guard =
  | { limited: Response } // 429 already-built; return it as-is
  | { headers: Record<string, string> }; // allowed; merge these (CORS + X-RateLimit-*) into your Response

// Charge `cost` tokens against the caller's IP budget. On the allow path returns headers to spread into
// the route's own Response; on the deny path returns a ready-made 429 so callers just `return g.limited`.
export async function guard(req: Request, cost: number): Promise<Guard> {
  const r: RateResult = await rateLimit(clientIp(req), cost);
  const headers = { ...CORS, ...rateHeaders(r) };
  if (!r.ok) {
    return {
      limited: Response.json(
        { error: "rate_limited", message: "Too many requests. Slow down and retry after the window resets.", retryAfter: r.reset },
        { status: 429, headers },
      ),
    };
  }
  return { headers };
}
