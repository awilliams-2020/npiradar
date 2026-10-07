import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { oigNational } from "@/lib/insights";
import { oigSection, oigTypeLabel, OIG_VERIFY_URL } from "@/lib/oig";
import { titleCase } from "@/lib/format";
import { ExclusionCheck } from "./check";

// Targets the "oig exclusion search / lookup / check", "leie", "medicaid exclusion list" cluster
// (Planner 2026-10: ~2.9k + ~4.5k/mo of tool intent; see ~/scripts/seo/audits/npiradar.md).
// Rendered per request: the build has no DB. The stats behind it are cached per instance for a day
// (lib/insights.ts), so this costs one query set per day, not per hit.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "OIG Exclusion Check by NPI — Free LEIE Lookup",
  description:
    "Check up to 100 NPI numbers against the HHS OIG List of Excluded Individuals/Entities (LEIE) at once. " +
    "Free, no sign-up, updated when OIG publishes.",
  alternates: { canonical: "/oig-exclusion-check" },
};

const FAQ = [
  {
    q: "What is the OIG exclusion list?",
    a: "The List of Excluded Individuals/Entities (LEIE) is kept by the Office of Inspector General at HHS. " +
      "People and companies on it can't be paid by Medicare, Medicaid or other federal health programs for " +
      "anything they provide, order or prescribe. OIG adds and removes names every month.",
  },
  {
    q: "Who needs to check it?",
    a: "Anyone who bills federal health programs and employs or contracts with others: practices, hospitals, " +
      "pharmacies, home health agencies, staffing firms. Hiring or paying an excluded person can bring civil " +
      "monetary penalties. Many state Medicaid programs ask providers to screen every month.",
  },
  {
    q: "Does a clean result here mean someone is not excluded?",
    a: "No. This tool matches on NPI, and many entries on the list, mostly older ones, have no NPI. " +
      "For a full screening, also search the person's name on OIG's own site and keep a record of the result.",
  },
  {
    q: "How current is the data?",
    a: "NPIRadar checks OIG's download file every six hours and reloads it when it changes. " +
      "The date the list was last loaded is shown on this page.",
  },
];

export default async function OigExclusionCheckPage() {
  const s = await oigNational();
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };

  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "OIG exclusion check", href: "/oig-exclusion-check" }]} />
      <h1>OIG exclusion check by NPI</h1>
      <p className="sub">
        Paste NPI numbers to check them against the HHS OIG exclusion list (LEIE). Anyone on the list shows up
        first, with a link to the details.
        {s ? ` List loaded ${s.asOf ?? "recently"}: ${s.npis.toLocaleString()} NPIs on it, ${s.active.toLocaleString()} of them still active in NPPES.` : ""}
      </p>

      <ExclusionCheck />

      <p className="banner" style={{ marginTop: 16 }}>
        Matching uses the NPI in OIG&apos;s file, and many entries have none, so a clean result doesn&apos;t
        clear anyone. Confirm any result, and search by name, at{" "}
        <a href={OIG_VERIFY_URL} rel="nofollow noopener">exclusions.oig.hhs.gov</a>.
      </p>

      {s && s.active > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2>Excluded, but the NPI still looks active</h2>
          <p>
            {s.active.toLocaleString()} of the {s.npis.toLocaleString()} NPIs on the OIG list are still active in
            the NPPES registry. CMS&apos;s NPI lookup doesn&apos;t show exclusions, so these records look normal
            there. On NPIRadar, each one carries a notice on its page.
          </p>
        </section>
      )}

      {s && s.byType.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2>Why people are on the list</h2>
          <table className="bulk">
            <thead><tr><th>Authority</th><th>Reason</th><th>NPIs</th></tr></thead>
            <tbody>
              {s.byType.slice(0, 12).map((t) => (
                <tr key={t.excl_type}>
                  <td>{oigSection(t.excl_type)}</td>
                  <td>{oigTypeLabel(t.excl_type) ?? "—"}</td>
                  <td>{t.n.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {s && s.recent.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2>Most recent exclusions</h2>
          <ul>
            {s.recent.map((r) => (
              <li key={`${r.npi}-${r.excl_type}`}>
                <Link href={`/npi/${r.npi}`}>{titleCase(r.name) ?? r.npi}</Link>
                {r.specialty ? `, ${r.specialty}` : ""}
                {r.city ? `, ${titleCase(r.city)}, ${r.state}` : ""}
                <span className="sub"> · excluded {r.excl_date ?? "—"} under {oigSection(r.excl_type)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginTop: 32 }}>
        <h2>Questions</h2>
        {FAQ.map((f) => (
          <div key={f.q}>
            <h3>{f.q}</h3>
            <p>{f.a}</p>
          </div>
        ))}
        <p>
          Need more than 100 at a time, or the data in your own system? The free{" "}
          <Link href="/npi-api">NPI API</Link> returns <code>oigExcluded</code> for every NPI.
        </p>
      </section>
    </article>
  );
}
