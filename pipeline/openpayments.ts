/**
 * pipeline/openpayments.ts — CMS Open Payments (general payments from drug/device makers to clinicians)
 * → per-NPI yearly totals in Postgres.
 *
 * Each program year is one CSV of ~9 GB / ~15M rows, republished when CMS corrects it (the URL carries
 * the publication date). We keep only per-NPI aggregates, not rows:
 *   public.op_npi_year     (npi, program_year)          total, payment count, company count
 *   public.op_npi_company  (npi, program_year, company) top 10 companies per NPI-year
 *   public.op_npi_nature   (npi, program_year, nature)  totals by payment type (food, consulting, …)
 * Rows without a 10-digit NPI (e.g. teaching hospitals) are skipped. Disputed payments are included, as
 * CMS publishes them.
 *
 * Per year: download (curl, resumable) → COPY 6 columns into an UNLOGGED stage table → aggregate →
 * swap that year's rows in one transaction → drop the stage and delete the download. A year whose
 * catalog URL is already loaded is skipped, so `--check` is cheap: one catalog fetch.
 *
 *   tsx pipeline/openpayments.ts                 # load/refresh the latest 3 program years if changed
 *   tsx pipeline/openpayments.ts --years 2025    # just these years
 *
 * Env: DATABASE_URL, NPIRADAR_DATA_DIR (download dir's parent), optional REFRESH_SECRET + APP_INTERNAL_URL.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "csv-parse";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

const CATALOG = "https://openpaymentsdata.cms.gov/api/1/metastore/schemas/dataset/items?show-reference-ids=false";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/npiradar";
const DATA_DIR = path.join(path.dirname(process.env.NPIRADAR_DATA_DIR ?? path.join(process.env.HOME ?? "", "npiradar/pipeline/data/monthly")), "openpayments");
const YEARS_KEPT = 3;
const TOP_COMPANIES = 10;

const args = process.argv.slice(2);
const yearsArg = (() => { const i = args.indexOf("--years"); return i >= 0 ? args[i + 1].split(",").map(Number) : null; })();

const COLS = {
  npi: "Covered_Recipient_NPI",
  company: "Applicable_Manufacturer_or_Applicable_GPO_Making_Payment_Name",
  amount: "Total_Amount_of_Payment_USDollars",
  payments: "Number_of_Payments_Included_in_Total_Amount",
  nature: "Nature_of_Payment_or_Transfer_of_Value",
  year: "Program_Year",
} as const;

/** program year → general-payments CSV URL, from CMS's DKAN catalog. */
async function catalog(): Promise<Map<number, string>> {
  const items = (await (await fetch(CATALOG, { signal: AbortSignal.timeout(60_000) })).json()) as
    { title: string; distribution?: { data?: { downloadURL?: string } }[] }[];
  const out = new Map<number, string>();
  for (const it of items) {
    const m = it.title.match(/^(\d{4}) General Payment Data$/);
    const url = it.distribution?.[0]?.data?.downloadURL;
    if (m && url) out.set(Number(m[1]), url);
  }
  return out;
}

