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
