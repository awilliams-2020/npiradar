import { query } from "@/lib/db";
import { isValidNpi } from "@/lib/npi";
import { fullName, titleCase, formatZip, formatPhone } from "@/lib/format";
import { oigSection, oigTypeLabel, OIG_VERIFY_URL } from "@/lib/oig";
import { licenseVerification } from "@/lib/license";

// Single source of truth for the provider-detail row — used by the /npi/[npi] page and the
// public /api/npi/[npi] JSON endpoint so they can't drift.

export interface ProviderRow {
  npi: string;
  entity_type: "individual" | "org" | null;
  org_name: string | null;
  first_name: string | null;
  last_name: string | null;
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
  specialty: string | null;
  specialty_slug: string | null;
  classification: string | null;
  grouping: string | null;
  oig_excluded: boolean; // on the HHS OIG exclusion list (pipeline/leie.ts), matched by NPI
  // CMS Medicare files (pipeline/medicare.ts), matched by NPI
  medicare_enrolled: boolean; // in the public provider enrollment file
  medicare_opted_out: boolean; // an opt-out affidavit that hasn't ended
  medicare_order_refer: string[] | null; // programs it may order/refer for; null = not on the list
  medicare_revalidation_due: string | null; // earliest revalidation due date CMS has set, YYYY-MM-DD
}

// Medicare status columns, shared by getProvider and getProviders so a bulk row matches a single lookup.
const MEDICARE_COLS = `
            EXISTS (SELECT 1 FROM public.medicare_enrollment m WHERE m.npi = p.npi) AS medicare_enrolled,
            EXISTS (SELECT 1 FROM public.medicare_opt_out o WHERE o.npi = p.npi AND o.end_date >= current_date) AS medicare_opted_out,
            (SELECT array_remove(ARRAY[CASE WHEN r.part_b THEN 'Part B' END, CASE WHEN r.dme THEN 'DME' END,
                    CASE WHEN r.hha THEN 'Home health' END, CASE WHEN r.pmd THEN 'Power mobility' END,
                    CASE WHEN r.hospice THEN 'Hospice' END], NULL)
               FROM public.medicare_order_referring r WHERE r.npi = p.npi) AS medicare_order_refer,
            (SELECT to_char(min(coalesce(v.adjusted_due_date, v.due_date)), 'YYYY-MM-DD')
               FROM public.medicare_revalidation v WHERE v.npi = p.npi) AS medicare_revalidation_due`;

export async function getProvider(npi: string): Promise<ProviderRow | null> {
  if (!/^\d{10}$/.test(npi)) return null; // cheap reject before hitting the DB
  const rows = await query<ProviderRow>(
    `SELECT p.npi, p.entity_type, p.org_name, p.first_name, p.last_name, p.middle_name,
            p.credential, p.sex, p.practice_addr1, p.practice_addr2, p.practice_city,
            p.practice_state, p.practice_zip, p.practice_phone, p.primary_taxonomy_code,
            to_char(p.enumeration_date,  'YYYY-MM-DD') AS enumeration_date,
            to_char(p.last_update_date,  'YYYY-MM-DD') AS last_update_date,
            to_char(p.deactivation_date, 'YYYY-MM-DD') AS deactivation_date,
            p.is_sole_proprietor, p.license_number, p.license_state,
            t.display_name AS specialty, t.slug AS specialty_slug, t.classification, t.grouping,
            EXISTS (SELECT 1 FROM public.oig_exclusions e WHERE e.npi = p.npi) AS oig_excluded,
            ${MEDICARE_COLS}
       FROM providers p
       LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.npi = $1`,
    [npi],
  );
  return rows[0] ?? null;
}

/** Batch sibling of getProvider — one round-trip for many NPIs (bulk API + bulk-lookup tool). Same
 *  projection so a bulk row is byte-identical to a single lookup; callers 10-digit-validate first. */
