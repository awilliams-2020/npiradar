import { redis } from "@/lib/redis";

// First-class, cost-weighted rate limiting for the public API.
//
// One per-IP token budget per fixed window. Cost is charged per unit of work, not per request, so a
// 100-NPI bulk call spends 100× a single lookup and can't be used to dodge the limit by batching:
//   GET  /api/npi/{npi}   cost 1
//   POST /api/npi         cost = number of valid NPIs in the body (1..100)
//   GET  /api/search      cost 10  (a scan, heavier than a keyed lookup)
//
// Two layers by design: Traefik enforces a coarse 100/min/IP at the edge (a dumb backstop); this is
// the real, work-aware limiter and the one that emits X-RateLimit-* so clients can self-throttle.

const LIMIT = Number(process.env.API_RATE_LIMIT ?? 600); // tokens per window, per IP
const WINDOW = Number(process.env.API_RATE_WINDOW ?? 60); // seconds

// Atomic check-and-charge. Fixed window anchored at the first request in the window (INCRBY + EXPIRE
// on create). Returns {allowed, remaining, ttl} so headers are exact on both the allow and deny paths.
const LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
if cur + cost > limit then
  local ttl = redis.call('TTL', KEYS[1])
  return {0, limit - cur, ttl}
end
local n = redis.call('INCRBY', KEYS[1], cost)
if n == cost then redis.call('EXPIRE', KEYS[1], window) end
return {1, limit - n, redis.call('TTL', KEYS[1])}`;

export interface RateResult {
  ok: boolean;
  remaining: number;
  reset: number; // seconds until the window resets
  limit: number;
}

export async function rateLimit(ip: string, cost: number): Promise<RateResult> {
  const weight = Math.max(1, Math.floor(cost));
  try {
    const res = (await redis.eval(LUA, 1, `rl:api:${ip}`, LIMIT, WINDOW, weight)) as [number, number, number];
    const [ok, remaining, ttl] = res;
    return { ok: ok === 1, remaining: Math.max(0, remaining), reset: ttl > 0 ? ttl : WINDOW, limit: LIMIT };
  } catch {
    // Fail OPEN: a Redis outage must not 500 a free, public API. Traefik's edge limit is still active
    // as a backstop. Flip this to `ok: false` if starving abuse matters more than staying up.
    return { ok: true, remaining: LIMIT, reset: WINDOW, limit: LIMIT };
  }
}

// Real client IP behind Traefik. Traefik appends the peer to X-Forwarded-For; the first entry is the
// origin client. Falls back to a shared "unknown" bucket if the header is absent (direct hits).
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export function rateHeaders(r: RateResult): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(r.remaining),
    "X-RateLimit-Reset": String(r.reset),
  };
  if (!r.ok) h["Retry-After"] = String(r.reset);
  return h;
}
