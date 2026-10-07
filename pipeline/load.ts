/**
 * pipeline/load.ts — Phase 0/4 loader: NPPES CSV + NUCC taxonomy → shared Postgres.
 *
 * Uses the shared infra (the `postgres` container, host port 5433, db `npiradar`) and is tuned
 * to load fast without starving the live sites that share the instance:
 *   - UNLOGGED staging tables → no WAL traffic (data is reconstructible from the monthly file).
 *   - PK + indexes are built AFTER the bulk load, once, with a bumped maintenance_work_mem.
 *   - synchronous_commit off for the loading session.
 *   - positional CSV parsing via lib/provider.ts (no per-row 330-key object).
 *
 * Modes (default = all three in one process):
 *   --prepare              DDL (drop+recreate UNLOGGED tables) + load taxonomy
 *   --shard i/N            COPY only the providers whose rowIndex % N === i  (load-only)
 *   --side                 COPY the release's side files (other names, secondary locations, endpoints),
 *                          found next to the npidata CSV by its date range; runs alongside the shards
 *   --finalize             add PK + indexes + ANALYZE, then run verification queries
 *   --diff NAME            record what changed per NPI between schema NAME (new) and "live" (current)
 *                          into public.provider_changes; run after --finalize, before --swap
 *
 * Usage:
 *   tsx pipeline/load.ts <npidata.csv> --taxonomy <nucc.csv>        # single-process, everything
 *   (parallel fan-out is driven by pipeline/load-parallel.ts)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { mapRow, buildColIndex, toCopyLine, loadTaxonomyRows, PROVIDER_COLUMNS, type ColIndex } from "./lib/provider.ts";
import { PROVIDER_CHANGES_DDL } from "./lib/changes.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const inputPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true) ?? args[0];
const taxonomyPath = flag("--taxonomy");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:5433/npiradar";
const dbName = (() => { try { return new URL(DATABASE_URL).pathname.replace(/^\//, "") || "npiradar"; } catch { return "npiradar"; } })();

// Zero-downtime support: build into --schema <name> (e.g. "staging") instead of the search_path
// default, then --swap <name> promotes it to "live" atomically. Validate identifiers — they end up
// interpolated into DDL — even though they only come from our own flags.
const qIdent = (s: string) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier: ${s}`); return `"${s}"`; };
const targetSchema = flag("--schema");
const swapSchema = flag("--swap");
const diffSchema = flag("--diff");
const diffAgainst = flag("--against") ?? "live"; // the current release; overridable for testing

// mode resolution: any explicit mode flag disables the implicit "do everything" run
const doPrepare = args.includes("--prepare");
const doFinalize = args.includes("--finalize");
const doSide = args.includes("--side");
const shardSpec = flag("--shard");
const explicit = doPrepare || doFinalize || doSide || shardSpec !== undefined || swapSchema !== undefined || diffSchema !== undefined;
const runSide = doSide || !explicit;
const runPrepare = doPrepare || !explicit;
const runFinalize = doFinalize || !explicit;
const shard = shardSpec
  ? (() => { const [i, n] = shardSpec.split("/").map(Number); if (!(n >= 1 && i >= 0 && i < n)) throw new Error(`bad --shard ${shardSpec}`); return { i, n }; })()
  : explicit ? null : { i: 0, n: 1 };

if (!swapSchema && !diffSchema && (!inputPath || inputPath.startsWith("--"))) {
  console.error("usage: tsx pipeline/load.ts <npidata.csv> --taxonomy <nucc.csv> [--prepare|--shard i/N|--finalize] [--schema NAME] [--swap NAME]");
  process.exit(1);
}

const DDL = `
DROP TABLE IF EXISTS providers CASCADE;  -- CASCADE: the facet materialized views depend on these
DROP TABLE IF EXISTS taxonomy CASCADE;
DROP TABLE IF EXISTS provider_other_names, provider_locations, provider_endpoints;

CREATE UNLOGGED TABLE taxonomy (
  code text PRIMARY KEY, grouping text, classification text,
  specialization text, display_name text, section text, definition text
);

-- no PK / indexes during bulk load; added in --finalize
CREATE UNLOGGED TABLE providers (
  npi text, entity_type text, org_name text, last_name text, first_name text,
  middle_name text, credential text, sex text, practice_addr1 text, practice_addr2 text,
  practice_city text, practice_state text, practice_zip text, practice_phone text,
  primary_taxonomy_code text, enumeration_date date, last_update_date date,
  deactivation_date date, is_sole_proprietor boolean,
  license_number text, license_state text
);

-- Side files from the same release. Always created (empty if a file is missing) so the app's
-- queries never hit a missing table. Indexed on npi in --finalize.
CREATE UNLOGGED TABLE provider_other_names (npi text, name text, type_code text);
CREATE UNLOGGED TABLE provider_locations (
  npi text, addr1 text, addr2 text, city text, state text, zip text, country text,
  phone text, phone_ext text, fax text
);
CREATE UNLOGGED TABLE provider_endpoints (
  npi text, endpoint_type text, endpoint_type_desc text, endpoint text, affiliation text,
  description text, affiliation_name text, use_desc text, content_desc text,
  city text, state text
);
`;

// Side-file → table mapping. Headers are matched after normalizing (lowercase, alphanumerics only),
// because CMS's header text has inconsistent spacing ("Address-  Address Line 2").
const SIDE_FILES: { prefix: string; table: string; cols: [string, string][] }[] = [
  { prefix: "othername", table: "provider_other_names", cols: [
    ["npi", "NPI"],
    ["name", "Provider Other Organization Name"],
    ["type_code", "Provider Other Organization Name Type Code"],
  ] },
  { prefix: "pl", table: "provider_locations", cols: [
    ["npi", "NPI"],
    ["addr1", "Provider Secondary Practice Location Address- Address Line 1"],
    ["addr2", "Provider Secondary Practice Location Address- Address Line 2"],
    ["city", "Provider Secondary Practice Location Address - City Name"],
    ["state", "Provider Secondary Practice Location Address - State Name"],
    ["zip", "Provider Secondary Practice Location Address - Postal Code"],
    ["country", "Provider Secondary Practice Location Address - Country Code (If outside U.S.)"],
    ["phone", "Provider Secondary Practice Location Address - Telephone Number"],
    ["phone_ext", "Provider Secondary Practice Location Address - Telephone Extension"],
    ["fax", "Provider Practice Location Address - Fax Number"],
  ] },
  { prefix: "endpoint", table: "provider_endpoints", cols: [
    ["npi", "NPI"],
    ["endpoint_type", "Endpoint Type"],
    ["endpoint_type_desc", "Endpoint Type Description"],
    ["endpoint", "Endpoint"],
    ["affiliation", "Affiliation"],
    ["description", "Endpoint Description"],
    ["affiliation_name", "Affiliation Legal Business Name"],
    ["use_desc", "Use Description"],
    ["content_desc", "Content Description"],
    ["city", "Affiliation Address City"],
    ["state", "Affiliation Address State"],
  ] },
];

/** Write to a COPY stream, respecting backpressure. */
const write = (s: NodeJS.WritableStream, chunk: string): Promise<void> =>
  s.write(chunk) ? Promise.resolve() : new Promise((res) => s.once("drain", () => res()));
