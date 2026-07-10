/**
 * pipeline/lib/provider.ts — shared NPPES row mapping.
 *
 * One source of truth for the column mapping + the data fixes the Phase 0 spike surfaced,
 * imported by both parse.ts (inspect/stats) and load.ts (COPY into Postgres) so the two can
 * never drift. Pure functions only — no DB, no streaming.
 *
 * Parsing is positional (csv-parse `columns:false`): we resolve column indices once from the
 * header via buildColIndex(), then read by integer offset per row — far cheaper than building a
 * ~330-key object per row. buildColIndex() also throws if an expected column is missing, so a
 * future NPPES schema change fails loudly instead of silently nulling.
 */
import fs from "node:fs";
import { parse as parseSync } from "csv-parse/sync";

// ---- field cleaners (the gotchas) -------------------------------------------
/** Trim; treat empty and the NPPES "<UNAVAIL>" sentinel as null. */
export function clean(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" || t === "<UNAVAIL>" ? null : t;
}

/** NPPES dates are MM/DD/YYYY → ISO YYYY-MM-DD (null if absent/malformed). */
export function toIsoDate(v: string | undefined): string | null {
  const t = clean(v);
  if (!t) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// ---- the trimmed provider shape we load into Postgres -----------------------
export interface Provider {
  npi: string;
  entity_type: "individual" | "org" | null;
  org_name: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  credential: string | null;
  sex: string | null;
  practice_addr1: string | null;
  practice_addr2: string | null;
  practice_city: string | null;
  practice_state: string | null;
  practice_zip: string | null;
  practice_phone: string | null;
  primary_taxonomy_code: string | null;
  enumeration_date: string | null;
  last_update_date: string | null;
  deactivation_date: string | null;
  is_sole_proprietor: boolean | null;
  license_number: string | null;
  license_state: string | null;
}

/** Column order for the providers table + COPY stream — keep these in lockstep. */
export const PROVIDER_COLUMNS: (keyof Provider)[] = [
  "npi", "entity_type", "org_name", "last_name", "first_name", "middle_name",
  "credential", "sex", "practice_addr1", "practice_addr2", "practice_city",
  "practice_state", "practice_zip", "practice_phone", "primary_taxonomy_code",
  "enumeration_date", "last_update_date", "deactivation_date", "is_sole_proprietor",
  "license_number", "license_state",
];

// ---- positional column index, resolved once from the header row -------------
export interface ColIndex {
  npi: number; entityType: number; orgName: number; lastName: number; firstName: number;
  middleName: number; credential: number; sex: number;
  pAddr1: number; pAddr2: number; pCity: number; pState: number; pZip: number; pPhone: number;
  mailState: number; enumDate: number; lastUpdate: number; deactDate: number; soleProp: number;
  taxoCode: number[]; taxoSwitch: number[]; license: number[]; licenseState: number[];
}

export function buildColIndex(header: string[]): ColIndex {
  const at = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`NPPES schema: expected column not found: "${name}"`);
    return i;
  };
  return {
    npi: at("NPI"),
    entityType: at("Entity Type Code"),
    orgName: at("Provider Organization Name (Legal Business Name)"),
    lastName: at("Provider Last Name (Legal Name)"),
    firstName: at("Provider First Name"),
    middleName: at("Provider Middle Name"),
    credential: at("Provider Credential Text"),
    sex: at("Provider Sex Code"),
    pAddr1: at("Provider First Line Business Practice Location Address"),
    pAddr2: at("Provider Second Line Business Practice Location Address"),
    pCity: at("Provider Business Practice Location Address City Name"),
    pState: at("Provider Business Practice Location Address State Name"),
    pZip: at("Provider Business Practice Location Address Postal Code"),
    pPhone: at("Provider Business Practice Location Address Telephone Number"),
    mailState: at("Provider Business Mailing Address State Name"),
    enumDate: at("Provider Enumeration Date"),
    lastUpdate: at("Last Update Date"),
    deactDate: at("NPI Deactivation Date"),
    soleProp: at("Is Sole Proprietor"),
    taxoCode: Array.from({ length: 15 }, (_, k) => at(`Healthcare Provider Taxonomy Code_${k + 1}`)),
    taxoSwitch: Array.from({ length: 15 }, (_, k) => at(`Healthcare Provider Primary Taxonomy Switch_${k + 1}`)),
    // License number + issuing state are per-taxonomy-slot, so we read them from the same slot we
    // pick as primary (see pickPrimaryTaxonomy).
    license: Array.from({ length: 15 }, (_, k) => at(`Provider License Number_${k + 1}`)),
    licenseState: Array.from({ length: 15 }, (_, k) => at(`Provider License Number State Code_${k + 1}`)),
  };
}