export async function getProviders(npis: string[]): Promise<ProviderRow[]> {
  if (npis.length === 0) return [];
  return query<ProviderRow>(
    `SELECT p.npi, p.entity_type, p.org_name, p.first_name, p.last_name, p.middle_name,
            p.credential, p.sex, p.practice_addr1, p.practice_addr2, p.practice_city,
            p.practice_state, p.practice_zip, p.practice_phone, p.primary_taxonomy_code,
            to_char(p.enumeration_date,  'YYYY-MM-DD') AS enumeration_date,
            to_char(p.last_update_date,  'YYYY-MM-DD') AS last_update_date,
            to_char(p.deactivation_date, 'YYYY-MM-DD') AS deactivation_date,
            p.is_sole_proprietor, p.license_number, p.license_state,
            t.display_name AS specialty, t.slug AS specialty_slug, t.classification, t.grouping,
            EXISTS (SELECT 1 FROM public.oig_exclusions e WHERE e.npi = p.npi) AS oig_excluded,
            ${MEDICARE_COLS}
       FROM providers p
       LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.npi = ANY($1::text[])`,
    [npis],
  );
}

/** Clean, stable public JSON representation (for the API + bulk-lookup tool). */
export function toPublicJson(p: ProviderRow) {
  const org = p.entity_type === "org";
  const lv = p.license_number ? licenseVerification(p) : null;
  return {
    npi: p.npi,
    valid: isValidNpi(p.npi),
    entityType: org ? "organization" : p.entity_type === "individual" ? "individual" : null,
    name: fullName(p),
    firstName: org ? null : titleCase(p.first_name),
    middleName: org ? null : titleCase(p.middle_name),
    lastName: org ? null : titleCase(p.last_name),
    organizationName: org ? titleCase(p.org_name) : null,
    credential: p.credential,
    sex: org ? null : p.sex,
    soleProprietor: org ? null : p.is_sole_proprietor,
    specialty: p.specialty,
    taxonomyCode: p.primary_taxonomy_code,
    classification: p.classification,
    specialtyGroup: p.grouping,
    licenseNumber: p.license_number,
    licenseState: p.license_state,
    licenseVerification: lv ? { source: lv.source, url: lv.url } : null,
    practiceLocation: {
      address1: titleCase(p.practice_addr1),
      address2: titleCase(p.practice_addr2),
      city: titleCase(p.practice_city),
      state: p.practice_state,
      zip: formatZip(p.practice_zip),
      phone: formatPhone(p.practice_phone),
    },
    enumerationDate: p.enumeration_date,
    lastUpdated: p.last_update_date,
    deactivationDate: p.deactivation_date,
    deactivated: p.deactivation_date != null,
    oigExcluded: p.oig_excluded,
    medicareEnrolled: p.medicare_enrolled,
    medicareOptedOut: p.medicare_opted_out,
    medicareOrderRefer: p.medicare_order_refer ?? [],
    medicareRevalidationDue: p.medicare_revalidation_due,
    source: "NPPES",
    url: `https://npiradar.com/npi/${p.npi}`,
  };
}

// ── Side-file data: other org names, secondary practice locations, electronic endpoints ──────────
// From the othername/pl/endpoint files in the same NPPES release (pipeline/load.ts --side). CMS's own
// registry UI shows these poorly or not at all; they are the part of a page the copy can't just mirror.

export const OTHER_NAME_TYPES: Record<string, string> = {
  "3": "Doing business as",
  "4": "Former legal business name",
  "5": "Other name",
};
const PAGE_LIST_LIMIT = 25; // the page lists the first N and counts the rest (one NPI has 363 locations)
const API_LIST_LIMIT = 1000; // the API returns everything (well above the largest real list)

export interface ProviderExtras {
  otherNames: { name: string; type_code: string | null }[];
  locations: { addr1: string | null; addr2: string | null; city: string | null; state: string | null; zip: string | null; country: string | null; phone: string | null; fax: string | null }[];
  locationCount: number;
  endpoints: { endpoint_type: string | null; endpoint_type_desc: string | null; endpoint: string; affiliation_name: string | null; use_desc: string | null }[];
  endpointCount: number;
}