const esc = (v: string) => (v === "" ? "\\N" : v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"));
const write = (s: NodeJS.WritableStream, chunk: string): Promise<void> =>
  s.write(chunk) ? Promise.resolve() : new Promise((res) => s.once("drain", () => res()));

async function loadYear(client: pg.Client, year: number, url: string) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, path.basename(url));
  console.log(`op ${year}: downloading ${path.basename(url)}`);
  const dl = spawnSync("curl", ["-fsSL", "--retry", "5", "--retry-all-errors", "-C", "-", "-o", file, url], { stdio: "inherit" });
  if (dl.status !== 0) throw new Error(`download failed (curl exit ${dl.status})`);

  await client.query("SET max_parallel_workers_per_gather = 0; SET work_mem = '64MB'; SET synchronous_commit = off");
  await client.query(`DROP TABLE IF EXISTS public.op_stage;
    CREATE UNLOGGED TABLE public.op_stage (npi text, company text, amount numeric, payments int, nature text)`);
  const copy = client.query(copyFrom(`COPY public.op_stage FROM STDIN`));
  const csv = fs.createReadStream(file).pipe(parse({ columns: false, relax_quotes: true, bom: true }));
  let idx: Record<keyof typeof COLS, number> | null = null, n = 0, kept = 0;
  for await (const row of csv as AsyncIterable<string[]>) {
    if (!idx) {
      idx = Object.fromEntries(Object.entries(COLS).map(([k, h]) => {
        const i = row.indexOf(h);
        if (i < 0) throw new Error(`column ${h} missing`);
        return [k, i];
      })) as Record<keyof typeof COLS, number>;
      continue;
    }
    n++;
    const npi = row[idx.npi];
    if (!/^\d{10}$/.test(npi) || Number(row[idx.year]) !== year) continue;
    const amount = row[idx.amount];
    if (!/^-?\d+(\.\d+)?$/.test(amount)) continue;
    await write(copy, [npi, esc(row[idx.company] ?? ""), amount, /^\d+$/.test(row[idx.payments]) ? row[idx.payments] : "1", esc(row[idx.nature] ?? "")].join("\t") + "\n");
    kept++;
    if (n % 2_000_000 === 0) console.log(`op ${year}: ${n.toLocaleString()} rows read`);
  }
  await new Promise<void>((res, rej) => { copy.on("finish", () => res()); copy.on("error", rej); copy.end(); });
  console.log(`op ${year}: staged ${kept.toLocaleString()} of ${n.toLocaleString()} rows`);
  if (kept < 1_000_000) throw new Error(`only ${kept} rows with an NPI — refusing to replace ${year}`);

  await client.query("BEGIN");
  for (const t of ["op_npi_year", "op_npi_company", "op_npi_nature"]) await client.query(`DELETE FROM public.${t} WHERE program_year = $1`, [year]);
  await client.query(`
    INSERT INTO public.op_npi_year (npi, program_year, total_usd, payments, companies)
    SELECT npi, $1, sum(amount), sum(payments), count(DISTINCT company) FROM public.op_stage GROUP BY npi`, [year]);
  await client.query(`
    INSERT INTO public.op_npi_company (npi, program_year, company, total_usd, payments)
    SELECT npi, $1, company, total, payments FROM (
      SELECT npi, company, sum(amount) AS total, sum(payments) AS payments,
             row_number() OVER (PARTITION BY npi ORDER BY sum(amount) DESC, company) AS rk
        FROM public.op_stage GROUP BY npi, company) x
     WHERE rk <= ${TOP_COMPANIES}`, [year]);
  await client.query(`
    INSERT INTO public.op_npi_nature (npi, program_year, nature, total_usd, payments)
    SELECT npi, $1, nature, sum(amount), sum(payments) FROM public.op_stage GROUP BY npi, nature`, [year]);
  await client.query(`INSERT INTO public.dataset_loads (dataset, sha256, rows, source) VALUES ($1, '', $2, $3)`, [`open_payments_${year}`, kept, url]);
  await client.query("COMMIT");
  const s = await client.query(`SELECT count(*)::int AS npis, sum(total_usd)::bigint AS usd FROM public.op_npi_year WHERE program_year = $1`, [year]);
  console.log(`op ${year}: ${s.rows[0].npis.toLocaleString()} NPIs, $${Number(s.rows[0].usd).toLocaleString()}`);

  await client.query(`DROP TABLE public.op_stage`);
  fs.rmSync(file, { force: true });
}

async function main() {
  const urls = await catalog();
  if (urls.size === 0) throw new Error("catalog listed no general-payment datasets");
  const years = yearsArg ?? [...urls.keys()].sort((a, b) => b - a).slice(0, YEARS_KEPT);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  let changed = false;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.dataset_loads (
        dataset text NOT NULL, sha256 text NOT NULL, rows int, loaded_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE public.dataset_loads ADD COLUMN IF NOT EXISTS source text;
      CREATE TABLE IF NOT EXISTS public.op_npi_year (
        npi text NOT NULL, program_year int NOT NULL, total_usd numeric(14,2) NOT NULL, payments int NOT NULL,
        companies int NOT NULL, PRIMARY KEY (npi, program_year));
      CREATE TABLE IF NOT EXISTS public.op_npi_company (
        npi text NOT NULL, program_year int NOT NULL, company text, total_usd numeric(14,2) NOT NULL, payments int NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_op_npi_company ON public.op_npi_company (npi, program_year);
      CREATE TABLE IF NOT EXISTS public.op_npi_nature (
        npi text NOT NULL, program_year int NOT NULL, nature text, total_usd numeric(14,2) NOT NULL, payments int NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_op_npi_nature ON public.op_npi_nature (npi, program_year);`);

    for (const year of years) {
      const url = urls.get(year);
      if (!url) { console.warn(`op ${year}: not in the catalog`); continue; }
      const last = await client.query(`SELECT source FROM public.dataset_loads WHERE dataset = $1 ORDER BY loaded_at DESC LIMIT 1`, [`open_payments_${year}`]);
      if (last.rows[0]?.source === url) { console.log(`op ${year}: up to date`); continue; }
      await loadYear(client, year, url);
      changed = true;
    }
    // Years that fell out of the window: drop them so pages show the same years the loader maintains.
    if (!yearsArg) {
      const oldest = Math.min(...years);
      for (const t of ["op_npi_year", "op_npi_company", "op_npi_nature"]) await client.query(`DELETE FROM public.${t} WHERE program_year < $1`, [oldest]);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }

  const secret = process.env.REFRESH_SECRET, app = process.env.APP_INTERNAL_URL;
  if (changed && secret && app) {
    const rv = await fetch(`${app}/api/revalidate`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch((e) => e);
    console.log(`op: revalidate ${rv instanceof Error ? `failed: ${rv.message}` : rv.status}`);
  }
}

main().catch((e) => { console.error(`op: FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
