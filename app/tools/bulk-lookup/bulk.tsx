"use client";

import { useState } from "react";

// Paste many NPIs → look each up via the public /api/npi/[npi] endpoint → table + CSV export.
const MAX = 100;
const CONCURRENCY = 6;

interface Row {
  npi: string;
  status: "ok" | "not_found" | "error";
  valid?: boolean;
  name?: string;
  entityType?: string | null;
  specialty?: string | null;
  city?: string | null;
  state?: string | null;
}

function parseNpis(text: string): string[] {
  const tokens = text.split(/\D+/).filter(Boolean);
  return Array.from(new Set(tokens.filter((t) => /^\d{10}$/.test(t)))).slice(0, MAX);
}

function toCsv(rows: Row[]): string {
  const head = ["npi", "status", "valid", "name", "entityType", "specialty", "city", "state"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [r.npi, r.status, r.valid ?? "", r.name ?? "", r.entityType ?? "", r.specialty ?? "", r.city ?? "", r.state ?? ""]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

export function BulkLookup() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function run() {
    const npis = parseNpis(input);
    setSubmitted(true);
    setRows([]);
    if (npis.length === 0) return;
    setBusy(true);
    const out: Row[] = [];
    for (let i = 0; i < npis.length; i += CONCURRENCY) {
      const batch = npis.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (npi): Promise<Row> => {
          try {
            const r = await fetch(`/api/npi/${npi}`);
            if (r.status === 404) return { npi, status: "not_found" };
            if (!r.ok) return { npi, status: "error" };
            const j = await r.json();
            return {
              npi, status: "ok", valid: j.valid, name: j.name, entityType: j.entityType,
              specialty: j.specialty, city: j.practiceLocation?.city, state: j.practiceLocation?.state,
            };
          } catch {
            return { npi, status: "error" };
          }
        }),
      );
      out.push(...results);
      setRows([...out]);
    }
    setBusy(false);
  }

  function download() {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "npi-lookup.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const parsedCount = parseNpis(input).length;

  return (
    <div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Paste NPI numbers — one per line, or separated by commas/spaces"
        rows={6}
        aria-label="NPI numbers"
        className="bulk-input"
      />
      <div className="bulk-actions">
        <button type="button" onClick={run} disabled={busy || parsedCount === 0}>
          {busy ? "Looking up…" : `Look up ${parsedCount || ""} NPI${parsedCount === 1 ? "" : "s"}`.trim()}
        </button>
        {rows.length > 0 && !busy && (
          <button type="button" className="ghost" onClick={download}>Download CSV</button>
        )}
        <span className="muted">Up to {MAX} at a time.</span>
      </div>

      {submitted && parsedCount === 0 && (
        <p className="sub">No 10-digit NPI numbers found in that input.</p>
      )}

      {rows.length > 0 && (
        <table className="bulk">
          <thead>
            <tr><th>NPI</th><th>Name</th><th>Specialty</th><th>Location</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.npi}>
                <td><a href={`/npi/${r.npi}`}>{r.npi}</a></td>
                <td>{r.name ?? "—"}</td>
                <td>{r.specialty ?? "—"}</td>
                <td>{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                <td>
                  {r.status === "ok" ? <span className="badge ok">Found</span>
                    : r.status === "not_found" ? <span className="badge bad">Not found</span>
                    : <span className="badge bad">Error</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
