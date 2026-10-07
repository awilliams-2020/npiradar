/**
 * pipeline/medicare.ts — three CMS Medicare files, keyed by NPI, from data.cms.gov:
 *
 *   public.medicare_enrollment       Medicare Fee-For-Service Public Provider Enrollment (PPEF), quarterly.
 *                                    One row per enrollment (an NPI can hold several: one per state/type).
 *   public.medicare_order_referring  Order and Referring, ~twice a week. One row per NPI: may it order or
 *                                    refer for Part B, DME, home health, power mobility, hospice.
 *   public.medicare_opt_out          Opt Out Affidavits, monthly. One row per affidavit; an NPI can have
 *                                    several (one per state). The file keeps affidavits whose end date has
 *                                    passed, so "opted out now" = an affidavit with end_date >= today.
 *
 * Together with the OIG flag these answer "can this NPI bill or order for Medicare?".
 *
 * Per dataset: newest CSV in CMS's catalog (data.json) → skip if that URL is already loaded
 * (public.dataset_loads.source) → stream into an UNLOGGED stage table → build `<table>_next` → in one
 * transaction log changes to provider_changes, swap the table in, record the load. Tables are LOGGED: an
 * UNLOGGED table comes back empty after a crash, and the pages would then say "not enrolled" for everyone
 * while dataset_loads said the file was loaded.
 *
 * Called by refresh-server.ts on its 6-hourly check. By hand:
 *   docker exec npiradar-refresh npx tsx pipeline/medicare.ts            # every dataset, if changed
 *   docker exec npiradar-refresh npx tsx pipeline/medicare.ts opt_out    # just these
 *
 * Env: DATABASE_URL; optional REFRESH_SECRET + APP_INTERNAL_URL to purge the cached static pages after a change.
 */
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { PROVIDER_CHANGES_DDL } from "./lib/changes.ts";

const CATALOG = "https://data.cms.gov/data.json";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/npiradar";

type ColType = "text" | "bool" | "date";
interface Dataset {
  key: string; // dataset_loads.dataset, and the CLI name
  title: string; // catalog title before " : <date>"
  table: string;
  minRows: number; // refuse a file far smaller than usual: a truncated or error download
  encoding: BufferEncoding;
  cols: { header: string; name: string; type: ColType }[];
  build: string; // SELECT over `stage` that produces the final rows
  history: (cur: string, next: string) => string; // INSERT into provider_changes, current table vs incoming
}

