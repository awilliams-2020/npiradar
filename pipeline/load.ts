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
 *   --finalize             add PK + indexes + ANALYZE, then run verification queries
 *
 * Usage:
 *   tsx pipeline/load.ts <npidata.csv> --taxonomy <nucc.csv>        # single-process, everything
 *   (parallel fan-out is driven by pipeline/load-parallel.ts)
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { mapRow, buildColIndex, toCopyLine, loadTaxonomyRows, PROVIDER_COLUMNS, type ColIndex } from "./lib/provider.ts";

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

// mode resolution: any explicit mode flag disables the implicit "do everything" run
const doPrepare = args.includes("--prepare");
const doFinalize = args.includes("--finalize");
const shardSpec = flag("--shard");
const explicit = doPrepare || doFinalize || shardSpec !== undefined || swapSchema !== undefined;
const runPrepare = doPrepare || !explicit;
const runFinalize = doFinalize || !explicit;
const shard = shardSpec
  ? (() => { const [i, n] = shardSpec.split("/").map(Number); if (!(n >= 1 && i >= 0 && i < n)) throw new Error(`bad --shard ${shardSpec}`); return { i, n }; })()
  : explicit ? null : { i: 0, n: 1 };

if (!swapSchema && (!inputPath || inputPath.startsWith("--"))) {
  console.error("usage: tsx pipeline/load.ts <npidata.csv> --taxonomy <nucc.csv> [--prepare|--shard i/N|--finalize] [--schema NAME] [--swap NAME]");
  process.exit(1);
}

const DDL = `
DROP TABLE IF EXISTS providers CASCADE;  -- CASCADE: the facet materialized views depend on these
DROP TABLE IF EXISTS taxonomy CASCADE;

CREATE UNLOGGED TABLE taxonomy (
  code text PRIMARY KEY, grouping text, classification text,
  specialization text, display_name text, section text
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
`;

/** Write to a COPY stream, respecting backpressure. */
const write = (s: NodeJS.WritableStream, chunk: string): Promise<void> =>
  s.write(chunk) ? Promise.resolve() : new Promise((res) => s.once("drain", () => res()));
const finish = (s: NodeJS.WritableStream): Promise<void> =>
  new Promise((res, rej) => { s.on("finish", () => res()); s.on("error", rej); s.end(); });

async function loadTaxonomy(client: pg.Client): Promise<number> {
  if (!taxonomyPath) return 0;
  const rows = loadTaxonomyRows(taxonomyPath);
  const stream = client.query(copyFrom(`COPY taxonomy (code, grouping, classification, specialization, display_name, section) FROM STDIN`));
  const esc = (v: string) => (v === "" ? "\\N" : v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"));
  for (const r of rows) await write(stream, [r.code, r.grouping, r.classification, r.specialization, r.display_name, r.section].map(esc).join("\t") + "\n");
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

async function finalize(client: pg.Client) {
  console.log("finalize: building PK + indexes (maintenance_work_mem=512MB)…");
  await client.query("SET maintenance_work_mem = '512MB'");
  await client.query(`
    ALTER TABLE providers ADD PRIMARY KEY (npi);
    CREATE INDEX idx_providers_state ON providers (practice_state);
    CREATE INDEX idx_providers_taxonomy ON providers (primary_taxonomy_code);
    CREATE INDEX idx_providers_state_taxonomy ON providers (practice_state, primary_taxonomy_code);
    ANALYZE providers; ANALYZE taxonomy;
  `);

  // Durability: the bulk COPY ran into UNLOGGED tables (no WAL = fast load), but Postgres TRUNCATES
  // every UNLOGGED table on crash recovery — so a host reboot silently empties the live site. Flip
  // them to LOGGED now (a one-time table rewrite that writes WAL once) so the loaded data survives
  // restarts. Done before facets.sql so the facet indexes are built on an already-logged table.
  console.log("finalize: converting providers/taxonomy to LOGGED (durable across restarts)…");
  await client.query(`ALTER TABLE providers SET LOGGED; ALTER TABLE taxonomy SET LOGGED;`);

  const q = async (label: string, sql: string) => { const r = await client.query(sql); console.log(`\n— ${label}`); console.table(r.rows); };
  await q("row counts", `
    SELECT (SELECT count(*) FROM providers) AS providers,
           (SELECT count(*) FROM providers WHERE deactivation_date IS NULL) AS active,
           (SELECT count(*) FROM taxonomy)  AS taxonomy_codes`);
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

  if (swapSchema) {
    console.log(`connected → ${DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}  [swap ${swapSchema}→live]`);
    await doSwap(client, swapSchema);
    await client.end();
    console.log("done.");
    return;
  }

  const role = shard ? `load ${shard.i}/${shard.n}` : doPrepare && doFinalize ? "all" : doPrepare ? "prepare" : doFinalize ? "finalize" : "all";
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
  if (runFinalize) await finalize(client);

  await client.end();
  console.log("done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
