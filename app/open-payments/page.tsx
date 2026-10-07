import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { opNational, usd } from "@/lib/insights";
import { titleCase } from "@/lib/format";

// Targets "open payments" lookups and "dollars for docs" (720/mo; ProPublica's tool stopped at 2018 data,
// last updated Oct 2019 per its own page). Planner 2026-10, see ~/scripts/seo/audits/npiradar.md.
// Rendered per request: the build has no DB. The stats behind it are cached per instance for a day
// (lib/insights.ts), so this costs one query set per day, not per hit.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Open Payments Lookup — What Drug and Device Companies Paid Your Doctor",
  description:
    "Search CMS Open Payments by doctor: yearly totals, the companies that paid, and what for (food, consulting, " +
    "speaking, royalties). Current data, free.",
  alternates: { canonical: "/open-payments" },
};

const FAQ = [
  {
    q: "What is Open Payments?",
    a: "A federal program run by CMS under the Physician Payments Sunshine Act. Drug and medical device makers " +
      "must report what they pay doctors, physician assistants, nurse practitioners and other clinicians, " +
      "from a sandwich to a consulting fee. CMS publishes each year's data the following June and corrects it later.",
  },
  {
    q: "Does a payment mean a doctor did something wrong?",
    a: "No. Most payments are routine: meals at a sales visit, travel to a meeting, fees for speaking or research " +
      "advice. The data shows who paid what, not why, and doctors can dispute entries. NPIRadar shows payments as CMS " +
      "publishes them, disputed ones included.",
  },
  {
    q: "Is this the same as ProPublica's Dollars for Docs?",
    a: "It uses the same public source. ProPublica's Dollars for Docs was last updated in October 2019 and covers " +
      "payments through 2018. NPIRadar loads the latest years CMS has published and reloads a year when CMS corrects it.",
  },
  {
    q: "What isn't included?",
    a: "Research payments and ownership interests are separate CMS files and aren't shown here. Payments to teaching " +
      "hospitals aren't shown either, because they aren't tied to an individual NPI.",
  },
];

export default async function OpenPaymentsPage() {
  const s = await opNational();
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  const latest = s?.years[0];

  return (
    <article>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Open Payments", href: "/open-payments" }]} />
      <h1>Open Payments lookup: what companies paid your doctor</h1>
      <p className="sub">
        Find a doctor by name and open their page. It lists what drug and device companies paid them each year,
        which companies, and for what.
        {latest ? ` In ${latest.program_year}, ${latest.recipients.toLocaleString()} clinicians received ${usd(latest.total_usd)} in general payments.` : ""}
      </p>

      <form action="/search" method="get" className="bulk-actions" style={{ marginTop: 16 }}>
        <input type="search" name="q" placeholder="Doctor's last name, or an NPI number" aria-label="Doctor name or NPI" required />
        <button type="submit">Search</button>
      </form>

      {s && (
        <>
          <section style={{ marginTop: 32 }}>
            <h2>General payments by year</h2>
            <table className="bulk">
              <thead><tr><th>Year</th><th>Total</th><th>Clinicians paid</th><th>Payments</th></tr></thead>
              <tbody>
                {s.years.map((y) => (
                  <tr key={y.program_year}>
                    <td>{y.program_year}</td><td>{usd(y.total_usd)}</td>
                    <td>{y.recipients.toLocaleString()}</td><td>{y.payments.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={{ marginTop: 32 }}>
            <h2>What the money was for, {s.latestYear}</h2>
            <table className="bulk">
              <thead><tr><th>Type</th><th>Total</th></tr></thead>
              <tbody>
                {s.natures.map((n) => (
                  <tr key={n.nature}><td>{n.nature}</td><td>{usd(n.total_usd)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={{ marginTop: 32 }}>
            <h2>Specialties paid the most, {s.latestYear}</h2>
            <table className="bulk">
              <thead><tr><th>Specialty</th><th>Total</th><th>Clinicians paid</th></tr></thead>
              <tbody>
                {s.specialties.map((sp) => (
                  <tr key={sp.specialty}>
                    <td>{sp.slug ? <Link href={`/specialty/${sp.slug}`}>{sp.specialty}</Link> : sp.specialty}</td>
                    <td>{usd(sp.total_usd)}</td><td>{sp.recipients.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={{ marginTop: 32 }}>
            <h2>Largest individual totals, {s.latestYear}</h2>
            {s.topRecipientNatures.length > 0 && (
              <p className="sub">
                Main payment type for these {s.topRecipients.length}:{" "}
                {s.topRecipientNatures.map((n) => `${n.nature.toLowerCase()} (${n.n})`).join(", ")}.
              </p>
            )}
            <ol>
              {s.topRecipients.map((r) => (
                <li key={r.npi}>
                  <Link href={`/npi/${r.npi}`}>{titleCase(r.name) ?? r.npi}</Link>
                  {r.specialty ? `, ${r.specialty}` : ""}
                  {r.city ? `, ${titleCase(r.city)}, ${r.state}` : ""} · {usd(r.total_usd)}
                </li>
              ))}
            </ol>
          </section>
        </>
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
          Source: CMS Open Payments, general payments. The same figures are in the free{" "}
          <Link href="/npi-api">NPI API</Link> as <code>openPayments</code>.
        </p>
      </section>
    </article>
  );
}
