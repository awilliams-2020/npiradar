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
 *   public.medicare_revalidation     Revalidation Due Date List, monthly. One row per enrollment. Only ~10%
 *                                    carry a due date (CMS shows "TBD" until it sets one); no history kept.
 *
 * Together with the OIG flag these answer "can this NPI bill or order for Medicare?".
 *
 * Each file is the newest CSV in CMS's catalog (data.json); loading, the swap, history and the skip-if-loaded
 * check are in pipeline/lib/cms-csv.ts, shared with carecompare.ts.
 *
 * Called by refresh-server.ts on its 6-hourly check. By hand:
 *   docker exec npiradar-refresh npx tsx pipeline/medicare.ts            # every dataset, if changed
 *   docker exec npiradar-refresh npx tsx pipeline/medicare.ts opt_out    # just these
 *
 * Env: DATABASE_URL; optional REFRESH_SECRET + APP_INTERNAL_URL to purge the cached static pages after a change.
 */
import { runDatasets, selectDatasets, type CsvDataset } from "./lib/cms-csv.ts";

const CATALOG = "https://data.cms.gov/data.json";

// One output table per file, named after the dataset key.
type Dataset = Omit<CsvDataset, "outputs"> & {
  title: string; // catalog title before " : <date>"
  build: string; // SELECT over `stage`
  history?: (cur: string, next: string) => string;
};

const DATASETS: Dataset[] = [
  {
    key: "medicare_enrollment",
    title: "Medicare Fee-For-Service Public Provider Enrollment",
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
  {
    key: "medicare_revalidation",
    title: "Revalidation Due Date List",
    minRows: 2_000_000, // ~2.96M enrollments, 2.46M NPIs (2026-10); 282k with a due date
    encoding: "latin1", // not UTF-8, like the enrollment file
    cols: [
      { header: "National Provider Identifier", name: "npi", type: "text" },
      { header: "Enrollment ID", name: "enrollment_id", type: "text" },
      { header: "Enrollment State Code", name: "state", type: "text" },
      { header: "Provider Type Text", name: "provider_type", type: "text" },
      { header: "Enrollment Specialty", name: "specialty", type: "text" },
      { header: "Revalidation Due Date", name: "due_date", type: "date" },
      { header: "Adjusted Due Date", name: "adjusted_due_date", type: "date" },
    ],
    build: `SELECT DISTINCT npi, enrollment_id, state, provider_type, specialty, due_date, adjusted_due_date FROM stage`,
  },
];

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

async function main() {
  const sets = selectDatasets(DATASETS.map((d) => ({ ...d, outputs: [{ table: d.key, build: d.build, history: d.history }] })), process.argv.slice(2));
  const byTitle = await catalog();
  const urls = new Map(DATASETS.flatMap((d) => (byTitle.has(d.title) ? [[d.key, byTitle.get(d.title)!] as const] : [])));
  await runDatasets("medicare", sets, urls);
}

main().catch((e) => { console.error(`medicare: FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
