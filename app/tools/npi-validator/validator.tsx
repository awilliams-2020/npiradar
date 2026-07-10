"use client";

import { useState } from "react";
import { isValidNpi } from "@/lib/npi";

// Client-side, zero-backend check-digit validation. The Luhn-over-"80840"+9-digit math is pure
// (lib/npi.ts), so this runs entirely in the browser.
export function Validator() {
  const [npi, setNpi] = useState("");
  const digits = npi.replace(/\D/g, "").slice(0, 10);
  const ready = digits.length === 10;
  const valid = ready ? isValidNpi(digits) : null;

  return (
    <div>
      <form className="search" onSubmit={(e) => e.preventDefault()}>
        <input
          value={npi}
          onChange={(e) => setNpi(e.target.value)}
          placeholder="Enter a 10-digit NPI number"
          aria-label="NPI number"
          inputMode="numeric"
          autoComplete="off"
        />
      </form>

      {npi && !ready && <p className="sub">Enter all 10 digits ({digits.length}/10).</p>}
      {ready && valid && (
        <>
          <p>
            <span className="badge ok">Valid NPI</span> {digits} passes the NPI check-digit test.
          </p>
          <p className="sub">
            <a href={`/npi/${digits}`}>Look up {digits} in the NPPES registry →</a>
          </p>
        </>
      )}
      {ready && !valid && (
        <p>
          <span className="badge bad">Invalid</span> {digits} fails the NPI check-digit test — it isn&apos;t a
          structurally valid National Provider Identifier.
        </p>
      )}
    </div>
  );
}
