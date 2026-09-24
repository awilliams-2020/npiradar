import { SITE_URL } from "@/lib/sitemap";
import { DATA_VINTAGE } from "@/lib/format";

// Home-page structured data + the visible FAQ that backs it. One Q&A source of truth drives both the
// on-page copy and the FAQPage JSON-LD, so the rich-result markup can never drift from what a reader
// (or an answer engine) actually sees. Also emits Dataset JSON-LD describing the NPPES corpus, which
// makes NPIRadar citable as a data source. Server-only; no client JS.

const FAQS: { q: string; a: string }[] = [
  {
    q: "What is an NPI number?",
    a:
      "An NPI (National Provider Identifier) is a unique 10-digit number that CMS assigns to every US " +
      "healthcare provider — both individuals (a doctor, dentist, or nurse) and organizations (a clinic, " +
      "hospital, or pharmacy) — through the National Plan & Provider Enumeration System (NPPES). It appears " +
      "on insurance claims and prescriptions and does not change over a provider's career.",
  },
  {
    q: "How do I find a provider's NPI number?",
    a:
      "Enter the provider's name or their 10-digit NPI in the search box on NPIRadar. Every provider in the " +
      "public NPPES registry has a detail page showing their specialty, taxonomy, credentials, and practice " +
      "location.",
  },
  {
    q: "How do I find my own NPI number?",
    a:
      "Search your name on NPIRadar, or look it up in the official NPPES registry. Your NPI is assigned when " +
      "you enumerate with CMS and stays the same for life, even if you change name, specialty, or employer.",
  },
  {
    q: "Is the NPI lookup free?",
    a:
      "Yes. NPI lookup, name and specialty search, the NPI validator, and bulk lookup are all free. A free, " +
      `CORS-open JSON API is also available at ${SITE_URL}/api/npi/{npi}, with no key required.`,
  },
  {
    q: "Is NPIRadar affiliated with CMS or NPPES?",
    a:
      "No. NPIRadar is an independent directory built on the public-domain NPPES dataset published by CMS. " +
      "It is not affiliated with or endorsed by CMS.",
  },
];

export function HomeStructuredData() {
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  const datasetLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "NPIRadar — US healthcare provider directory (NPPES)",
    description:
      "Searchable directory of US healthcare providers and their National Provider Identifiers (NPIs), " +
      "derived from the public-domain NPPES dataset published by CMS. Covers individual and organizational " +
      "providers with specialty/taxonomy, credentials, and practice location.",
    url: SITE_URL,
    keywords: [
      "NPI",
      "National Provider Identifier",
      "NPPES",
      "healthcare provider directory",
      "physician lookup",
      "provider taxonomy",
    ],
    license: "https://www.usa.gov/government-works",
    isAccessibleForFree: true,
    version: DATA_VINTAGE,
    creator: {
      "@type": "GovernmentOrganization",
      name: "Centers for Medicare & Medicaid Services",
      alternateName: "CMS",
      url: "https://www.cms.gov",
    },
    isBasedOn: "https://download.cms.gov/nppes/NPI_Files.html",
    distribution: {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${SITE_URL}/api/npi/{npi}`,
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetLd) }} />
      <section className="faq" style={{ marginTop: 36 }}>
        <h2>Frequently asked questions</h2>
        {FAQS.map((f) => (
          <div key={f.q} style={{ marginTop: 16 }}>
            <h3>{f.q}</h3>
            <p className="sub">{f.a}</p>
          </div>
        ))}
      </section>
    </>
  );
}
