import Link from "next/link";
import type { FacetInsights } from "@/lib/insights";
import { usd } from "@/lib/insights";
import { titleCase } from "@/lib/format";

// Payments + exclusions for the providers listed on a city or specialty×city page. Rendered only on
// index-eligible pages (read from the precomputed mv_facet_insights; thin pages don't need it).
export function FacetInsightsSection({ x, label }: { x: FacetInsights; label: string }) {
  if (!x.year && x.excluded === 0) return null;
  return (
    <section style={{ marginTop: 32 }}>
      <h2>Industry payments and exclusions</h2>
      {x.year && x.paid > 0 ? (
        <p>
          In {x.year}, drug and device companies reported paying {x.paid.toLocaleString()} of the {label}{" "}
          a combined {usd(x.totalUsd)} (<Link href="/open-payments">Open Payments</Link>).
        </p>
      ) : x.year ? (
        <p>None of the {label} received a reported industry payment in {x.year}.</p>
      ) : null}
      {x.topRecipients.length > 0 && (
        <ul>
          {x.topRecipients.map((r) => (
            <li key={r.npi}>
              <Link href={`/npi/${r.npi}`}>{titleCase(r.name) ?? r.npi}</Link>
              {r.specialty ? `, ${r.specialty}` : ""} · {usd(r.total_usd)}
            </li>
          ))}
        </ul>
      )}
      <p>
        {x.excluded > 0
          ? <>{x.excluded.toLocaleString()} of them {x.excluded === 1 ? "is" : "are"} on the HHS OIG exclusion list. </>
          : <>None of them is on the HHS OIG exclusion list by NPI. </>}
        <Link href="/oig-exclusion-check">Check NPIs against the list</Link>.
      </p>
    </section>
  );
}
