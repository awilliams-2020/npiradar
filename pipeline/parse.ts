/**
 * pipeline/parse.ts — Phase 0 streaming inspector for the NPPES dissemination file.
 *
 * Streams npidata_pfile_*.csv, maps each row via lib/provider.ts, enriches the primary
 * taxonomy against the NUCC code set, and prints samples + data-quality stats. Never holds
 * the whole file in memory, so the same code handles the 9 GB monthly, not just the weekly.
 *
 * Usage:
 *   tsx pipeline/parse.ts <npidata.csv> [--taxonomy nucc.csv] [--out parsed.ndjson] [--limit N]
 */
import fs from "node:fs";
import { parse } from "csv-parse";
import { mapRow, buildColIndex, taxonomyMap, type ColIndex, type Provider } from "./lib/provider.ts";

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const inputPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true) ?? args[0];
const taxonomyPath = flag("--taxonomy");
const outPath = flag("--out");
const limit = flag("--limit") ? Number(flag("--limit")) : Infinity;

if (!inputPath || inputPath.startsWith("--")) {
  console.error("usage: tsx pipeline/parse.ts <npidata.csv> [--taxonomy nucc.csv] [--out file.ndjson] [--limit N]");
  process.exit(1);
}

async function main() {
  const taxo = taxonomyPath ? taxonomyMap(taxonomyPath) : new Map<string, string>();
  if (taxonomyPath) console.error(`loaded ${taxo.size} NUCC taxonomy codes`);

  const out = outPath ? fs.createWriteStream(outPath) : null;
  const t0 = Date.now();

  const stats = {
    rows: 0, individuals: 0, orgs: 0, otherEntity: 0, missingNpi: 0,
    missingPracticeState: 0, practiceStateDiffersFromMailing: 0,
    deactivated: 0, noPrimarySwitch: 0, taxonomyJoinMisses: 0,
  };
  const stateCounts = new Map<string, number>();
  const taxoCounts = new Map<string, { label: string; n: number }>();
  const missedCodes = new Set<string>();
  const samples: (Provider & { primary_taxonomy_label: string | null })[] = [];

  const parser = fs.createReadStream(inputPath).pipe(
    parse({ columns: false, skip_empty_lines: true, relax_quotes: true, bom: true }),
  );

  let idx: ColIndex | null = null;
  for await (const row of parser as AsyncIterable<string[]>) {
    if (!idx) { idx = buildColIndex(row); continue; } // first row is the header
    if (stats.rows >= limit) { parser.destroy(); break; }
    stats.rows++;
    const { provider: p, mailingState, noSwitch } = mapRow(row, idx);
    const label = p.primary_taxonomy_code ? taxo.get(p.primary_taxonomy_code) ?? null : null;
    const taxoMiss = p.primary_taxonomy_code !== null && taxonomyPath !== undefined && label === null;

    if (!p.npi) stats.missingNpi++;
    if (p.entity_type === "individual") stats.individuals++;
    else if (p.entity_type === "org") stats.orgs++;
    else stats.otherEntity++;
    if (!p.practice_state) stats.missingPracticeState++;
    if (p.practice_state && mailingState && p.practice_state !== mailingState) stats.practiceStateDiffersFromMailing++;
    if (p.deactivation_date) stats.deactivated++;
    if (noSwitch) stats.noPrimarySwitch++;
    if (taxoMiss) { stats.taxonomyJoinMisses++; if (p.primary_taxonomy_code) missedCodes.add(p.primary_taxonomy_code); }

    if (p.practice_state) stateCounts.set(p.practice_state, (stateCounts.get(p.practice_state) ?? 0) + 1);
    if (p.primary_taxonomy_code) {
      const e = taxoCounts.get(p.primary_taxonomy_code) ?? { label: label ?? "(unmapped)", n: 0 };
      e.n++; taxoCounts.set(p.primary_taxonomy_code, e);
    }

    if (samples.length < 3) samples.push({ ...p, primary_taxonomy_label: label });
    if (out) out.write(JSON.stringify(p) + "\n");
  }
  if (out) out.end();

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const top = (m: Map<string, any>, n: number, val: (v: any) => number) =>
    [...m.entries()].sort((a, b) => val(b[1]) - val(a[1])).slice(0, n);

  console.log("\n===== SAMPLE MAPPED PROVIDERS =====");
  for (const s of samples) console.log(JSON.stringify(s, null, 2));

  console.log("\n===== STATS =====");
  console.log(`parsed ${stats.rows.toLocaleString()} rows in ${secs}s (${Math.round(stats.rows / Number(secs)).toLocaleString()} rows/s)`);
  console.table({
    individuals: stats.individuals, orgs: stats.orgs, otherEntity: stats.otherEntity,
    missingNpi: stats.missingNpi, missingPracticeState: stats.missingPracticeState,
    practiceStateDiffersFromMailing: stats.practiceStateDiffersFromMailing,
    deactivated: stats.deactivated, noPrimarySwitch_usedSlot1: stats.noPrimarySwitch,
    taxonomyJoinMisses: stats.taxonomyJoinMisses,
  });

  console.log("\n----- top 10 practice states -----");
  for (const [st, n] of top(stateCounts, 10, (v) => v)) console.log(`  ${st}  ${n.toLocaleString()}`);

  console.log("\n----- top 10 primary taxonomies (join check) -----");
  for (const [code, e] of top(taxoCounts, 10, (v) => v.n)) console.log(`  ${code}  ${e.n.toLocaleString().padStart(6)}  ${e.label}`);

  if (missedCodes.size) console.log(`\n⚠ ${missedCodes.size} taxonomy codes not in NUCC set:`, [...missedCodes].slice(0, 20).join(", "));
  else if (taxonomyPath) console.log("\n✓ every primary taxonomy code resolved against the NUCC set");
  if (outPath) console.log(`\nwrote NDJSON → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
