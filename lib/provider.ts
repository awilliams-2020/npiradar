import { query } from "@/lib/db";
import { isValidNpi } from "@/lib/npi";
import { fullName, titleCase, formatZip, formatPhone } from "@/lib/format";

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
}

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
            t.display_name AS specialty, t.slug AS specialty_slug, t.classification, t.grouping
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
            t.display_name AS specialty, t.slug AS specialty_slug, t.classification, t.grouping
       FROM providers p
       LEFT JOIN taxonomy t ON t.code = p.primary_taxonomy_code
      WHERE p.npi = ANY($1::text[])`,
    [npis],
  );
}

/** Clean, stable public JSON representation (for the API + bulk-lookup tool). */
export function toPublicJson(p: ProviderRow) {
  const org = p.entity_type === "org";
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
