import { Pool } from "pg";

// Same shared Postgres the pipeline loads into. Host-run dev uses the published port 5433;
// the containerized app (Phase 1 compose) sets DATABASE_URL to ...@postgres:5432/npiradar.
const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/npiradar";

// Reuse one Pool across dev hot-reloads (Next reloads modules; a fresh Pool each time leaks connections).
const g = globalThis as unknown as { _npiPool?: Pool };
// Resolve the `live` schema first, then `public`. The zero-downtime monthly refresh builds into a
// `staging` schema and atomically renames it to `live`; pinning search_path here means freshly-opened
// pool connections pick up the swap. Before the first swap `live` doesn't exist, so this transparently
// falls back to `public` (where the data currently lives) — a no-op today.
export const pool =
  g._npiPool ?? new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, options: "-c search_path=live,public" });
if (process.env.NODE_ENV !== "production") g._npiPool = pool;

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
