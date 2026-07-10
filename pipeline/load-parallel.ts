/**
 * pipeline/load-parallel.ts — fan-out orchestrator for load.ts.
 *
 * Phase 1: one `--prepare` (DDL + taxonomy).
 * Phase 2: N concurrent `--shard i/N` workers, each its own process (own core for the JS parse)
 *          and own connection + COPY stream into the shared UNLOGGED providers table.
 * Phase 3: one `--finalize` (PK + indexes + ANALYZE + verification).
 *
 * Default 4 workers — deliberately below the 12 cores, since this Postgres also serves live
 * sites and the write path becomes the shared bottleneck before CPU does.
 *
 * Usage:
 *   tsx pipeline/load-parallel.ts <npidata.csv> --taxonomy <nucc.csv> [--workers 4]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const inputPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true) ?? args[0];
const taxonomyPath = flag("--taxonomy");
const workers = Number(flag("--workers") ?? 4);
// Zero-downtime: build into --schema <name>, then --swap promotes it to "live" after a clean finalize.
const targetSchema = flag("--schema");
const doSwap = args.includes("--swap");

if (!inputPath || inputPath.startsWith("--")) {
  console.error("usage: tsx pipeline/load-parallel.ts <npidata.csv> --taxonomy <nucc.csv> [--workers N]");
  process.exit(1);
}

const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const loadScript = fileURLToPath(new URL("./load.ts", import.meta.url));

function run(label: string, extra: string[]): Promise<void> {
  const schemaArgs = targetSchema ? ["--schema", targetSchema] : [];
  const cliArgs = [loadScript, inputPath, ...(taxonomyPath ? ["--taxonomy", taxonomyPath] : []), ...schemaArgs, ...extra];
  return new Promise((res, rej) => {
    const child = spawn(tsxBin, cliArgs, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    child.on("error", rej);
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${label} exited with code ${code}`))));
  });
}

async function main() {
  const t0 = Date.now();
  console.log(`[1/3] prepare`);
  await run("prepare", ["--prepare"]);

  console.log(`[2/3] loading with ${workers} parallel workers`);
  await Promise.all(
    Array.from({ length: workers }, (_, i) => run(`shard ${i}/${workers}`, ["--shard", `${i}/${workers}`])),
  );

  console.log(`[3/3] finalize`);
  await run("finalize", ["--finalize"]);

  // Promote the freshly-built schema to "live" only after a clean finalize — never expose a
  // half-loaded schema. (load.ts --swap ignores the CSV/--schema passthrough and just renames.)
  if (doSwap) {
    const s = targetSchema ?? "staging";
    console.log(`[swap] promoting schema "${s}" → live`);
    await run("swap", ["--swap", s]);
  }

  console.log(`\nall done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
