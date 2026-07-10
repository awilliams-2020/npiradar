import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { BulkLookup } from "./bulk";

export const metadata: Metadata = {
  title: "Bulk NPI Lookup — Look Up Many NPI Numbers at Once",
  description:
    "Paste a list of NPI numbers and look them all up at once against the public NPPES registry — names, " +
    "specialties, and practice locations, with CSV export. Free, no signup.",
  alternates: { canonical: "/tools/bulk-lookup" },
};

export default function BulkLookupPage() {
  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Bulk NPI Lookup", href: "/tools/bulk-lookup" }]} />
      <h1>Bulk NPI lookup</h1>
      <p className="sub">
        Paste up to 100 NPI numbers and look them all up at once. You get each provider&apos;s name, specialty, and
        practice location from the public NPPES registry, with one-click CSV export. Handy for billing,
        credentialing, and claims teams cleaning up provider lists.
      </p>

      <BulkLookup />

      <section style={{ marginTop: 32 }}>
        <h2>How it works</h2>
        <p>
          Each NPI is checked against the public NPPES registry via our{" "}
          <Link href="/tools/npi-validator">NPI validator</Link> and lookup. Need a single provider instead?
          Use the <Link href="/">NPI search</Link>. Developers can call the same data programmatically at{" "}
          <code>https://npiradar.com/api/npi/&#123;npi&#125;</code> (returns JSON, CORS-enabled, no key required).
        </p>
      </section>
    </article>
  );
}
