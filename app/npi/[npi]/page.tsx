import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isValidNpi } from "@/lib/npi";
import { fullName, titleCase, formatZip, formatPhone } from "@/lib/format";
import { getProvider, type ProviderRow } from "@/lib/provider";
import { slugify, cityStateSlug } from "@/lib/slug";
import { stateName, STATE_NAMES } from "@/lib/states";
import { Breadcrumbs, LinkChips } from "@/app/_components/facet";

export const revalidate = 2592000; // 30d — matches the monthly NPPES refresh cadence
export const dynamicParams = true; // render any NPI on first request, then cache (ISR at 8M scale)

function locationLine(p: ProviderRow): string {
  return [titleCase(p.practice_city), p.practice_state].filter(Boolean).join(", ");
}

export async function generateMetadata({ params }: { params: Promise<{ npi: string }> }): Promise<Metadata> {
  const { npi } = await params;
  const p = await getProvider(npi);
  if (!p) return { title: `Provider not found — NPIRadar` };
  const name = fullName(p);
  const loc = locationLine(p);
  return {
    title: `${name}${p.credential ? `, ${p.credential}` : ""} — NPI ${p.npi}`,
    description:
      `${name}${p.specialty ? `, ${p.specialty}` : ""}${loc ? ` in ${loc}` : ""}. ` +
      `Look up NPI ${p.npi} for practice location, taxonomy, credentials, and other NPPES registry details.`,
    alternates: { canonical: `/npi/${p.npi}` },
    // Deactivated NPIs are kept reachable but excluded from the index (anti-thin-content).
    robots: p.deactivation_date ? { index: false, follow: true } : undefined,
  };
}

function JsonLd({ p }: { p: ProviderRow }) {
  const name = fullName(p);
  const address =
    p.practice_city && p.practice_state
      ? {
          "@type": "PostalAddress",
          streetAddress: [titleCase(p.practice_addr1), titleCase(p.practice_addr2)].filter(Boolean).join(", ") || undefined,
          addressLocality: titleCase(p.practice_city),
          addressRegion: p.practice_state,
          postalCode: formatZip(p.practice_zip) ?? undefined,
          addressCountry: "US",
        }
      : undefined;
  const data = {
    "@context": "https://schema.org",
    "@type": p.entity_type === "org" ? "MedicalOrganization" : "Physician",
    name,
    identifier: { "@type": "PropertyValue", propertyID: "NPI", value: p.npi },
    medicalSpecialty: p.specialty ?? undefined,
    address,
    telephone: formatPhone(p.practice_phone) ?? undefined,
    url: `https://npiradar.com/npi/${p.npi}`,
  };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}

export default async function ProviderPage({ params }: { params: Promise<{ npi: string }> }) {
  const { npi } = await params;
  const p = await getProvider(npi);
  if (!p) notFound();

  const name = fullName(p);
  const loc = locationLine(p);
  const valid = isValidNpi(p.npi);
  const street = [titleCase(p.practice_addr1), titleCase(p.practice_addr2)].filter(Boolean).join(", ");

  // Internal links into the facet graph (specialty / city / specialty×city) — the crawl + topical
  // signal that connects each provider page to the directory rather than leaving it an orphan.
  // Geo facets exist only for US states/territories (foreign practice locations have no facet page).
  const usState = p.practice_state && STATE_NAMES[p.practice_state] ? p.practice_state : null;
  const citySlug = usState && p.practice_city ? slugify(p.practice_city) : null;
  const cs = citySlug && usState ? cityStateSlug(citySlug, usState) : null;
  const related: { href: string; label: string }[] = [];
  if (p.specialty_slug) related.push({ href: `/specialty/${p.specialty_slug}`, label: `All ${p.specialty}` });
  if (citySlug && usState)
    related.push({ href: `/in/${usState.toLowerCase()}/${citySlug}`, label: `Providers in ${titleCase(p.practice_city)}, ${usState}` });
  if (p.specialty_slug && cs)
    related.push({ href: `/specialty/${p.specialty_slug}/${cs}`, label: `${p.specialty} in ${titleCase(p.practice_city)}, ${usState}` });

  const crumbs = [{ name: "Home", href: "/" }];
  if (p.specialty && p.specialty_slug) crumbs.push({ name: p.specialty, href: `/specialty/${p.specialty_slug}` });
  crumbs.push({ name, href: `/npi/${p.npi}` });

  return (
    <article>
      <JsonLd p={p} />
      <Breadcrumbs items={crumbs} />

      <h1>
        {name}
        {p.credential ? <span className="sub">, {p.credential}</span> : null}{" "}
        <span className={`badge ${valid ? "ok" : "bad"}`}>{valid ? "Valid NPI" : "Invalid check digit"}</span>
      </h1>
      <p className="sub">
        {p.entity_type === "org" ? "Organization" : "Individual provider"}
        {p.specialty ? ` · ${p.specialty}` : ""}
        {loc ? ` · ${loc}` : ""}
      </p>

      {p.deactivation_date && (
        <p className="banner">
          This NPI was <strong>deactivated</strong> on {p.deactivation_date} and is no longer active in the registry.
        </p>
      )}

      <dl className="facts">
        <dt>NPI</dt><dd>{p.npi}</dd>
        <dt>Type</dt><dd>{p.entity_type === "org" ? "Organization (Type 2)" : "Individual (Type 1)"}</dd>
        {p.specialty && (<><dt>Primary specialty</dt><dd>{p.specialty}{p.classification && p.classification !== p.specialty ? ` (${p.classification})` : ""}</dd></>)}
        {p.grouping && (<><dt>Specialty group</dt><dd>{p.grouping}</dd></>)}
        {p.primary_taxonomy_code && (<><dt>Taxonomy code</dt><dd>{p.primary_taxonomy_code}</dd></>)}
        {p.license_number && (<><dt>License number</dt><dd>{p.license_number}{p.license_state ? ` (${p.license_state})` : ""}</dd></>)}
        {p.sex && p.entity_type !== "org" && (<><dt>Sex</dt><dd>{p.sex === "F" ? "Female" : p.sex === "M" ? "Male" : p.sex}</dd></>)}
        {p.is_sole_proprietor != null && p.entity_type !== "org" && (<><dt>Sole proprietor</dt><dd>{p.is_sole_proprietor ? "Yes" : "No"}</dd></>)}
        {p.enumeration_date && (<><dt>Enumerated</dt><dd>{p.enumeration_date}</dd></>)}
        {p.last_update_date && (<><dt>Last updated</dt><dd>{p.last_update_date}</dd></>)}
      </dl>

      {(street || loc || p.practice_phone) && (
        <div className="card">
          <strong>Practice location</strong>
          <div>{street}</div>
          <div>{[loc, formatZip(p.practice_zip)].filter(Boolean).join(" ")}</div>
          {p.practice_phone && <div>{formatPhone(p.practice_phone)}</div>}
        </div>
      )}

      {!p.deactivation_date && related.length > 0 && (
        <LinkChips title="Find more providers" links={related} />
      )}
    </article>
  );
}
