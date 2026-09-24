import Redis from "ioredis";

// Shared Redis (the `redis` container on the infra `db` network — same network the app reaches
// `postgres` on). Used only by the API rate limiter today. One client reused across Next hot-reloads,
// mirroring lib/db.ts's pool handling, so dev module reloads don't leak connections.
const g = globalThis as unknown as { _npiRedis?: Redis };

const url = process.env.REDIS_URL ?? "redis://redis:6379";

export const redis =
  g._npiRedis ??
  new Redis(url, {
    // Keep a request from hanging on a Redis blip: fail fast and let the limiter fall back to open.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500,
    lazyConnect: false,
    // Redis outages are handled at the call site (rateLimit fails open); don't spam logs on retry.
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
  });

// ioredis emits 'error' on connection loss; without a listener Node treats it as an unhandled
// exception and crashes the server. Swallow — the limiter already degrades gracefully.
redis.on("error", () => {});

if (process.env.NODE_ENV !== "production") g._npiRedis = redis;