/** Resolve the primary taxonomy from the 15 slots: prefer the Y switch, else slot 1. Returns the
 * winning slot index (-1 if none) so the caller can read the license from that same slot. */
function pickPrimaryTaxonomy(row: string[], idx: ColIndex): { code: string | null; slot: number; hadSwitch: boolean; anyCode: boolean } {
  let firstCode: string | null = null;
  let firstSlot = -1;
  for (let i = 0; i < 15; i++) {
    const code = clean(row[idx.taxoCode[i]]);
    if (!code) continue;
    if (firstCode === null) { firstCode = code; firstSlot = i; }
    if (row[idx.taxoSwitch[i]]?.trim() === "Y") return { code, slot: i, hadSwitch: true, anyCode: true };
  }
  return { code: firstCode, slot: firstSlot, hadSwitch: false, anyCode: firstCode !== null };
}

/** Map one raw npidata row (array) → Provider. Returns side facts the callers use for stats. */
export function mapRow(row: string[], idx: ColIndex): { provider: Provider; mailingState: string | null; noSwitch: boolean } {
  const etc = row[idx.entityType]?.trim();
  const { code, slot, hadSwitch, anyCode } = pickPrimaryTaxonomy(row, idx);
  const sole = clean(row[idx.soleProp]);
  const provider: Provider = {
    npi: row[idx.npi]?.trim(),
    entity_type: etc === "1" ? "individual" : etc === "2" ? "org" : null,
    org_name: clean(row[idx.orgName]),
    last_name: clean(row[idx.lastName]),
    first_name: clean(row[idx.firstName]),
    middle_name: clean(row[idx.middleName]),
    credential: clean(row[idx.credential]),
    sex: clean(row[idx.sex]),
    practice_addr1: clean(row[idx.pAddr1]),
    practice_addr2: clean(row[idx.pAddr2]),
    practice_city: clean(row[idx.pCity]),
    practice_state: clean(row[idx.pState]),
    practice_zip: clean(row[idx.pZip]),
    practice_phone: clean(row[idx.pPhone]),
    primary_taxonomy_code: code,
    enumeration_date: toIsoDate(row[idx.enumDate]),
    last_update_date: toIsoDate(row[idx.lastUpdate]),
    deactivation_date: toIsoDate(row[idx.deactDate]),
    is_sole_proprietor: sole === null ? null : sole === "Y",
    license_number: slot >= 0 ? clean(row[idx.license[slot]]) : null,
    license_state: slot >= 0 ? clean(row[idx.licenseState[slot]]) : null,
  };
  return { provider, mailingState: clean(row[idx.mailState]), noSwitch: anyCode && !hadSwitch };
}

// ---- Postgres COPY (TEXT format) helpers ------------------------------------
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}
function field(v: string | boolean | null): string {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "boolean") return v ? "t" : "f";
  return esc(v);
}
/** One tab-separated COPY line (TEXT format) for a Provider, columns in PROVIDER_COLUMNS order. */
export function toCopyLine(p: Provider): string {
  return PROVIDER_COLUMNS.map((c) => field(p[c] as string | boolean | null)).join("\t") + "\n";
}

// ---- NUCC taxonomy ----------------------------------------------------------
export interface TaxoRow { code: string; grouping: string; classification: string; specialization: string; display_name: string; section: string }

/** Read the NUCC taxonomy CSV into typed rows (small file — sync is fine). */
export function loadTaxonomyRows(path: string): TaxoRow[] {
  const rows: Record<string, string>[] = parseSync(fs.readFileSync(path), { columns: true, skip_empty_lines: true, bom: true });
  return rows.map((r) => ({
    code: r["Code"],
    grouping: r["Grouping"] ?? "",
    classification: r["Classification"] ?? "",
    specialization: r["Specialization"] ?? "",
    display_name: r["Display Name"] || r["Classification"] || "",
    section: r["Section"] ?? "",
  }));
}

/** Map of code → display label, for in-memory enrichment (parse.ts). */
export function taxonomyMap(path: string): Map<string, string> {
  return new Map(loadTaxonomyRows(path).map((t) => [t.code, t.display_name]));
}