const EMPTY_EXTRAS: ProviderExtras = { otherNames: [], locations: [], locationCount: 0, endpoints: [], endpointCount: 0 };

export async function getProviderExtras(npi: string, opts: { full?: boolean } = {}): Promise<ProviderExtras> {
  const limit = opts.full ? API_LIST_LIMIT : PAGE_LIST_LIMIT;
  if (!/^\d{10}$/.test(npi)) return EMPTY_EXTRAS;
  try {
    const [names, locs, eps] = await Promise.all([
      query<ProviderExtras["otherNames"][number]>(
        `SELECT name, type_code FROM provider_other_names WHERE npi = $1 ORDER BY type_code, name`, [npi]),
      query<ProviderExtras["locations"][number] & { total: number }>(
        `SELECT addr1, addr2, city, state, zip, country, phone, fax, count(*) OVER ()::int AS total
           FROM provider_locations WHERE npi = $1 ORDER BY state, city, addr1 LIMIT ${limit}`, [npi]),
      query<ProviderExtras["endpoints"][number] & { total: number }>(
        `SELECT endpoint_type, endpoint_type_desc, endpoint, affiliation_name, use_desc, count(*) OVER ()::int AS total
           FROM provider_endpoints WHERE npi = $1 ORDER BY endpoint_type, endpoint LIMIT ${limit}`, [npi]),
    ]);
    return {
      otherNames: names,
      locations: locs.map(({ total: _, ...l }) => l),
      locationCount: locs[0]?.total ?? 0,
      endpoints: eps.map(({ total: _, ...e }) => e),
      endpointCount: eps[0]?.total ?? 0,
    };
  } catch (e) {
    // 42P01 = table missing: a live schema loaded before the side files existed. Show the page without them.
    if ((e as { code?: string }).code === "42P01") return EMPTY_EXTRAS;
    throw e;
  }
}

/** Public JSON for the side-file data (single-NPI API only; bulk keeps the flat core row). */
export function extrasToPublicJson(x: ProviderExtras) {
  return {
    otherNames: x.otherNames.map((n) => ({ name: n.name, type: OTHER_NAME_TYPES[n.type_code ?? ""] ?? null })),
    secondaryLocations: x.locations.map((l) => ({
      address1: titleCase(l.addr1), address2: titleCase(l.addr2), city: titleCase(l.city), state: l.state,
      zip: formatZip(l.zip), country: l.country, phone: formatPhone(l.phone), fax: formatPhone(l.fax),
    })),
    secondaryLocationCount: x.locationCount,
    endpoints: x.endpoints.map((e) => ({
      type: e.endpoint_type, typeDescription: e.endpoint_type_desc, endpoint: e.endpoint,
      affiliation: e.affiliation_name, use: e.use_desc,
    })),
    endpointCount: x.endpointCount,
  };
}

// ── Registry history: month-over-month changes recorded at each load (pipeline/load.ts --diff) ──────

export interface ProviderChange {
  release: string; // YYYY-MM-DD, the release's max(last_update_date)
  change: string;
  old_value: string | null;
  new_value: string | null;
  old_label: string | null; // taxonomy display names, for primary_taxonomy rows
  new_label: string | null;
}

