/**
 * NPI check-digit validation. NPIs carry a Luhn check digit computed over the 9-digit base
 * prefixed with "80840" (the ISO issuer prefix for US health applications). Pure, no data.
 * Worked example: 1234567893 → base 80840123456789 → sum 67 → check 3 ⇒ valid.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const base = "80840" + npi.slice(0, 9); // 14 digits fed to Luhn
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    let d = +base[base.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === +npi[9];
}
