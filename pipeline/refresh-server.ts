/**
 * refresh-server.ts — the tiny HTTP service cron-job.org pings to trigger a monthly NPPES refresh.
 *
 * cron-job.org expects a response within ~30s, but a refresh takes ~20 min — so this NEVER does the
 * work synchronously. It also runs the same check itself every 6h (see CHECK_EVERY_MS), so a release
 * loads within hours of CMS posting it. POST /internal/refresh validates the secret, dedupes (advisory via a
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

async function startRefresh(): Promise<{ code: number; body: Record<string, unknown> }> {
  // One refresh at a time. A `running` row older than 3h is treated as a crashed run and ignored.
  const running = await pool.query(
    `SELECT id FROM public.refresh_runs WHERE state='running' AND started_at > now() - interval '3 hours' LIMIT 1`,
  );
  if (running.rowCount) return { code: 409, body: { status: "already_running", runId: running.rows[0].id } };

  let marker = "";
  try {
    marker = await resolveLatestMarker();
  } catch (e) {
    return { code: 502, body: { status: "resolve_failed", error: String(e) } };
  }

  const last = await pool.query(`SELECT source_file FROM public.refresh_runs WHERE state='success' ORDER BY id DESC LIMIT 1`);
  // Normally "same CMS file as our last success" → nothing to do. But also require the live table to
  // actually hold rows: a host reboot truncates the (historically UNLOGGED) tables while the marker
  // still matches, so a pure filename check would refuse to reload and leave the site empty until CMS
  // ships a newer release. When the data is gone, reload the same file to self-heal.
  if (last.rows[0]?.source_file === marker && (await liveHasProviders())) {
    return { code: 200, body: { status: "up_to_date", file: marker } };
  }

  const ins = await pool.query(`INSERT INTO public.refresh_runs (state, source_file) VALUES ('running', $1) RETURNING id`, [marker]);
  const runId = ins.rows[0].id as number;
  const log = spawnJob(runId);
  return { code: 202, body: { status: "started", runId, file: marker, log } };
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
    startRefresh().then((r) => json(res, r.code, r.body)).catch((e) => json(res, 500, { error: String(e) }));
    return;
  }
  json(res, 404, { error: "not found" });
});

// Self-scheduled check. CMS posts the monthly file around the second weekend, on no fixed day, so a
// monthly cron on the 1st left the data 3-7 weeks old (2026-10-07: the September file sat unloaded until
// 10-01). startRefresh() is a no-op when nothing is newer, so checking every 6h costs a few ranged GETs
// and loads each release within hours of it posting. cron-job.org's POST still works; the dedupe makes
// overlapping triggers harmless.
const CHECK_EVERY_MS = 6 * 3_600_000;
async function scheduledCheck() {
  try {
    const r = await startRefresh();
    if (r.code !== 200) console.log(`scheduled check: ${r.code} ${JSON.stringify(r.body)}`);
  } catch (e) {
    console.error("scheduled check failed:", e);
  }
  await refreshLeie();
  await refreshMedicare();
  await refreshOpenPayments();
}

// CMS Medicare files (pipeline/medicare.ts): enrollment (quarterly), order & referring (~twice weekly),
// opt-out (monthly). One catalog fetch when nothing changed; a full reload is ~2-3 min, so like Open
// Payments it waits out an NPPES run rather than competing with it for Postgres.
let medicareRunning = false;
async function refreshMedicare(): Promise<void> {
  if (medicareRunning) return;
  const busy = await pool
    .query(`SELECT 1 FROM public.refresh_runs WHERE state='running' AND started_at > now() - interval '3 hours'`)
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => true);
  if (busy) { console.log("medicare: skipped, NPPES refresh running"); return; }
  medicareRunning = true;
  await new Promise<void>((resolve) => {
    execFile(path.join(SRC, "node_modules/.bin/tsx"), [path.join(SRC, "pipeline/medicare.ts")], { timeout: 3_600_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) console.error(`medicare check failed: ${out.split("\n").slice(-5).join("\n") || err.message}`);
      else console.log(out); // one line per dataset per check, so a stalled scheduler is visible
      resolve();
    });
  });
  medicareRunning = false;
}

// Open Payments (pipeline/openpayments.ts): a no-op catalog fetch unless CMS published or corrected a
// program year; a real load is ~9 GB per year, so never alongside an NPPES run (same disk + Postgres).
let opRunning = false;
async function refreshOpenPayments(): Promise<void> {
  if (opRunning) return;
  const busy = await pool
    .query(`SELECT 1 FROM public.refresh_runs WHERE state='running' AND started_at > now() - interval '3 hours'`)
    .then((r) => (r.rowCount ?? 0) > 0)
    .catch(() => true);
  if (busy) { console.log("op: skipped, NPPES refresh running"); return; }
  opRunning = true;
  await new Promise<void>((resolve) => {
    execFile(path.join(SRC, "node_modules/.bin/tsx"), [path.join(SRC, "pipeline/openpayments.ts")], { timeout: 4 * 3_600_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) console.error(`op check failed: ${out.split("\n").slice(-5).join("\n") || err.message}`);
      else console.log(out.split("\n").filter((l) => l.startsWith("op ")).join("\n"));
      resolve();
    });
  });
  opRunning = false;
}

// OIG exclusion list (pipeline/leie.ts): a 15 MB file, loaded in seconds, so it runs inline here
// rather than through the detached NPPES runner. leie.ts exits early when the file is unchanged.
let leieRunning = false;
function refreshLeie(): Promise<void> {
  if (leieRunning) return Promise.resolve();
  leieRunning = true;
  return new Promise((resolve) => {
    execFile(path.join(SRC, "node_modules/.bin/tsx"), [path.join(SRC, "pipeline/leie.ts")], { timeout: 600_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      if (err) console.error(`leie check failed: ${out || err.message}`);
      else console.log(out); // one line per check even when unchanged, so a stalled scheduler is visible
      leieRunning = false;
      resolve();
    });
  });
}

ensureTable()
  .then(() => server.listen(PORT, () => {
    console.log(`refresh-server listening on :${PORT}`);
    setTimeout(scheduledCheck, 60_000); // first check shortly after boot, then every 6h
    setInterval(scheduledCheck, CHECK_EVERY_MS);
  }))
  .catch((e) => { console.error("startup failed:", e); process.exit(1); });
