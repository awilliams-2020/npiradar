/**
 * refresh-server.ts — the tiny HTTP service cron-job.org pings to trigger a monthly NPPES refresh.
 *
 * cron-job.org expects a response within ~30s, but a refresh takes ~20 min — so this NEVER does the
 * work synchronously. POST /internal/refresh validates the secret, dedupes (advisory via a
 * `running` row), short-circuits when CMS has nothing newer, then spawns refresh-run.sh DETACHED and
 * returns 202 immediately. GET /internal/status reports recent runs; /internal/healthz is unauthed.
 *
 * Routed by Traefik as Host(npiradar.com) && PathPrefix(/internal/). Env: PORT, REFRESH_SECRET,
 * DATABASE_URL (+ the vars refresh-run.sh needs, inherited by the spawned child).
 */
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.REFRESH_SECRET ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const SRC = fileURLToPath(new URL("..", import.meta.url)); // /app (mounted ~/npiradar)
const LOG_DIR = process.env.REFRESH_LOG_DIR ?? "/tmp";

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

// refresh_runs lives in `public` (never live/staging) so it survives the schema swap.
// Retries transient connect errors so a DB still booting (e.g. after a host reboot) doesn't
// crash us — Docker's restart policy would recover too, but this avoids the FATAL noise + gap.
async function ensureTable() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS public.refresh_runs (
        id bigserial PRIMARY KEY,
        state text NOT NULL,
        source_file text,
        message text,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`);
      return;
    } catch (e) {
      // 57P03 = "the database system is starting up"; ECONNREFUSED = not accepting yet.
      const transient = (e as { code?: string }).code === "57P03" || (e as { code?: string }).code === "ECONNREFUSED";
      if (!transient || attempt >= 30) throw e;
      console.warn(`db not ready (${(e as { code?: string }).code}), retry ${attempt}/30 in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// True only if the live `providers` table currently holds at least one row. Any error (schema/table
// missing before the first swap, DB unreachable) is treated as "not populated" so the caller errs
// toward reloading rather than refusing on a matching marker. search_path is pinned to "live, public"
// by the swap, so the unqualified name resolves to the live table.
async function liveHasProviders(): Promise<boolean> {
  try {
    const r = await pool.query(`SELECT 1 FROM providers LIMIT 1`);
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

const authed = (req: http.IncomingMessage) => !!SECRET && req.headers["authorization"] === `Bearer ${SECRET}`;

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Cheap probe (no download) for the newest CMS release marker, e.g. NPPES_..._May_2026_V2.zip.
function resolveLatestMarker(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bash", [path.join(SRC, "pipeline/fetch-monthly.sh"), "--resolve-only"], { timeout: 120_000 }, (err, stdout) => {
      if (err) return reject(err);
      const url = stdout.trim().split("\n").pop()?.trim() ?? "";
      url ? resolve(path.basename(url)) : reject(new Error("empty resolve"));
    });
  });
}

function spawnJob(runId: number): string {
  const logPath = path.join(LOG_DIR, `refresh-${runId}.log`);
  const out = fs.openSync(logPath, "a");
  const child = spawn("bash", [path.join(SRC, "pipeline/refresh-run.sh")], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, RUN_ID: String(runId) },
  });
  child.unref();
  return logPath;
}

async function handleRefresh(res: http.ServerResponse) {
  // One refresh at a time. A `running` row older than 3h is treated as a crashed run and ignored.
  const running = await pool.query(
    `SELECT id FROM public.refresh_runs WHERE state='running' AND started_at > now() - interval '3 hours' LIMIT 1`,
  );
  if (running.rowCount) return json(res, 409, { status: "already_running", runId: running.rows[0].id });

  let marker = "";
  try {
    marker = await resolveLatestMarker();
  } catch (e) {
    return json(res, 502, { status: "resolve_failed", error: String(e) });
  }

  const last = await pool.query(`SELECT source_file FROM public.refresh_runs WHERE state='success' ORDER BY id DESC LIMIT 1`);
  // Normally "same CMS file as our last success" → nothing to do. But also require the live table to
  // actually hold rows: a host reboot truncates the (historically UNLOGGED) tables while the marker
  // still matches, so a pure filename check would refuse to reload and leave the site empty until CMS
  // ships a newer release. When the data is gone, reload the same file to self-heal.
  if (last.rows[0]?.source_file === marker && (await liveHasProviders())) {
    return json(res, 200, { status: "up_to_date", file: marker });
  }

  const ins = await pool.query(`INSERT INTO public.refresh_runs (state, source_file) VALUES ('running', $1) RETURNING id`, [marker]);
  const runId = ins.rows[0].id as number;
  const log = spawnJob(runId);
  return json(res, 202, { status: "started", runId, file: marker, log });
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  if (url === "/internal/healthz") return json(res, 200, { ok: true });
  if (!authed(req)) return json(res, 401, { error: "unauthorized" });

  if (url === "/internal/status" && method === "GET") {
    pool
      .query(`SELECT id, state, source_file, message, started_at, finished_at FROM public.refresh_runs ORDER BY id DESC LIMIT 5`)
      .then((r) => json(res, 200, { runs: r.rows }))
      .catch((e) => json(res, 500, { error: String(e) }));
    return;
  }
  if (url === "/internal/refresh" && method === "POST") {
    handleRefresh(res).catch((e) => json(res, 500, { error: String(e) }));
    return;
  }
  json(res, 404, { error: "not found" });
});

ensureTable()
  .then(() => server.listen(PORT, () => console.log(`refresh-server listening on :${PORT}`)))
  .catch((e) => { console.error("startup failed:", e); process.exit(1); });
