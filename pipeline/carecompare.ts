/**
 * pipeline/carecompare.ts — CMS Care Compare ("Doctors and Clinicians") files, from the provider-data catalog:
 *
 *   care_compare_hospitals     Hospital General Information (~5.4k hospitals), for affiliation names.
 *                              → public.cc_hospitals, keyed by CCN (CMS certification number).
 *   care_compare_affiliations  Facility Affiliation (~2.25M rows, 941k NPIs): the facilities a clinician works
 *                              at, by type + CCN. The file has no names; hospitals (85% of rows) are named via
 *                              cc_hospitals (99% match), other types show type + CCN.
 *                              → public.cc_affiliations
 *   care_compare_clinicians    National Downloadable File (~840 MB): one row per clinician × group × address.
 *                              → public.cc_clinicians, one row per NPI: medical school (CMS writes "OTHER" for
 *                                ~60%, stored as null), graduation year, specialties, telehealth, and Medicare
 *                                assignment ('Y' accepts on every enrollment, 'M' may not on some).
 *                              → public.cc_groups, one row per NPI × group practice (PAC ID): name, size, cities.
 *
 * Loading, swap and skip-if-loaded: pipeline/lib/cms-csv.ts (shared with medicare.ts). No history kept.
 * Called by refresh-server.ts on its 6-hourly check. By hand:
 *   docker exec npiradar-refresh npx tsx pipeline/carecompare.ts [hospitals|affiliations|clinicians]
 *
 * Env: DATABASE_URL; optional REFRESH_SECRET + APP_INTERNAL_URL to purge the cached static pages after a change.
 */
import { runDatasets, selectDatasets, type CsvDataset } from "./lib/cms-csv.ts";

const ITEM = (id: string) => `https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/${id}`;

const DATASETS: (CsvDataset & { catalogId: string })[] = [
  {
    key: "care_compare_hospitals",
    catalogId: "xubh-q36u",
    minRows: 4_000, // 5,419 (2026-07)
    encoding: "latin1",
    keyPattern: /^[0-9A-Z]{6}$/,
    cols: [
      { header: "Facility ID", name: "ccn", type: "text" },
      { header: "Facility Name", name: "name", type: "text" },
      { header: "City/Town", name: "city", type: "text" },
      { header: "State", name: "state", type: "text" },
      { header: "Hospital Type", name: "hospital_type", type: "text" },
      { header: "Hospital overall rating", name: "overall_rating", type: "int" }, // "Not Available" → null
    ],
    outputs: [{ table: "cc_hospitals", key: "ccn", build: `SELECT DISTINCT ON (ccn) * FROM stage ORDER BY ccn` }],
  },
  {
    key: "care_compare_affiliations",
    catalogId: "27ea-46a8",
    minRows: 1_500_000, // ~2.25M (2026-08)
    encoding: "latin1",
    cols: [
      { header: "NPI", name: "npi", type: "text" },
      { header: "facility_type", name: "facility_type", type: "text" },
      { header: "Facility Affiliations Certification Number", name: "ccn", type: "text" },
    ],
    outputs: [{ table: "cc_affiliations", build: `SELECT DISTINCT npi, facility_type, ccn FROM stage WHERE ccn IS NOT NULL` }],
  },
  {
    key: "care_compare_clinicians",
    catalogId: "mj5m-pzi6",
    minRows: 1_500_000,
    encoding: "latin1",
    cols: [
      { header: "NPI", name: "npi", type: "text" },
      { header: "Med_sch", name: "med_school", type: "text" },
      { header: "Grd_yr", name: "grad_year", type: "int" },
      { header: "pri_spec", name: "primary_specialty", type: "text" },
      { header: "sec_spec_all", name: "secondary_specialties", type: "text" },
      { header: "Telehlth", name: "telehealth", type: "bool" }, // 'Y' or blank
      { header: "ind_assgn", name: "assignment", type: "text" }, // 'Y' accepts, 'M' may accept
      { header: "org_pac_id", name: "org_pac_id", type: "text" },
      { header: "Facility Name", name: "group_name", type: "text" },
      { header: "num_org_mem", name: "group_members", type: "int" },
      { header: "City/Town", name: "city", type: "text" },
      { header: "State", name: "state", type: "text" },
    ],
    outputs: [
      {
        table: "cc_clinicians",
        build: `SELECT npi,
                       max(med_school) FILTER (WHERE med_school <> 'OTHER') AS med_school,
                       max(grad_year) AS grad_year,
                       max(primary_specialty) AS primary_specialty,
                       max(secondary_specialties) AS secondary_specialties,
                       coalesce(bool_or(telehealth), false) AS telehealth,
                       CASE WHEN bool_and(assignment = 'Y') THEN 'Y' WHEN bool_or(assignment IN ('Y', 'M')) THEN 'M' END AS assignment
                  FROM stage GROUP BY npi`,
      },
      {
        table: "cc_groups",
        build: `SELECT npi, org_pac_id, max(group_name) AS group_name, max(group_members) AS group_members,
                       array_agg(DISTINCT initcap(city) || ', ' || state ORDER BY initcap(city) || ', ' || state)
                         FILTER (WHERE city IS NOT NULL) AS cities
                  FROM stage WHERE org_pac_id IS NOT NULL GROUP BY npi, org_pac_id`,
      },
    ],
  },
];

/** Dataset key → current CSV URL, from each dataset's provider-data catalog entry. */
async function catalog(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of DATASETS) {
    const res = await fetch(ITEM(d.catalogId), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) { console.error(`carecompare ${d.key}: catalog HTTP ${res.status}`); continue; }
    const item = (await res.json()) as { distribution?: { downloadURL?: string }[] };
    const url = item.distribution?.map((x) => x.downloadURL).find((u) => u?.toLowerCase().endsWith(".csv"));
    if (url) out.set(d.key, url);
  }
  return out;
}

async function main() {
  const sets = selectDatasets(DATASETS, process.argv.slice(2));
  await runDatasets("carecompare", sets, await catalog());
}

main().catch((e) => { console.error(`carecompare: FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
