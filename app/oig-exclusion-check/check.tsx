"use client";

import { useState } from "react";

// Paste NPIs → POST /api/npi (same bulk endpoint as /tools/bulk-lookup) → excluded first, then the rest.
const MAX = 100;

interface Row {
  npi: string;
  status: "excluded" | "clear" | "not_found" | "error";
  name?: string;
  deactivated?: boolean;
}

function parseNpis(text: string): string[] {
  return Array.from(new Set(text.split(/\D+/).filter((t) => /^\d{10}$/.test(t)))).slice(0, MAX);
}

const ORDER = { excluded: 0, not_found: 1, error: 2, clear: 3 } as const;

export function ExclusionCheck() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const count = parseNpis(input).length;

  async function run() {
    const npis = parseNpis(input);
    setSubmitted(true);
    setRows([]);
    if (npis.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch("/api/npi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ npis }),
      });
      if (!r.ok) {
        setRows(npis.map((npi) => ({ npi, status: "error" })));
        return;
      }
      const j = await r.json();
      const found = new Map<string, Row>(
        (j.results ?? []).map((p: { npi: string; name?: string; oigExcluded?: boolean; deactivated?: boolean }) => [
          p.npi,
          { npi: p.npi, name: p.name, deactivated: p.deactivated, status: p.oigExcluded ? "excluded" : "clear" } as Row,
        ]),
      );
      const out = npis.map((npi) => found.get(npi) ?? ({ npi, status: "not_found" } as Row));
      setRows(out.sort((a, b) => ORDER[a.status] - ORDER[b.status]));
    } catch {
      setRows(npis.map((npi) => ({ npi, status: "error" })));
    } finally {
      setBusy(false);
    }
  }

  const hits = rows.filter((r) => r.status === "excluded").length;

  return (
    <div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste NPI numbers, one per line or separated by commas"
        rows={6}
        aria-label="NPI numbers"
        className="bulk-input"
      />
      <div className="bulk-actions">
        <button type="button" onClick={run} disabled={busy || count === 0}>
          {busy ? "Checking…" : count ? `Check ${count} NPI${count === 1 ? "" : "s"}` : "Check NPIs"}
        </button>
        <span className="muted">Up to {MAX} at a time. Free, no sign-up.</span>
      </div>

      {submitted && count === 0 && <p className="sub">No 10-digit NPI numbers found in that input.</p>}

      {rows.length > 0 && (
        <>
          <p>
            <strong>{hits === 0 ? "No matches." : `${hits} of ${rows.length} on the OIG list.`}</strong>
          </p>
          <table className="bulk">
            <thead>
              <tr><th>NPI</th><th>Name</th><th>Result</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.npi}>
                  <td><a href={`/npi/${r.npi}`}>{r.npi}</a></td>
                  <td>{r.name ?? "—"}</td>
                  <td>
                    {r.status === "excluded" ? <a className="badge bad" href={`/npi/${r.npi}`}>On the OIG list</a>
                      : r.status === "clear" ? <span className="badge ok">No NPI match{r.deactivated ? " · NPI deactivated" : ""}</span>
                      : r.status === "not_found" ? <span className="badge bad">NPI not in NPPES</span>
                      : <span className="badge bad">Error, try again</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
