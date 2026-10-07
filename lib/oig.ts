// HHS OIG exclusion authorities, as coded in the LEIE's EXCLTYPE column. Labels follow OIG's own
// "Exclusion Authorities" descriptions. A code not listed here is shown raw rather than guessed.
const OIG_EXCLUSION_TYPES: Record<string, string> = {
  "1128a1": "Conviction of program-related crimes",
  "1128a2": "Conviction relating to patient abuse or neglect",
  "1128a3": "Felony conviction relating to health care fraud",
  "1128a4": "Felony conviction relating to controlled substances",
  "1128b1": "Misdemeanor conviction relating to health care fraud",
  "1128b2": "Conviction relating to obstruction of an investigation or audit",
  "1128b3": "Misdemeanor conviction relating to controlled substances",
  "1128b4": "License revocation, suspension, or surrender",
  "1128b5": "Exclusion or suspension under a federal or state health care program",
  "1128b6": "Excessive claims or unnecessary or substandard services",
  "1128b7": "Fraud, kickbacks, and other prohibited activities",
  "1128b8": "Entity controlled by a sanctioned individual",
  "1128b14": "Default on health education loan or scholarship obligations",
  "1128b15": "Individual controlling a sanctioned entity",
  "1128b16": "False statement or misrepresentation of material fact",
  "1128Aa": "Civil monetary penalty",
  "1156": "Failure to meet statutory obligations",
  "BRCH CIA": "Breach of a Corporate Integrity Agreement",
  "BRCH SA": "Breach of a settlement agreement",
};

/** "1128b4" → "§1128(b)(4)"; non-section codes pass through. */
export function oigSection(code: string): string {
  const m = code.match(/^1128([a-z])(\d+)$/);
  return m ? `§1128(${m[1]})(${m[2]})` : code;
}

export function oigTypeLabel(code: string): string | null {
  return OIG_EXCLUSION_TYPES[code] ?? null;
}

export const OIG_VERIFY_URL = "https://exclusions.oig.hhs.gov/";