const DATASETS: Dataset[] = [
  {
    key: "medicare_enrollment",
    title: "Medicare Fee-For-Service Public Provider Enrollment",
    table: "medicare_enrollment",
    minRows: 2_000_000, // ~3.0M rows, 2.54M NPIs (2026-07)
    encoding: "latin1", // not UTF-8: a handful of names carry Latin-1 bytes
    cols: [
      { header: "NPI", name: "npi", type: "text" },
      { header: "ENRLMT_ID", name: "enrollment_id", type: "text" },
      { header: "PROVIDER_TYPE_CD", name: "provider_type_code", type: "text" },
      { header: "PROVIDER_TYPE_DESC", name: "provider_type", type: "text" },
      { header: "STATE_CD", name: "state", type: "text" },
    ],
    build: `SELECT DISTINCT npi, enrollment_id, provider_type_code, provider_type, state FROM stage`,
    history: (cur, next) => `
      INSERT INTO public.provider_changes (release, npi, change, old_value, new_value)
      SELECT current_date, n.npi, 'medicare_enrolled', NULL, min(n.provider_type)
        FROM ${next} n WHERE NOT EXISTS (SELECT 1 FROM ${cur} o WHERE o.npi = n.npi) GROUP BY n.npi
      UNION ALL
      SELECT current_date, o.npi, 'medicare_unenrolled', NULL, NULL
        FROM ${cur} o WHERE NOT EXISTS (SELECT 1 FROM ${next} n WHERE n.npi = o.npi) GROUP BY o.npi
      ON CONFLICT DO NOTHING`,
  },
  {
    key: "medicare_order_referring",
    title: "Order and Referring",
    table: "medicare_order_referring",
    minRows: 1_500_000, // ~2.06M (2026-10)
    encoding: "utf8",
    cols: [
      { header: "NPI", name: "npi", type: "text" },
      { header: "PARTB", name: "part_b", type: "bool" },
      { header: "DME", name: "dme", type: "bool" },
      { header: "HHA", name: "hha", type: "bool" },
      { header: "PMD", name: "pmd", type: "bool" },
      { header: "HOSPICE", name: "hospice", type: "bool" },
    ],
    // A few NPIs appear twice; an NPI may order for a program if any of its rows says so.
    build: `SELECT npi, bool_or(part_b) AS part_b, bool_or(dme) AS dme, bool_or(hha) AS hha,
                   bool_or(pmd) AS pmd, bool_or(hospice) AS hospice
              FROM stage GROUP BY npi`,
    // One row per NPI whose set of programs changed, including joining or leaving the list (NULL side).
    history: (cur, next) => {
      const programs = (tbl: string) => `
        SELECT npi, nullif(concat_ws(', ', CASE WHEN part_b THEN 'Part B' END, CASE WHEN dme THEN 'DME' END,
                 CASE WHEN hha THEN 'Home health' END, CASE WHEN pmd THEN 'Power mobility' END,
                 CASE WHEN hospice THEN 'Hospice' END), '') AS v FROM ${tbl}`;
      return `
        INSERT INTO public.provider_changes (release, npi, change, old_value, new_value)
        SELECT current_date, coalesce(o.npi, n.npi), 'medicare_ordering', o.v, n.v
          FROM (${programs(cur)}) o FULL JOIN (${programs(next)}) n ON n.npi = o.npi
         WHERE o.v IS DISTINCT FROM n.v
        ON CONFLICT DO NOTHING`;
    },
  },
  {
    key: "medicare_opt_out",
    title: "Opt Out Affidavits",
    table: "medicare_opt_out",
    minRows: 40_000, // ~57.8k affidavits, 57.0k NPIs (2026-08)
    encoding: "utf8",
    cols: [
      { header: "npi", name: "npi", type: "text" },
      { header: "Specialty", name: "specialty", type: "text" },
      { header: "Optout Effective Date", name: "effective_date", type: "date" },
      { header: "Optout End Date", name: "end_date", type: "date" },
      { header: "State Code", name: "state", type: "text" },
      { header: "Eligible to Order and Refer", name: "can_order_refer", type: "bool" },
      { header: "Last updated", name: "last_updated", type: "date" },
    ],
    build: `SELECT DISTINCT npi, specialty, effective_date, end_date, state, can_order_refer, last_updated FROM stage`,
    history: (cur, next) => `
      INSERT INTO public.provider_changes (release, npi, change, old_value, new_value)
      SELECT current_date, n.npi, 'medicare_opted_out', NULL, to_char(max(n.effective_date), 'YYYY-MM-DD')
        FROM ${next} n WHERE NOT EXISTS (SELECT 1 FROM ${cur} o WHERE o.npi = n.npi) GROUP BY n.npi
      UNION ALL
      SELECT current_date, o.npi, 'medicare_opt_out_ended', NULL, NULL
        FROM ${cur} o WHERE NOT EXISTS (SELECT 1 FROM ${next} n WHERE n.npi = o.npi) GROUP BY o.npi
      ON CONFLICT DO NOTHING`,
  },
];

const SQL_TYPE: Record<ColType, string> = { text: "text", bool: "boolean", date: "date" };

