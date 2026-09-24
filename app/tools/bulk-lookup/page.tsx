import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { BulkLookup } from "./bulk";
import { DATA_VINTAGE } from "@/lib/format";

export const metadata: Metadata = {
  title: "Bulk NPI Lookup — Look Up Many NPI Numbers at Once",
  description:
    "Paste a list of NPI numbers and look them all up at once against the public NPPES registry — names, " +
    "specialties, and practice locations, with CSV export. Free, no signup — plus a free bulk NPI API.",
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
          Paste NPIs in any format: one per line, comma-separated, or copied straight out of a spreadsheet
          column. The tool pulls out every 10-digit number, drops duplicates, and looks up the first 100 in a single
          request against the NPPES registry ({DATA_VINTAGE}). Results come back in the order you pasted them, so
          the CSV lines up row-for-row with your original list. Need a single provider instead? Use the{" "}
          <Link href="/">NPI search</Link>.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>What the CSV contains</h2>
        <p>One row per NPI, with these columns:</p>
        <ul>
          <li><code>npi</code>: the number you entered</li>
          <li>
            <code>status</code>: <code>ok</code> (found), <code>not_found</code> (10 digits, but not in the
            registry), or <code>error</code> (the lookup failed; retry)
          </li>
          <li><code>valid</code>: whether the NPI passes its check digit</li>
          <li><code>name</code> and <code>entityType</code>: the provider or organization, individual or organization</li>
          <li><code>specialty</code>: the primary taxonomy, e.g. &ldquo;Physical Therapy Clinic/Center&rdquo;</li>
          <li><code>city</code> and <code>state</code>: the practice location</li>
        </ul>
        <p>
          A <code>not_found</code> row usually means a typo. Check it with the{" "}
          <Link href="/tools/npi-validator">NPI validator</Link>, which tells you whether the number could be a real
          NPI at all. Each provider also has a full record page (taxonomy codes, license, and dates) at{" "}
          <code>npiradar.com/npi/&#123;npi&#125;</code>.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Common uses</h2>
        <ul>
          <li>
            <strong>Credentialing and enrollment:</strong> confirm that every provider on a roster has an active NPI
            with the expected specialty.
          </li>
          <li>
            <strong>Claims and billing clean-up:</strong> catch mistyped or unassigned NPIs before a claim is
            rejected for them.
          </li>
          <li>
            <strong>Referral and network lists:</strong> fill in names and practice locations for a list of bare NPI
            numbers.
          </li>
        </ul>
        <p>
          For more than 100 at a time, run the list in batches or script it against the API below. For the whole
          registry, see <Link href="/nppes">how NPPES publishes its data</Link>.
        </p>
      </section>

      <section style={{ marginTop: 32 }} id="api">
        <h2>Bulk NPI API</h2>
        <p>
          The same batch lookup is available as JSON: <code>POST /api/npi</code> with up to 100 NPIs per request.
          It&apos;s free and CORS-enabled, with no key. Single lookups and provider search are there too. See the{" "}
          <Link href="/npi-api">NPI API docs</Link>.
        </p>
      </section>
    </article>
  );
}
