import { stateName } from "@/lib/states";

// Where to verify a provider's license. There's no single licensing dataset: boards are per state and per
// profession (hundreds of sites), so we point to the free national lookups that exist and name the board
// otherwise. Keyed off the NUCC taxonomy of the provider's primary specialty.

const NURSE_CLASSES = new Set([
  "Registered Nurse", "Licensed Practical Nurse", "Licensed Vocational Nurse", "Nurse Practitioner",
  "Clinical Nurse Specialist", "Nurse Anesthetist, Certified Registered", "Advanced Practice Midwife",
]);

export interface LicenseVerification { source: string; url: string | null; text: string }

export function licenseVerification(p: {
  entity_type: string | null; grouping: string | null; classification: string | null; license_state: string | null;
}): LicenseVerification | null {
  if (p.entity_type === "org") return null;
  if (p.grouping === "Allopathic & Osteopathic Physicians") {
    return { source: "DocInfo (Federation of State Medical Boards)", url: "https://www.docinfo.org/", text: "Verify on DocInfo" };
  }
  if (p.classification && NURSE_CLASSES.has(p.classification)) {
    // Nursys QuickConfirm; the home page links to it (the deep link only redirects for a browser session).
    return { source: "Nursys QuickConfirm (National Council of State Boards of Nursing)", url: "https://www.nursys.com/", text: "Verify on Nursys" };
  }
  const st = p.license_state ? stateName(p.license_state) ?? p.license_state : null;
  return { source: "state licensing board", url: null, text: st ? `Verify with the ${st} licensing board` : "Verify with the state licensing board" };
}
