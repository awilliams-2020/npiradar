// NPPES stores names/addresses in ALL CAPS — title-case them for display; leave state codes alone.

export interface NameParts {
  entity_type: "individual" | "org" | null;
  org_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
}

export function titleCase(s: string | null): string | null {
  if (!s) return null;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function fullName(p: NameParts): string {
  if (p.entity_type === "org") return titleCase(p.org_name) ?? "Unknown organization";
  const parts = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");
  return titleCase(parts) || titleCase(p.org_name) || "Unknown provider";
}

export function formatZip(zip: string | null): string | null {
  if (!zip) return null;
  const d = zip.replace(/\D/g, "");
  if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return d.slice(0, 5) || null;
}

export function formatPhone(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : phone;
}

/** Data vintage shown for freshness/attribution; bump on each monthly load. */
export const DATA_VINTAGE = "NPPES — May 2026 release";