const finish = (s: NodeJS.WritableStream): Promise<void> =>
  new Promise((res, rej) => { s.on("finish", () => res()); s.on("error", rej); s.end(); });

async function loadTaxonomy(client: pg.Client): Promise<number> {
  if (!taxonomyPath) return 0;
  const rows = loadTaxonomyRows(taxonomyPath);
  const stream = client.query(copyFrom(`COPY taxonomy (code, grouping, classification, specialization, display_name, section, definition) FROM STDIN`));
  const esc = (v: string) => (v === "" ? "\\N" : v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"));
  for (const r of rows) await write(stream, [r.code, r.grouping, r.classification, r.specialization, r.display_name, r.section, r.definition].map(esc).join("\t") + "\n");
  await finish(stream);
  return rows.length;
}

async function loadProviders(client: pg.Client, sh: { i: number; n: number }): Promise<number> {
  await client.query("SET synchronous_commit = off");
  let seen = 0, copied = 0;
  let idx: ColIndex | null = null;
  const copyStream = client.query(copyFrom(`COPY providers (${PROVIDER_COLUMNS.join(", ")}) FROM STDIN`));
  const csv = fs.createReadStream(inputPath).pipe(parse({ columns: false, skip_empty_lines: true, relax_quotes: true, bom: true }));
  for await (const row of csv as AsyncIterable<string[]>) {
    if (!idx) { idx = buildColIndex(row); continue; } // header
    if (seen++ % sh.n !== sh.i) continue;             // not this shard's row
    const { provider } = mapRow(row, idx);
    if (!provider.npi) continue;
    await write(copyStream, toCopyLine(provider));
    copied++;
  }
  await finish(copyStream);
  return copied;
}

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const escCopy = (v: string | undefined) =>
  !v ? "\\N" : v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

/** COPY each side file of this release (sibling of the npidata CSV, same date range) into its table. */
async function loadSideFiles(client: pg.Client) {
  await client.query("SET synchronous_commit = off");
  const dir = path.dirname(inputPath);
  const range = path.basename(inputPath).replace(/^npidata_pfile_/, "");
  for (const spec of SIDE_FILES) {
    const file = path.join(dir, `${spec.prefix}_pfile_${range}`);
    if (!fs.existsSync(file)) { console.warn(`side: ${path.basename(file)} not found — ${spec.table} stays empty`); continue; }
    let idx: number[] | null = null, n = 0;
    const stream = client.query(copyFrom(`COPY ${spec.table} (${spec.cols.map((c) => c[0]).join(", ")}) FROM STDIN`));
    const csv = fs.createReadStream(file).pipe(parse({ columns: false, skip_empty_lines: true, relax_quotes: true, bom: true }));
    for await (const row of csv as AsyncIterable<string[]>) {
      if (!idx) {
        const header = row.map(normHeader);
        idx = spec.cols.map(([, h]) => {
          const i = header.indexOf(normHeader(h));
          if (i < 0) throw new Error(`side: column "${h}" missing from ${path.basename(file)}`);
          return i;
        });
        continue;
      }
      if (!row[idx[0]]) continue;
      await write(stream, idx.map((i) => escCopy(row[i]?.trim())).join("\t") + "\n");
      n++;
    }
    await finish(stream);
    console.log(`side: ${spec.table} ← ${n.toLocaleString()} rows`);
  }
}

async function finalize(client: pg.Client) {
  console.log("finalize: building PK + indexes (maintenance_work_mem=512MB)…");
  await client.query("SET maintenance_work_mem = '512MB'");
  await client.query(`
    ALTER TABLE providers ADD PRIMARY KEY (npi);
    CREATE INDEX idx_providers_state ON providers (practice_state);
    CREATE INDEX idx_providers_taxonomy ON providers (primary_taxonomy_code);
    CREATE INDEX idx_providers_state_taxonomy ON providers (practice_state, primary_taxonomy_code);
    ANALYZE providers; ANALYZE taxonomy;
    CREATE INDEX idx_other_names_npi ON provider_other_names (npi);
    CREATE INDEX idx_locations_npi ON provider_locations (npi);
    CREATE INDEX idx_endpoints_npi ON provider_endpoints (npi);
    ANALYZE provider_other_names; ANALYZE provider_locations; ANALYZE provider_endpoints;
  `);

  // Durability: the bulk COPY ran into UNLOGGED tables (no WAL = fast load), but Postgres TRUNCATES
  // every UNLOGGED table on crash recovery — so a host reboot silently empties the live site. Flip
  // them to LOGGED now (a one-time table rewrite that writes WAL once) so the loaded data survives
  // restarts. Done before facets.sql so the facet indexes are built on an already-logged table.
  console.log("finalize: converting providers/taxonomy to LOGGED (durable across restarts)…");
  await client.query(`ALTER TABLE providers SET LOGGED; ALTER TABLE taxonomy SET LOGGED;
    ALTER TABLE provider_other_names SET LOGGED; ALTER TABLE provider_locations SET LOGGED;
    ALTER TABLE provider_endpoints SET LOGGED;`);

  const q = async (label: string, sql: string) => { const r = await client.query(sql); console.log(`\n— ${label}`); console.table(r.rows); };
  await q("row counts", `
    SELECT (SELECT count(*) FROM providers) AS providers,
           (SELECT count(*) FROM providers WHERE deactivation_date IS NULL) AS active,
           (SELECT count(*) FROM taxonomy)  AS taxonomy_codes,
           (SELECT count(*) FROM provider_other_names) AS other_names,
           (SELECT count(*) FROM provider_locations)   AS secondary_locations,
           (SELECT count(*) FROM provider_endpoints)   AS endpoints`);
  await q("taxonomy JOIN unmatched (should be 0)", `
    SELECT count(*) FILTER (WHERE t.code IS NULL AND p.primary_taxonomy_code IS NOT NULL) AS unmatched
    FROM providers p LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code`);
  await q("exit-criterion query: TX family medicine", `
    SELECT npi, COALESCE(org_name, first_name || ' ' || last_name) AS name, practice_city
    FROM providers
    WHERE practice_state = 'TX' AND primary_taxonomy_code = '207Q00000X' AND deactivation_date IS NULL
    LIMIT 5`);

  // Facet layer: taxonomy slugs, facet indexes, and the materialized views (specialty / city /
  // specialty×city) that back the facet pages, search, and facet sitemaps. Single source: facets.sql.
  console.log("\nfinalize: applying facet layer (pipeline/facets.sql)…");
  const facetsSql = fs
    .readFileSync(fileURLToPath(new URL("./facets.sql", import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("\\")) // drop psql meta-commands (\set …) — not valid over the wire
    .join("\n");
  await client.query(facetsSql);
  await q("facet MV row counts", `
    SELECT (SELECT count(*) FROM mv_specialty_counts)      AS specialties,
           (SELECT count(*) FROM mv_city_counts)           AS cities,
           (SELECT count(*) FROM mv_specialty_city_counts) AS specialty_cities`);
}

/**
 * Month-over-month change log. NPPES publishes only the current state, so history exists only if we
 * keep it: each load diffs the new schema against live and appends to public.provider_changes, which
 * sits outside the swapped schemas and so accumulates. Can't be backfilled — started 2026-10-07.
 *
 * `release` = the new file's max(last_update_date). If live holds the same release (a re-run of the same
 * file), skip: diffing a release against itself would replace that release's real changes with nothing.
 * Deactivated records come with most fields blanked, so a (de|re)activation is recorded alone, and field
 * changes are only compared between two active records.
 */
async function doDiff(client: pg.Client, schema: string, against: string) {
  const s = qIdent(schema), live = qIdent(against);
  await client.query(PROVIDER_CHANGES_DDL);

  const rel = await client.query<{ new_rel: string | null; old_rel: string | null; has_live: boolean }>(`
    SELECT (SELECT max(last_update_date)::text FROM ${s}.providers) AS new_rel,
           (SELECT max(last_update_date)::text FROM ${live}.providers) AS old_rel,
           true AS has_live`).catch((e) => {
    if ((e as { code?: string }).code === "42P01") return { rows: [{ new_rel: null, old_rel: null, has_live: false }] };
    throw e;
  });
  const { new_rel, old_rel, has_live } = rel.rows[0];
  if (!has_live || !new_rel || !old_rel) { console.log("diff: no live schema to compare against — skipped"); return; }
  if (new_rel <= old_rel) { console.log(`diff: ${schema} release ${new_rel} is not newer than live ${old_rel} — skipped`); return; }

  const addr = (t: string) => `NULLIF(concat_ws(', ', ${t}.practice_addr1, ${t}.practice_addr2, ${t}.practice_city, ${t}.practice_state, ${t}.practice_zip), '')`;
  const name = (t: string) => `NULLIF(COALESCE(${t}.org_name, concat_ws(' ', ${t}.first_name, ${t}.middle_name, ${t}.last_name)), '')`;
  const lic = (t: string) => `NULLIF(concat_ws(' ', ${t}.license_number, ${t}.license_state), '')`;
  // Single-threaded, modest work_mem: a parallel hash join at 256MB/worker overflowed postgres's 1GB
  // /dev/shm (2026-10-07), the resource the live sites share. Serial takes ~25s on 9.8M rows.
  await client.query("SET max_parallel_workers_per_gather = 0; SET work_mem = '64MB'");
  await client.query("BEGIN");
  await client.query(`DELETE FROM public.provider_changes WHERE release = $1`, [new_rel]);
  const ins = await client.query(`
    INSERT INTO public.provider_changes (release, npi, change, old_value, new_value)
    SELECT $1::date, n.npi, 'added', NULL, NULL FROM ${s}.providers n
     WHERE NOT EXISTS (SELECT 1 FROM ${live}.providers o WHERE o.npi = n.npi)
    UNION ALL
    SELECT $1::date, o.npi, 'removed', NULL, NULL FROM ${live}.providers o
     WHERE NOT EXISTS (SELECT 1 FROM ${s}.providers n WHERE n.npi = o.npi)
    UNION ALL
    SELECT $1::date, n.npi, v.change, v.old_value, v.new_value
      FROM ${s}.providers n JOIN ${live}.providers o USING (npi)
      CROSS JOIN LATERAL (VALUES
        ('deactivated', NULL, n.deactivation_date::text,
           o.deactivation_date IS NULL AND n.deactivation_date IS NOT NULL),
        ('reactivated', o.deactivation_date::text, NULL,
           o.deactivation_date IS NOT NULL AND n.deactivation_date IS NULL),
        ('practice_address', ${addr("o")}, ${addr("n")}, ${addr("o")} IS DISTINCT FROM ${addr("n")}),
        ('practice_phone', o.practice_phone, n.practice_phone, o.practice_phone IS DISTINCT FROM n.practice_phone),
        ('primary_taxonomy', o.primary_taxonomy_code, n.primary_taxonomy_code,
           o.primary_taxonomy_code IS DISTINCT FROM n.primary_taxonomy_code),
        ('name', ${name("o")}, ${name("n")}, ${name("o")} IS DISTINCT FROM ${name("n")}),
        ('credential', o.credential, n.credential, o.credential IS DISTINCT FROM n.credential),
        ('license', ${lic("o")}, ${lic("n")}, ${lic("o")} IS DISTINCT FROM ${lic("n")})
      ) AS v(change, old_value, new_value, changed)
     WHERE v.changed
       AND (v.change IN ('deactivated', 'reactivated')
            OR (o.deactivation_date IS NULL AND n.deactivation_date IS NULL))`, [new_rel]);
  await client.query("COMMIT");
  const sum = await client.query(`SELECT change, count(*)::int AS n FROM public.provider_changes WHERE release = $1 GROUP BY 1 ORDER BY 2 DESC`, [new_rel]);
  console.log(`diff: release ${new_rel} vs live ${old_rel} → ${ins.rowCount?.toLocaleString()} changes`);
  console.table(sum.rows);
}

/**
 * Atomically promote a freshly-built schema to "live" — the zero-downtime swap. All renames run in
 * one transaction, so readers see the switch instantly while any in-flight query finishes against
 * the old objects. The previous live schema is retained as "old" until the next swap, giving a
 * one-generation rollback. Also pins the database's default search_path to "live, public" (new
 * connections only; harmless before the first swap, when "live" doesn't exist yet and queries fall
 * back to "public").
 */
async function doSwap(client: pg.Client, schema: string) {
  const s = qIdent(schema);
  await client.query(`ALTER DATABASE ${qIdent(dbName)} SET search_path = live, public`);
  await client.query("SET lock_timeout = '30s'"); // fail fast (and roll back) rather than block reads forever
  await client.query(`
    BEGIN;
    DROP SCHEMA IF EXISTS old CASCADE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'live') THEN
        EXECUTE 'ALTER SCHEMA live RENAME TO old';
      END IF;
    END $$;
    ALTER SCHEMA ${s} RENAME TO live;
    COMMIT;
  `);
  console.log(`swap: promoted schema "${schema}" → live (previous live kept as "old" for rollback)`);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  if (diffSchema) {
    console.log(`connected → ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}  [diff ${diffSchema} vs ${diffAgainst}]`);
    await doDiff(client, diffSchema, diffAgainst);
    await client.end();
    console.log("done.");
    return;
  }

  if (swapSchema) {
    console.log(`connected → ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}  [swap ${swapSchema}→live]`);
    await doSwap(client, swapSchema);
    await client.end();
    console.log("done.");
    return;
  }

  const role = shard ? `load ${shard.i}/${shard.n}` : doSide && !doPrepare && !doFinalize ? "side" : doPrepare && doFinalize ? "all" : doPrepare ? "prepare" : doFinalize ? "finalize" : "all";
  console.log(`connected → ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}  [${role}${targetSchema ? ` schema=${targetSchema}` : ""}]`);
  const t0 = Date.now();

  // Build everything in the target schema (e.g. "staging") so a later --swap can promote it without
  // ever touching the live tables. Unqualified DDL/COPY/facets.sql then all resolve to this schema.
  if (targetSchema) {
    if (runPrepare) await client.query(`CREATE SCHEMA IF NOT EXISTS ${qIdent(targetSchema)}`);
    await client.query(`SET search_path TO ${qIdent(targetSchema)}`);
  }

  if (runPrepare) {
    await client.query(DDL);
    const n = await loadTaxonomy(client);
    console.log(`prepared schema + taxonomy (${n.toLocaleString()} codes)`);
  }
  if (shard) {
    const n = await loadProviders(client, shard);
    const secs = ((Date.now() - t0) / 1000);
    console.log(`shard ${shard.i}/${shard.n}: COPYed ${n.toLocaleString()} rows in ${secs.toFixed(1)}s (${Math.round(n / secs).toLocaleString()} rows/s)`);
  }
  if (runSide) await loadSideFiles(client);
  if (runFinalize) await finalize(client);

  await client.end();
  console.log("done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