/** "MM/DD/YYYY" → "YYYY-MM-DD"; anything else → null. */
const mdy = (v: string) => {
  const m = v.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
function cell(v: string | undefined, type: ColType): string {
  const s = (v ?? "").trim();
  if (type === "bool") return s === "Y" ? "t" : s === "N" ? "f" : "\\N";
  if (type === "date") return mdy(s) ?? "\\N";
  return s === "" ? "\\N" : esc(s);
}
const write = (s: NodeJS.WritableStream, chunk: string): Promise<void> =>
  s.write(chunk) ? Promise.resolve() : new Promise((res) => s.once("drain", () => res()));

/** Catalog title → newest CSV URL. Versions are separate catalog entries titled "<title> : YYYY-MM-DD". */
async function catalog(): Promise<Map<string, string>> {
  const res = await fetch(CATALOG, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`);
  const items = ((await res.json()) as { dataset: { title: string; modified?: string; distribution?: { downloadURL?: string }[] }[] }).dataset;
  const best = new Map<string, { at: string; url: string }>();
  for (const it of items) {
    const [base, date = ""] = it.title.split(" : ");
    const url = it.distribution?.map((d) => d.downloadURL).find((u) => u?.toLowerCase().endsWith(".csv"));
    if (!url) continue;
    const at = `${date}|${it.modified ?? ""}`; // the version date first; modified breaks ties
    if (!best.has(base) || at > best.get(base)!.at) best.set(base, { at, url });
  }
  return new Map([...best].map(([k, v]) => [k, v.url]));
}

async function load(client: pg.Client, ds: Dataset, url: string): Promise<void> {
  const t = `public.${ds.table}`;
  const stage = `public.${ds.table}_stage`, next = `public.${ds.table}_next`;
  console.log(`medicare ${ds.key}: loading ${url.split("/").pop()}`);
  await client.query("SET max_parallel_workers_per_gather = 0; SET work_mem = '64MB'; SET synchronous_commit = off");
  await client.query(`DROP TABLE IF EXISTS ${stage}, ${next};
    CREATE UNLOGGED TABLE ${stage} (${ds.cols.map((c) => `${c.name} ${SQL_TYPE[c.type]}`).join(", ")})`);

  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  const csv = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream).pipe(
    parse({ columns: false, relax_quotes: true, relax_column_count: true, bom: true, encoding: ds.encoding }),
  );
  const copy = client.query(copyFrom(`COPY ${stage} FROM STDIN`));
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
    if (!/^\d{10}$/.test(row[idx[0]]?.trim() ?? "")) continue;
    await write(copy, ds.cols.map((c, k) => cell(row[idx![k]], c.type)).join("\t") + "\n");
    kept++;
  }
  await new Promise<void>((res, rej) => { copy.on("finish", () => res()); copy.on("error", rej); copy.end(); });
  if (kept < ds.minRows) throw new Error(`only ${kept} rows with an NPI of ${n} (expected ≥${ds.minRows}) — refusing to load`);

  await client.query(`CREATE TABLE ${next} AS ${ds.build.replace(/\bstage\b/g, stage)}`);
  await client.query(`CREATE INDEX ${ds.table}_next_npi ON ${next} (npi); ANALYZE ${next}`);

  await client.query("BEGIN");
  await client.query(`CREATE TABLE IF NOT EXISTS ${t} (LIKE ${next})`);
  const firstLoad = (await client.query(`SELECT 1 FROM public.dataset_loads WHERE dataset = $1 LIMIT 1`, [ds.key])).rowCount === 0;
  let changes = 0;
  // History. Skipped on the first load: every NPI would read as changed today.
  if (!firstLoad) changes = (await client.query(ds.history(t, next))).rowCount ?? 0;
  await client.query(`DROP TABLE ${t}`);
  await client.query(`ALTER TABLE ${next} RENAME TO ${ds.table}`);
  await client.query(`ALTER INDEX public.${ds.table}_next_npi RENAME TO ${ds.table}_npi`);
  await client.query(`INSERT INTO public.dataset_loads (dataset, sha256, rows, source) VALUES ($1, '', $2, $3)`, [ds.key, kept, url]);
  await client.query("COMMIT");
  await client.query(`DROP TABLE ${stage}`);
  const c = await client.query(`SELECT count(*)::int AS rows, count(DISTINCT npi)::int AS npis FROM ${t}`);
  console.log(`medicare ${ds.key}: ${c.rows[0].rows.toLocaleString()} rows, ${c.rows[0].npis.toLocaleString()} NPIs` +
    (firstLoad ? " — first load, no history recorded" : `; ${changes.toLocaleString()} changes logged`));
}

async function main() {
  const only = process.argv.slice(2);
  const sets = only.length ? DATASETS.filter((d) => only.includes(d.key) || only.includes(d.key.replace(/^medicare_/, ""))) : DATASETS;
  if (sets.length === 0) throw new Error(`unknown dataset; one of: ${DATASETS.map((d) => d.key).join(", ")}`);
  const urls = await catalog();

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
      const url = urls.get(ds.title);
      if (!url) { console.error(`medicare ${ds.key}: "${ds.title}" not in the catalog`); failed++; continue; }
      const last = await client.query(`SELECT source FROM public.dataset_loads WHERE dataset = $1 ORDER BY loaded_at DESC LIMIT 1`, [ds.key]);
      if (last.rows[0]?.source === url) { console.log(`medicare ${ds.key}: up to date`); continue; }
      try {
        await load(client, ds, url);
        changed = true;
      } catch (e) {
        // One dataset failing must not block the others; the next check retries it.
        await client.query("ROLLBACK").catch(() => {});
        console.error(`medicare ${ds.key}: FAILED: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    }
  } finally {
    await client.end();
  }

  // Provider pages render per request and show the new status at once; this refreshes the cached static pages.
  const secret = process.env.REFRESH_SECRET, app = process.env.APP_INTERNAL_URL;
  if (changed && secret && app) {
    const rv = await fetch(`${app}/api/revalidate`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch((e) => e);
    console.log(`medicare: revalidate ${rv instanceof Error ? `failed: ${rv.message}` : rv.status}`);
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(`medicare: FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
