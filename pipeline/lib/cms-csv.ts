// Shared loader for CMS's public CSV files (data.cms.gov): pipeline/medicare.ts, pipeline/carecompare.ts.
//
// Per dataset: stream the CSV into an UNLOGGED stage table → build each output as `<table>_next` → in one
// transaction log changes to provider_changes (outputs that define `history`), swap every output in, record
// the load (public.dataset_loads.source = the URL) → drop the stage. A dataset whose URL is already loaded
// is skipped, so a check is one catalog fetch. One dataset failing doesn't block the others.
//
// Output tables are LOGGED on purpose: an UNLOGGED table comes back empty after a crash, and the pages
// would then say "not enrolled" for everyone while dataset_loads said the file was loaded.
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { PROVIDER_CHANGES_DDL } from "./changes.ts";

export type ColType = "text" | "bool" | "date" | "int";

export interface CsvOutput {
  table: string;
  build: string; // SELECT over `stage` producing this table's rows
  key?: string; // indexed lookup column (default npi)
  history?: (cur: string, next: string) => string; // INSERT into provider_changes, current table vs incoming
}

export interface CsvDataset {
  key: string; // dataset_loads.dataset, and the CLI name
  minRows: number; // refuse a file far smaller than usual: a truncated or error download
  encoding: BufferEncoding;
  cols: { header: string; name: string; type: ColType }[]; // cols[0] is the row key
  keyPattern?: RegExp; // rows whose cols[0] doesn't match are skipped (default: a 10-digit NPI)
  outputs: CsvOutput[];
}

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/npiradar";
const SQL_TYPE: Record<ColType, string> = { text: "text", bool: "boolean", date: "date", int: "integer" };

