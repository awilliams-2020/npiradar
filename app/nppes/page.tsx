import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { DATA_VINTAGE } from "@/lib/format";

// Explainer for the "nppes" / "nppes npi registry" / "npi registry" demand (Planner 2026-07: 74k / 40.5k /
// 135k per month, the domain's highest-CPC unclaimed terms). Answer-first, plain-text facts, no DB → static.
export const metadata: Metadata = {
  title: "NPPES NPI Registry Explained — What It Is and How to Search It",
  description:
    "NPPES is the CMS system that assigns every US healthcare provider a National Provider Identifier (NPI) " +
    "and publishes the NPI Registry. What it contains, how the data is released, and how to search it.",
  alternates: { canonical: "/nppes" },
};

export default function NppesPage() {
  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "NPPES NPI Registry", href: "/nppes" }]} />
      <h1>NPPES and the NPI Registry, explained</h1>
      <p className="sub">
        <strong>NPPES</strong> (the National Plan and Provider Enumeration System) is the system the Centers for
        Medicare &amp; Medicaid Services (CMS) uses to assign every US healthcare provider a unique 10-digit{" "}
        <strong>National Provider Identifier (NPI)</strong>. The public part of NPPES is the{" "}
        <strong>NPI Registry</strong>: a searchable record of each provider&apos;s NPI, name, specialty, and
        practice location. NPIRadar republishes that same public data as a browsable directory.
      </p>

      <section style={{ marginTop: 32 }}>
        <h2>What is in the NPPES NPI Registry?</h2>
        <p>Every NPI record is one of two entity types:</p>
        <ul>
          <li>
            <strong>Type 1 — individuals:</strong> physicians, dentists, nurses, therapists, pharmacists, and other
            individual practitioners, including sole proprietors.
          </li>
          <li>
            <strong>Type 2 — organizations:</strong> hospitals, clinics, group practices, pharmacies, labs, home
            health agencies, and suppliers.
          </li>
        </ul>
        <p>For each NPI, the public registry shows:</p>
        <ul>
          <li>Provider or organization name, and credentials for individuals</li>
          <li>Taxonomy code(s): the NUCC classification that serves as the provider&apos;s specialty</li>
          <li>Practice location and mailing address, with phone number</li>
          <li>State license number(s) tied to each taxonomy</li>
          <li>Enumeration date, last-updated date, and deactivation status</li>
        </ul>
        <p>
          An NPI is &ldquo;intelligence-free&rdquo;: the number encodes nothing about the provider except a final
          check digit, which you can test with the <Link href="/tools/npi-validator">NPI validator</Link>. It stays
          the same for life, even when the provider moves or changes specialty.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Who has to have an NPI?</h2>
        <p>
          HIPAA requires an NPI for any healthcare provider that bills electronically. The NPI replaced the older
          payer-specific identifiers (UPIN, Medicaid and commercial plan numbers) on claims, and it now appears on
          insurance claims, prescriptions, and referrals. Getting one is free: providers apply online through NPPES.
          Providers are also expected to update their NPPES record within 30 days of a change, such as a new practice
          address.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>How NPPES data is published</h2>
        <p>CMS releases the public NPPES data three ways:</p>
        <ul>
          <li>
            <strong>The NPI Registry website:</strong> a search form on CMS&apos;s site, for one provider at a time.
          </li>
          <li>
            <strong>The NPI Registry API:</strong> a free JSON API from CMS. Each request returns a capped page of
            results, so it works for lookups but not for pulling a whole specialty or city.
          </li>
          <li>
            <strong>The NPPES Downloadable File:</strong> a full monthly replacement file of every record (several
            GB of CSV), with weekly incremental updates. It&apos;s complete, but you need a database to use it.
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>How to search the NPI Registry on NPIRadar</h2>
        <p>
          NPIRadar loads the NPPES Downloadable File (currently the {DATA_VINTAGE}) into a database and indexes it
          the ways people actually search:
        </p>
        <ul>
          <li>
            <strong>By NPI number or name:</strong> the <Link href="/">NPI lookup</Link> on the home page.
          </li>
          <li>
            <strong>By specialty, then city:</strong> the <Link href="/specialty">specialty directory</Link> lists
            every NUCC taxonomy with its provider count.
          </li>
          <li>
            <strong>Many NPIs at once:</strong> <Link href="/tools/bulk-lookup">bulk NPI lookup</Link> takes up to
            100 numbers per batch, with CSV export.
          </li>
          <li>
            <strong>From code:</strong> the free <Link href="/npi-api">NPI API</Link> offers single, bulk (100 per
            request), and filtered search, as JSON with no key.
          </li>
        </ul>
        <p>
          NPIRadar is an independent directory. It is not affiliated with or endorsed by CMS. For an official
          record, or to update your own NPI data, use NPPES directly.
        </p>
      </section>
    </article>
  );
}
