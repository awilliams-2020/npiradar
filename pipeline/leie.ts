/**
 * pipeline/leie.ts — load the HHS OIG List of Excluded Individuals/Entities (LEIE) into
 * public.oig_exclusions, and log who was added to or removed from it in public.provider_changes.
 *
 * OIG republishes the whole list (UPDATED.csv, ~15 MB) monthly; reinstated parties are simply dropped
 * from it, so "on the current file" = "currently excluded". Only rows carrying a real NPI are kept:
 * matching by name would risk flagging the wrong provider, and a wrong exclusion flag is the one
 * mistake this feature can't afford. ~8.7k NPIs as of 2026-10.
 *
 * Idempotent and cheap to call often: it hashes the download and exits if that file is already loaded.
 * Called by refresh-server.ts on its 6-hourly check. By hand:
 *   docker exec npiradar-refresh npx tsx pipeline/leie.ts
 *
 * Env: DATABASE_URL; optional REFRESH_SECRET + APP_INTERNAL_URL to purge the cached static pages after a change.
 */
import crypto from "node:crypto";
import { parse } from "csv-parse/sync";
import pg from "pg";
import { PROVIDER_CHANGES_DDL } from "./lib/changes.ts";
import { refreshFacetInsights } from "./lib/insights.ts";

const LEIE_URL = "https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv";
const MIN_ROWS = 50_000; // the full list is ~84k rows; anything far smaller is a truncated or error download
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/npiradar";

const ymd = (v: string) => (/^\d{8}$/.test(v) && v !== "00000000" ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : null);

async function main() {
  const res = await fetch(LEIE_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`LEIE download: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash("sha256").update(buf).digest("hex");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.dataset_loads (
        dataset text NOT NULL, sha256 text NOT NULL, rows int, loaded_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.oig_exclusions (
        npi text NOT NULL, excl_type text NOT NULL, excl_date date, waiver_date date, waiver_state text,
        last_name text, first_name text, business_name text, general text, specialty text,
        city text, state text
      );
      CREATE INDEX IF NOT EXISTS idx_oig_exclusions_npi ON public.oig_exclusions (npi);
      ${PROVIDER_CHANGES_DDL}`);

    const last = await client.query(`SELECT sha256 FROM public.dataset_loads WHERE dataset = 'leie' ORDER BY loaded_at DESC LIMIT 1`);
    if (last.rows[0]?.sha256 === sha) {
      console.log(`leie: up to date (${sha.slice(0, 12)})`);
      return;
    }

    // OIG serves Latin-1 (accented names); decoding as UTF-8 would mangle them.
    const all: Record<string, string>[] = parse(buf.toString("latin1"), { columns: true, skip_empty_lines: true, relax_quotes: true });
    if (all.length < MIN_ROWS) throw new Error(`LEIE has only ${all.length} rows (expected ~84k) — refusing to load`);
    const rows = all.filter((r) => /^\d{10}$/.test(r.NPI) && r.NPI !== "0000000000");

    await client.query("BEGIN");
    const firstLoad = (await client.query(`SELECT 1 FROM public.dataset_loads WHERE dataset = 'leie' LIMIT 1`)).rowCount === 0;
    await client.query(`CREATE TEMP TABLE leie_new (LIKE public.oig_exclusions) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const vals: unknown[] = [];
      const ph = chunk.map((r, j) => {
        vals.push(r.NPI, r.EXCLTYPE.trim(), ymd(r.EXCLDATE), ymd(r.WAIVERDATE), r.WVRSTATE || null,
          r.LASTNAME || null, r.FIRSTNAME || null, r.BUSNAME || null, r.GENERAL || null, r.SPECIALTY || null,
          r.CITY || null, r.STATE || null);
        return `(${Array.from({ length: 12 }, (_, k) => `$${j * 12 + k + 1}`).join(",")})`;
      });
      await client.query(`INSERT INTO leie_new VALUES ${ph.join(",")}`, vals);
    }

    // History. Skipped on the very first load: everyone on the list would read as "excluded today".
    let added = 0, removed = 0;
    if (!firstLoad) {
      const a = await client.query(`
        INSERT INTO public.provider_changes (release, npi, change, old_value, new_value)
        SELECT DISTINCT ON (n.npi) current_date, n.npi, 'oig_excluded', NULL, n.excl_type
          FROM leie_new n WHERE NOT EXISTS (SELECT 1 FROM public.oig_exclusions o WHERE o.npi = n.npi)
         ORDER BY n.npi, n.excl_date
        ON CONFLICT DO NOTHING`);
      const r = await client.query(`
        INSERT INTO public.provider_changes (release, npi, change, old_value, new_value)
        SELECT DISTINCT current_date, o.npi, 'oig_reinstated', NULL, NULL
          FROM public.oig_exclusions o WHERE NOT EXISTS (SELECT 1 FROM leie_new n WHERE n.npi = o.npi)
        ON CONFLICT DO NOTHING`);
      added = a.rowCount ?? 0;
      removed = r.rowCount ?? 0;
    }
    await client.query(`DELETE FROM public.oig_exclusions`);
    await client.query(`INSERT INTO public.oig_exclusions SELECT * FROM leie_new`);
    await client.query(`INSERT INTO public.dataset_loads (dataset, sha256, rows) VALUES ('leie', $1, $2)`, [sha, rows.length]);
    await client.query("COMMIT");
    console.log(`leie: loaded ${rows.length} NPI rows of ${all.length} (${sha.slice(0, 12)})` +
      (firstLoad ? " — first load, no history recorded" : `; +${added} excluded, -${removed} reinstated`));

    if (firstLoad || added || removed) await refreshFacetInsights(client, "leie"); // city pages' excluded counts

    // Provider pages render per request and show the flags at once; this refreshes the cached static pages.
    const secret = process.env.REFRESH_SECRET, app = process.env.APP_INTERNAL_URL;
    if (secret && app && (firstLoad || added || removed)) {
      const rv = await fetch(`${app}/api/revalidate`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch((e) => e);
      console.log(`leie: revalidate ${rv instanceof Error ? `failed: ${rv.message}` : rv.status}`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(`leie: FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