/** "MM/DD/YYYY" → "YYYY-MM-DD"; anything else → null. */
const mdy = (v: string) => {
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
function cell(v: string | undefined, type: ColType): string {
  const s = (v ?? "").trim();
  if (type === "bool") return s === "Y" ? "t" : s === "N" ? "f" : "\\N";
  if (type === "date") return mdy(s) ?? "\\N";
  if (type === "int") return /^\d{1,9}$/.test(s) ? s : "\\N";
  return s === "" ? "\\N" : esc(s);
}
const write = (s: NodeJS.WritableStream, chunk: string): Promise<void> =>
  s.write(chunk) ? Promise.resolve() : new Promise((res) => s.once("drain", () => res()));

async function load(client: pg.Client, label: string, ds: CsvDataset, url: string): Promise<void> {
  const stage = `public.${ds.key}_stage`;
  console.log(`${label} ${ds.key}: loading ${url.split("/").pop()}`);
  await client.query("SET max_parallel_workers_per_gather = 0; SET work_mem = '64MB'; SET synchronous_commit = off");
  await client.query(`DROP TABLE IF EXISTS ${stage}, ${ds.outputs.map((o) => `public.${o.table}_next`).join(", ")};
    CREATE UNLOGGED TABLE ${stage} (${ds.cols.map((c) => `${c.name} ${SQL_TYPE[c.type]}`).join(", ")})`);

  const res = await fetch(url, { signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  const csv = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(
    parse({ columns: false, relax_quotes: true, relax_column_count: true, bom: true, encoding: ds.encoding }),
  );
  const copy = client.query(copyFrom(`COPY ${stage} FROM STDIN`));
  const keyOk = ds.keyPattern ?? /^\d{10}$/;
  let idx: number[] | null = null, n = 0, kept = 0;
  for await (const row of csv as AsyncIterable<string[]>) {
    if (!idx) {
      const heads = row.map((h) => h.trim().toLowerCase());
      idx = ds.cols.map((c) => {
        const i = heads.indexOf(c.header.toLowerCase());
        if (i < 0) throw new Error(`column ${c.header} missing (got: ${row.join(", ")})`);
        return i;
      });
      continue;
    }
    n++;
    if (!keyOk.test(row[idx[0]]?.trim() ?? "")) continue;
    await write(copy, ds.cols.map((c, k) => cell(row[idx![k]], c.type)).join("\t") + "\n");
    kept++;
  }
  await new Promise<void>((res, rej) => { copy.on("finish", () => res()); copy.on("error", rej); copy.end(); });
  if (kept < ds.minRows) throw new Error(`only ${kept} keyed rows of ${n} (expected ≥${ds.minRows}) — refusing to load`);

  for (const o of ds.outputs) {
    const next = `public.${o.table}_next`;
    await client.query(`CREATE TABLE ${next} AS ${o.build.replace(/\bstage\b/g, stage)}`);
    await client.query(`CREATE INDEX ${o.table}_next_key ON ${next} (${o.key ?? "npi"}); ANALYZE ${next}`);
  }

  await client.query("BEGIN");
  const firstLoad = (await client.query(`SELECT 1 FROM public.dataset_loads WHERE dataset = $1 LIMIT 1`, [ds.key])).rowCount === 0;
  let changes = 0;
  for (const o of ds.outputs) {
    const t = `public.${o.table}`, next = `public.${o.table}_next`;
    await client.query(`CREATE TABLE IF NOT EXISTS ${t} (LIKE ${next})`);
    // History. Skipped on the first load: every NPI would read as changed today.
    if (!firstLoad && o.history) changes += (await client.query(o.history(t, next))).rowCount ?? 0;
    await client.query(`DROP TABLE ${t}`);
    await client.query(`ALTER TABLE ${next} RENAME TO ${o.table}`);
    await client.query(`ALTER INDEX public.${o.table}_next_key RENAME TO ${o.table}_key`);
  }
  await client.query(`INSERT INTO public.dataset_loads (dataset, sha256, rows, source) VALUES ($1, '', $2, $3)`, [ds.key, kept, url]);
  await client.query("COMMIT");
  await client.query(`DROP TABLE ${stage}`);
  for (const o of ds.outputs) {
    const c = await client.query(`SELECT count(*)::int AS rows FROM public.${o.table}`);
    console.log(`${label} ${ds.key}: ${o.table} ${c.rows[0].rows.toLocaleString()} rows`);
  }
  if (ds.outputs.some((o) => o.history)) {
    console.log(`${label} ${ds.key}: ${firstLoad ? "first load, no history recorded" : `${changes.toLocaleString()} changes logged`}`);
  }
}

/** Loads each dataset whose current URL (from `urls`, by dataset key) isn't loaded yet. Exits 1 if any
 *  failed, after trying the rest. Purges the app's cached static pages if anything loaded. */
export async function runDatasets(label: string, sets: CsvDataset[], urls: Map<string, string>): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  let changed = false, failed = 0;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.dataset_loads (
        dataset text NOT NULL, sha256 text NOT NULL, rows int, loaded_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE public.dataset_loads ADD COLUMN IF NOT EXISTS source text;
      ${PROVIDER_CHANGES_DDL}`);
    for (const ds of sets) {
      const url = urls.get(ds.key);
      if (!url) { console.error(`${label} ${ds.key}: not in the catalog`); failed++; continue; }
      const last = await client.query(`SELECT source FROM public.dataset_loads WHERE dataset = $1 ORDER BY loaded_at DESC LIMIT 1`, [ds.key]);
      if (last.rows[0]?.source === url) { console.log(`${label} ${ds.key}: up to date`); continue; }
      try {
        await load(client, label, ds, url);
        changed = true;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`${label} ${ds.key}: FAILED: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    }
  } finally {
    await client.end();
  }

  // Provider pages render per request and show new data at once; this refreshes the cached static pages.
  const secret = process.env.REFRESH_SECRET, app = process.env.APP_INTERNAL_URL;
  if (changed && secret && app) {
    const rv = await fetch(`${app}/api/revalidate`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch((e) => e);
    console.log(`${label}: revalidate ${rv instanceof Error ? `failed: ${rv.message}` : rv.status}`);
  }
  if (failed) process.exit(1);
}

/** CLI filter: `tsx x.ts opt_out` → datasets whose key is, or ends with, an argument. */
export function selectDatasets(sets: CsvDataset[], args: string[]): CsvDataset[] {
  if (args.length === 0) return sets;
  const out = sets.filter((d) => args.some((a) => d.key === a || d.key.endsWith(`_${a}`)));
  if (out.length === 0) throw new Error(`unknown dataset; one of: ${sets.map((d) => d.key).join(", ")}`);
  return out;
}
