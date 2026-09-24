import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/app/_components/facet";
import { DATA_VINTAGE } from "@/lib/format";

// Docs for the public API (app/api/npi, app/api/search). Its own page so "npi api" / "free npi api" /
// "npi lookup api" land on a page about the API, rather than an H2 at the bottom of the bulk tool.
// Rate-limit numbers mirror lib/ratelimit.ts defaults — keep in step if those change.
export const metadata: Metadata = {
  title: "Free NPI API — JSON NPI Lookup, Bulk Lookup, and Provider Search",
  description:
    "Free NPI API over the NPPES registry. Look up one NPI, up to 100 NPIs per request, or search providers by " +
    "name, specialty, state, and city. JSON, CORS-enabled, no API key or signup.",
  alternates: { canonical: "/npi-api" },
};

const single = `{
  "npi": "1306701685",
  "valid": true,
  "entityType": "organization",
  "name": "Dc Physical Therapy Services Pc",
  "specialty": "Physical Therapy Clinic/Center",
  "taxonomyCode": "261QP2000X",
  "practiceLocation": {
    "address1": "100 Nicolls Rd", "city": "Wheatley Heights",
    "state": "NY", "zip": "11798-2315", "phone": "(516) 234-4473"
  },
  "enumerationDate": "2025-12-18",
  "lastUpdated": "2025-12-18",
  "deactivated": false,
  "source": "NPPES",
  "url": "https://npiradar.com/npi/1306701685"
}`;

export default function NpiApiPage() {
  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "NPI API", href: "/npi-api" }]} />
      <h1>Free NPI API</h1>
      <p className="sub">
        A free JSON API over the public NPPES registry ({DATA_VINTAGE}). Look up a single NPI, batch up to 100 NPIs
        per request, or search providers by name, specialty, state, and city. No API key and no signup. Responses
        are CORS-enabled, so you can call it straight from a browser.
      </p>

      <section style={{ marginTop: 32 }}>
        <h2>Endpoints</h2>

        <div className="api-ep">
          <h3><span className="verb get">GET</span>/api/npi/&#123;npi&#125;</h3>
          <p>
            Look up one provider by 10-digit NPI. Returns the name, entity type, specialty and taxonomy code, license,
            practice location, and enumeration, update, and deactivation dates. Returns <code>400</code> for a
            malformed NPI and <code>404</code> when the NPI isn&apos;t in the registry.
          </p>
          <pre><code>{`curl https://npiradar.com/api/npi/1306701685`}</code></pre>
          <pre><code>{single}</code></pre>
        </div>

        <div className="api-ep">
          <h3><span className="verb post">POST</span>/api/npi</h3>
          <p>
            Bulk lookup: up to 100 NPIs in one request. The response returns <code>results</code> for NPIs found,
            plus <code>notFound</code> (10 digits but not in the registry) and <code>invalid</code> (not a 10-digit
            number) lists, so a messy input list is fine. Duplicates are dropped.
          </p>
          <pre><code>{`curl -X POST https://npiradar.com/api/npi \\
  -H "Content-Type: application/json" \\
  -d '{"npis": ["1306701685", "1234567890", "123"]}'

# → {"count": 1, "results": [ … ], "notFound": ["1234567890"], "invalid": ["123"]}`}</code></pre>
        </div>

        <div className="api-ep">
          <h3><span className="verb get">GET</span>/api/search</h3>
          <p>
            Find providers when you don&apos;t know the NPI. Filters: <code>name</code> (last or organization name
            prefix), <code>specialty</code> (a slug such as <code>occupational-therapist</code>, as used in{" "}
            <Link href="/specialty">specialty URLs</Link>), <code>state</code> (2-letter), and <code>city</code> (a
            slug; requires <code>state</code>). At least one of name, specialty, or state is required. Page through
            results with <code>limit</code> (max 50) and a 0-based <code>page</code>; <code>hasMore</code> tells
            you when to stop.
          </p>
          <pre><code>{`curl "https://npiradar.com/api/search?specialty=occupational-therapist&state=ca&city=pasadena&limit=2"`}</code></pre>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>Rate limits</h2>
        <p>
          Each IP gets a shared budget of 600 tokens per minute across all endpoints. A single lookup costs 1 token,
          a bulk request costs 1 per NPI, and a search costs 10. Every response carries{" "}
          <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, and <code>X-RateLimit-Reset</code>.
          Past the limit you get <code>429</code> with a <code>Retry-After</code> header. That&apos;s about 36,000
          bulk-resolved NPIs an hour. If you need the entire registry, the monthly NPPES Downloadable File is the
          better tool (see <Link href="/nppes">NPPES explained</Link>).
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>How it compares to the CMS NPI Registry API</h2>
        <p>
          CMS runs its own free NPI Registry API over the same data. NPIRadar&apos;s API adds a true batch endpoint
          (100 NPIs in one call instead of 100 calls) that sorts a messy list into found, not-found, and malformed
          numbers, plus filtered search by specialty and city slug. Both are free. If you&apos;d rather not
          write code, the <Link href="/tools/bulk-lookup">bulk NPI lookup tool</Link> makes the same batch call
          from a web form and exports CSV.
        </p>
        <p>
          The data is public-domain NPPES data. NPIRadar is an independent service, not affiliated with CMS. If you
          build on the API, please link back to npiradar.com.
        </p>
      </section>
    </article>
  );
}