export async function getProviderChanges(npi: string): Promise<ProviderChange[]> {
  if (!/^\d{10}$/.test(npi)) return [];
  try {
    return await query<ProviderChange>(
      `SELECT to_char(c.release, 'YYYY-MM-DD') AS release, c.change, c.old_value, c.new_value,
              ot.display_name AS old_label, nt.display_name AS new_label
         FROM public.provider_changes c
         LEFT JOIN taxonomy ot ON c.change = 'primary_taxonomy' AND ot.code = c.old_value
         LEFT JOIN taxonomy nt ON c.change = 'primary_taxonomy' AND nt.code = c.new_value
        WHERE c.npi = $1 AND c.change <> 'removed'
        ORDER BY c.release DESC, c.change
        LIMIT 100`,
      [npi],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return []; // no load has recorded changes yet
    throw e;
  }
}

/** "1700 NEUSE BLVD, NEW BERN, NC, 285602304" → "1700 Neuse Blvd, New Bern, NC 28560-2304". */
function formatStoredAddress(a: string | null): string | null {
  if (!a) return null;
  const parts = a.split(", ");
  const zip = /^\d{5,9}$/.test(parts[parts.length - 1] ?? "") ? formatZip(parts.pop()!) : null;
  const state = /^[A-Z]{2}$/.test(parts[parts.length - 1] ?? "") ? parts.pop()! : null;
  return [...parts.map((p) => titleCase(p)), [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

const STATUS_CHANGES = new Set([
  "added", "deactivated", "reactivated", "oig_excluded", "oig_reinstated",
  "medicare_enrolled", "medicare_unenrolled", "medicare_opted_out", "medicare_opt_out_ended",
]);

const CHANGE_LABELS: Record<string, string> = {
  added: "Added to the registry",
  deactivated: "Deactivated",
  reactivated: "Reactivated",
  practice_address: "Practice address changed",
  practice_phone: "Practice phone changed",
  primary_taxonomy: "Primary specialty changed",
  name: "Name changed",
  credential: "Credential changed",
  license: "License changed",
  oig_reinstated: "Removed from the HHS OIG exclusion list",
  medicare_unenrolled: "Left Medicare's public enrollment file",
  medicare_opt_out_ended: "Medicare opt-out affidavit removed",
  medicare_ordering: "Medicare order and referral eligibility changed",
};

/** Display-ready change, shared by the page and the API so they can't drift. */
export function describeChange(c: ProviderChange) {
  const fmt = (v: string | null, label: string | null) =>
    c.change === "practice_address" ? formatStoredAddress(v)
    : c.change === "practice_phone" ? formatPhone(v)
    : c.change === "primary_taxonomy" ? (label ? `${label} (${v})` : v)
    : c.change === "name" ? titleCase(v)
    : v;
  return {
    release: c.release,
    change: c.change,
    label:
      c.change === "deactivated" && c.new_value ? `Deactivated, effective ${c.new_value}`
      : c.change === "medicare_enrolled" ? `Enrolled in Medicare${c.new_value ? ` (${titleCase(c.new_value)})` : ""}`
      : c.change === "medicare_opted_out" ? `Opted out of Medicare${c.new_value ? `, effective ${c.new_value}` : ""}`
      : c.change === "oig_excluded" ? `Added to the HHS OIG exclusion list${c.new_value ? ` (${oigSection(c.new_value)}${oigTypeLabel(c.new_value) ? `: ${oigTypeLabel(c.new_value)}` : ""})` : ""}`
      : CHANGE_LABELS[c.change] ?? c.change,
    // Status changes are their own statement; only field changes carry a from → to.
    from: STATUS_CHANGES.has(c.change) ? null : fmt(c.old_value, c.old_label),
    to: STATUS_CHANGES.has(c.change) ? null : fmt(c.new_value, c.new_label),
  };
}

// ── HHS OIG exclusions (pipeline/leie.ts) ───────────────────────────────────────────────────────────
// Matched by NPI only; never by name. The page must cite OIG and point to its verification search.

export interface OigExclusion {
  excl_type: string;
  excl_date: string | null;
  waiver_date: string | null;
  waiver_state: string | null;
  loaded_at: string | null; // when we last loaded the list, for "as of"
}

export async function getOigExclusions(npi: string): Promise<OigExclusion[]> {
  if (!/^\d{10}$/.test(npi)) return [];
  try {
    return await query<OigExclusion>(
      `SELECT e.excl_type, to_char(e.excl_date, 'YYYY-MM-DD') AS excl_date,
              to_char(e.waiver_date, 'YYYY-MM-DD') AS waiver_date, e.waiver_state,
              (SELECT to_char(max(loaded_at), 'YYYY-MM-DD') FROM public.dataset_loads WHERE dataset = 'leie') AS loaded_at
         FROM public.oig_exclusions e WHERE e.npi = $1 ORDER BY e.excl_date`,
      [npi],
    );
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return []; // list not loaded yet
    throw e;
  }
}

export function oigToPublicJson(x: OigExclusion[]) {
  if (x.length === 0) return { oigExcluded: false, oigExclusions: [] };
  return {
    oigExcluded: true,
    oigExclusions: x.map((e) => ({
      type: e.excl_type, section: oigSection(e.excl_type), description: oigTypeLabel(e.excl_type),
      excludedSince: e.excl_date, waiverDate: e.waiver_date, waiverState: e.waiver_state,
    })),
    oigListAsOf: x[0].loaded_at,
    oigSource: "HHS OIG List of Excluded Individuals/Entities (LEIE). Verify at " + OIG_VERIFY_URL,
  };
}

// ── CMS Open Payments: industry payments to the clinician (pipeline/openpayments.ts) ────────────────

export interface OpenPayments {
  years: { program_year: number; total_usd: string; payments: number; companies: number }[];
  latestYear: number | null;
  companies: { company: string | null; total_usd: string; payments: number }[]; // latest year, top 10
  natures: { nature: string | null; total_usd: string; payments: number }[]; // latest year
}

const EMPTY_OP: OpenPayments = { years: [], latestYear: null, companies: [], natures: [] };

export async function getOpenPayments(npi: string): Promise<OpenPayments> {
  if (!/^\d{10}$/.test(npi)) return EMPTY_OP;
  try {
    const years = await query<OpenPayments["years"][number]>(
      `SELECT program_year, total_usd::text, payments, companies FROM public.op_npi_year
        WHERE npi = $1 ORDER BY program_year DESC`, [npi]);
    if (years.length === 0) return EMPTY_OP;
    const y = years[0].program_year;
    const [companies, natures] = await Promise.all([
      query<OpenPayments["companies"][number]>(
        `SELECT c.company, c.total_usd::text AS total_usd, c.payments FROM public.op_npi_company c
          WHERE c.npi = $1 AND c.program_year = $2 ORDER BY c.total_usd DESC`, [npi, y]), // c.: sort the numeric, not the ::text alias
      query<OpenPayments["natures"][number]>(
        `SELECT n.nature, n.total_usd::text AS total_usd, n.payments FROM public.op_npi_nature n
          WHERE n.npi = $1 AND n.program_year = $2 ORDER BY n.total_usd DESC`, [npi, y]),
    ]);
    return { years, latestYear: y, companies, natures };
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return EMPTY_OP; // not loaded yet
    throw e;
  }
}

export function openPaymentsToPublicJson(op: OpenPayments) {
  const usd = (s: string) => Number(s);
  return {
    openPayments: op.years.length === 0 ? null : {
      source: "CMS Open Payments, general payments (as published, disputed payments included)",
      byYear: op.years.map((y) => ({ year: y.program_year, totalUsd: usd(y.total_usd), payments: y.payments, companies: y.companies })),
      latestYear: op.latestYear,
      topCompanies: op.companies.map((c) => ({ company: c.company, totalUsd: usd(c.total_usd), payments: c.payments })),
      byNature: op.natures.map((n) => ({ nature: n.nature, totalUsd: usd(n.total_usd), payments: n.payments })),
    },
  };
}

// ── CMS Medicare: enrollment, order & referral eligibility, opt-out (pipeline/medicare.ts) ──────────
// Matched by NPI. Each file has its own cadence, so each carries its own "as of" (our load date).

export interface Medicare {
  loaded: boolean; // false until the first load: show nothing rather than "not enrolled" for everyone
  enrollments: { provider_type: string | null; state: string | null }[];
  orderRefer: { part_b: boolean; dme: boolean; hha: boolean; pmd: boolean; hospice: boolean } | null;
  optOuts: { specialty: string | null; effective_date: string | null; end_date: string | null; state: string | null; current: boolean }[];
  // One per enrollment. due = the adjusted date if CMS set one, else the due date; null = not set yet ("TBD").
  revalidation: { state: string | null; provider_type: string | null; due: string | null }[];
  asOf: { enrollment: string | null; orderReferring: string | null; optOut: string | null; revalidation: string | null };
}

const EMPTY_MEDICARE: Medicare = {
  loaded: false, enrollments: [], orderRefer: null, optOuts: [], revalidation: [],
  asOf: { enrollment: null, orderReferring: null, optOut: null, revalidation: null },
};

// [column, label, API key]
export const ORDER_REFER_PROGRAMS = [
  ["part_b", "Part B", "partB"], ["dme", "DME", "dme"], ["hha", "Home health", "homeHealth"],
  ["pmd", "Power mobility", "powerMobility"], ["hospice", "Hospice", "hospice"],
] as const;

export async function getMedicare(npi: string): Promise<Medicare> {
  if (!/^\d{10}$/.test(npi)) return EMPTY_MEDICARE;
  try {
    const [enr, ord, opt, rev, asOf] = await Promise.all([
      query<Medicare["enrollments"][number]>(
        `SELECT DISTINCT provider_type, state FROM public.medicare_enrollment WHERE npi = $1 ORDER BY state, provider_type`, [npi]),
      query<NonNullable<Medicare["orderRefer"]>>(
        `SELECT part_b, dme, hha, pmd, hospice FROM public.medicare_order_referring WHERE npi = $1`, [npi]),
      query<Medicare["optOuts"][number]>(
        `SELECT specialty, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
                state, end_date >= current_date AS current
           FROM public.medicare_opt_out WHERE npi = $1 ORDER BY end_date DESC NULLS LAST`, [npi]),
      query<Medicare["revalidation"][number]>(
        `SELECT DISTINCT state, provider_type, to_char(coalesce(adjusted_due_date, due_date), 'YYYY-MM-DD') AS due
           FROM public.medicare_revalidation WHERE npi = $1 ORDER BY due NULLS LAST, state`, [npi]).catch((e) => {
        if ((e as { code?: string }).code === "42P01") return []; // loaded after the other three
        throw e;
      }),
      query<{ dataset: string; at: string }>(
        `SELECT dataset, to_char(max(loaded_at), 'YYYY-MM-DD') AS at FROM public.dataset_loads
          WHERE dataset IN ('medicare_enrollment', 'medicare_order_referring', 'medicare_opt_out', 'medicare_revalidation')
          GROUP BY dataset`),
    ]);
    const at = (k: string) => asOf.find((a) => a.dataset === k)?.at ?? null;
    return {
      loaded: asOf.length > 0,
      enrollments: enr, orderRefer: ord[0] ?? null, optOuts: opt, revalidation: rev,
      asOf: {
        enrollment: at("medicare_enrollment"), orderReferring: at("medicare_order_referring"),
        optOut: at("medicare_opt_out"), revalidation: at("medicare_revalidation"),
      },
    };
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return EMPTY_MEDICARE; // not loaded yet
    throw e;
  }
}

export function medicareToPublicJson(m: Medicare) {
  if (!m.loaded) return { medicare: null };
  return {
    medicare: {
      enrolled: m.enrollments.length > 0,
      enrollments: m.enrollments.map((e) => ({ providerType: titleCase(e.provider_type), state: e.state })),
      orderReferring: m.orderRefer
        ? Object.fromEntries(ORDER_REFER_PROGRAMS.map(([k, , key]) => [key, m.orderRefer![k]]))
        : null, // null = not on CMS's Order and Referring list
      optedOut: m.optOuts.some((o) => o.current),
      optOutAffidavits: m.optOuts.map((o) => ({
        specialty: o.specialty, state: o.state, effective: o.effective_date, end: o.end_date, current: o.current,
      })),
      revalidation: m.revalidation.map((r) => ({ state: r.state, providerType: r.provider_type, dueDate: r.due })), // dueDate null = not set yet
      asOf: m.asOf,
      source: "CMS: Medicare Fee-For-Service Public Provider Enrollment, Order and Referring, Opt Out Affidavits, Revalidation Due Date List (data.cms.gov)",
    },
  };
}

// ── CMS Care Compare: Doctors and Clinicians (pipeline/carecompare.ts) ────────────────────────────────
// Medicare-enrolled clinicians only. Matched by NPI.

export interface CareCompare {
  clinician: {
    med_school: string | null; grad_year: number | null; primary_specialty: string | null;
    secondary_specialties: string | null; telehealth: boolean; assignment: "Y" | "M" | null;
  } | null;
  groups: { org_pac_id: string; group_name: string | null; group_members: number | null; cities: string[] | null }[];
  groupCount: number;
  affiliations: { facility_type: string; ccn: string; name: string | null; city: string | null; state: string | null; overall_rating: number | null }[];
  asOf: string | null;
}

const EMPTY_CC: CareCompare = { clinician: null, groups: [], groupCount: 0, affiliations: [], asOf: null };

export async function getCareCompare(npi: string, opts: { full?: boolean } = {}): Promise<CareCompare> {
  if (!/^\d{10}$/.test(npi)) return EMPTY_CC;
  const limit = opts.full ? API_LIST_LIMIT : PAGE_LIST_LIMIT;
  try {
    const [cl, gr, af, asOf] = await Promise.all([
      query<NonNullable<CareCompare["clinician"]>>(
        `SELECT med_school, grad_year, primary_specialty, secondary_specialties, telehealth, assignment
           FROM public.cc_clinicians WHERE npi = $1`, [npi]),
      query<CareCompare["groups"][number] & { total: number }>(
        `SELECT org_pac_id, group_name, group_members, cities, count(*) OVER ()::int AS total
           FROM public.cc_groups WHERE npi = $1 ORDER BY group_members DESC NULLS LAST, group_name LIMIT ${limit}`, [npi]),
      query<CareCompare["affiliations"][number]>(
        `SELECT a.facility_type, a.ccn, h.name, h.city, h.state, h.overall_rating
           FROM public.cc_affiliations a LEFT JOIN public.cc_hospitals h ON h.ccn = a.ccn
          WHERE a.npi = $1 ORDER BY a.facility_type <> 'Hospital', h.name NULLS LAST, a.ccn`, [npi]),
      query<{ at: string }>(
        `SELECT to_char(max(loaded_at), 'YYYY-MM-DD') AS at FROM public.dataset_loads WHERE dataset = 'care_compare_clinicians'`),
    ]);
    return {
      clinician: cl[0] ?? null,
      groups: gr.map(({ total: _, ...g }) => g), groupCount: gr[0]?.total ?? 0,
      affiliations: af, asOf: asOf[0]?.at ?? null,
    };
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return EMPTY_CC; // not loaded yet
    throw e;
  }
}

export const ASSIGNMENT_LABELS = { Y: "Accepts Medicare assignment", M: "May accept Medicare assignment" } as const;

export function careCompareToPublicJson(c: CareCompare) {
  if (!c.clinician && c.affiliations.length === 0) return { careCompare: null };
  const k = c.clinician;
  return {
    careCompare: {
      medicalSchool: titleCase(k?.med_school ?? null),
      graduationYear: k?.grad_year ?? null,
      primarySpecialty: titleCase(k?.primary_specialty ?? null),
      secondarySpecialties: k?.secondary_specialties ? k.secondary_specialties.split(",").map((s) => titleCase(s.trim())) : [],
      telehealth: k?.telehealth ?? null,
      medicareAssignment: k?.assignment ? ASSIGNMENT_LABELS[k.assignment] : null,
      groups: c.groups.map((g) => ({ pacId: g.org_pac_id, name: titleCase(g.group_name), members: g.group_members, cities: g.cities ?? [] })),
      groupCount: c.groupCount,
      facilityAffiliations: c.affiliations.map((a) => ({
        type: a.facility_type, ccn: a.ccn, name: titleCase(a.name), city: titleCase(a.city), state: a.state, cmsOverallRating: a.overall_rating,
      })),
      asOf: c.asOf,
      source: "CMS Care Compare: Doctors and Clinicians national file, Facility Affiliation, Hospital General Information (data.cms.gov)",
    },
  };
}
