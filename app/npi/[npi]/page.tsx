import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { isValidNpi } from "@/lib/npi";
import { fullName, titleCase, formatZip, formatPhone } from "@/lib/format";
import {
  getProvider as getProviderUncached, getProviderExtras, getProviderChanges,
  getOigExclusions as getOigUncached, getOpenPayments as getOpUncached, getMedicare, getCareCompare, describeChange, OTHER_NAME_TYPES,
  ORDER_REFER_PROGRAMS, ASSIGNMENT_LABELS, type ProviderRow, type Medicare, type CareCompare,
} from "@/lib/provider";

// generateMetadata and the page both need these; cache() makes it one query per render.
const getProvider = cache(getProviderUncached);
const getOigExclusions = cache(getOigUncached);
const getOpenPayments = cache(getOpUncached);
import { slugify, cityStateSlug } from "@/lib/slug";
import { stateName, STATE_NAMES } from "@/lib/states";
import { Breadcrumbs, LinkChips } from "@/app/_components/facet";
import { oigSection, oigTypeLabel, OIG_VERIFY_URL } from "@/lib/oig";
import { licenseVerification } from "@/lib/license";

// Rendered on every request, NOT cached: without generateStaticParams, Next 15 doesn't ISR a dynamic
// route, so `revalidate` here has no effect. Deliberate since 2026-10-07: ~21 ms p50 at ~22k hits/h,
// and caching ~9M pages would write them all to disk as they're crawled. Data is therefore always live;
// no purge is needed after a load.
export const revalidate = 2592000;
export const dynamicParams = true;

const usdWhole = (s: string) => Number(s).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const usd = (s: string) => Number(s).toLocaleString("en-US", { style: "currency", currency: "USD" });

const monthYear = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function locationLine(p: ProviderRow): string {
  return [titleCase(p.practice_city), p.practice_state].filter(Boolean).join(", ");
}

export async function generateMetadata({ params }: { params: Promise<{ npi: string }> }): Promise<Metadata> {
  const { npi } = await params;
  const [p, oig, op] = await Promise.all([getProvider(npi), getOigExclusions(npi), getOpenPayments(npi)]);
  if (!p) return { title: `Provider not found — NPIRadar` };
  const name = fullName(p);
  const loc = locationLine(p);
  const paid = op.years[0];
  // Lead the description with the facts CMS's registry doesn't show: an exclusion, then industry payments.
  const facts = [
    oig.length > 0 ? "On the HHS OIG exclusion list." : null,
    p.medicare_opted_out ? "Opted out of Medicare." : null,
    paid ? `Received ${usdWhole(paid.total_usd)} from ${paid.companies} drug and device ${paid.companies === 1 ? "company" : "companies"} in ${paid.program_year} (Open Payments).` : null,
  ].filter(Boolean).join(" ");
  return {
    title: `${name}${p.credential ? `, ${p.credential}` : ""} — NPI ${p.npi}${paid ? " · Open Payments" : ""}`,
    description:
      `${name}${p.specialty ? `, ${p.specialty}` : ""}${loc ? ` in ${loc}` : ""}. ` +
      (facts ? `${facts} ` : "") +
      `NPI ${p.npi}: practice location, specialty, license and registry history.`,
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

// Enrollment, order/referral eligibility and opt-out, each with its own "as of". Absence is stated
// only once a file is loaded; ordering and opt-out apply to individual clinicians only.
function MedicareSection({ m, individual }: { m: Medicare; individual: boolean }) {
  if (!m.loaded) return null;
  const current = m.optOuts.filter((o) => o.current);
  const past = m.optOuts.filter((o) => !o.current);
  const can = m.orderRefer ? ORDER_REFER_PROGRAMS.filter(([k]) => m.orderRefer![k]).map(([, l]) => l) : [];
  const cannot = m.orderRefer ? ORDER_REFER_PROGRAMS.filter(([k]) => !m.orderRefer![k]).map(([, l]) => l) : [];
  const types = [...new Set(m.enrollments.map((e) => titleCase(e.provider_type)).filter(Boolean))];
  const states = [...new Set(m.enrollments.map((e) => e.state).filter(Boolean))];
  // ~90% of enrollments have no date set (CMS's lookup shows "TBD").
  const revalDates = m.revalidation.filter((r) => r.due);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section>
      <h2>Medicare</h2>
      {current.length > 0 && (
        <p className="banner">
          <strong>Opted out of Medicare</strong>{" "}
          {current.map((o, i) => (
            <span key={i}>{i > 0 ? "; " : ""}from {o.effective_date ?? "?"} to {o.end_date ?? "?"}{o.state ? ` (${o.state})` : ""}</span>
          ))}
          . Medicare doesn&apos;t pay for this clinician&apos;s services during an opt-out; patients pay under a private contract.
        </p>
      )}
      <dl className="facts">
        <dt>Enrollment</dt>
        <dd>
          {m.enrollments.length > 0
            ? <>Enrolled{types.length ? `: ${types.join("; ")}` : ""}{states.length ? ` (${states.join(", ")})` : ""}</>
            : "Not in CMS's public Medicare enrollment file"}
          {m.asOf.enrollment && <span className="sub"> · as of {m.asOf.enrollment}</span>}
        </dd>
        {individual && (
          <>
            <dt>Order &amp; refer</dt>
            <dd>
              {!m.orderRefer
                ? "Not on CMS's Order and Referring list. Medicare may deny claims that name this NPI as the ordering or referring provider."
                : <>Eligible for {can.join(", ")}{cannot.length ? <span className="sub"> · not for {cannot.join(", ")}</span> : null}</>}
              {m.asOf.orderReferring && <span className="sub"> · as of {m.asOf.orderReferring}</span>}
            </dd>
          </>
        )}
        {m.revalidation.length > 0 && (
          <>
            <dt>Revalidation</dt>
            <dd>
              {revalDates.length > 0
                ? revalDates.map((r, i) => (
                    <span key={i}>{i > 0 ? "; " : ""}due {r.due}{r.state ? ` (${r.state})` : ""}{r.due! < today ? ", date passed" : ""}</span>
                  ))
                : "No due date set by CMS yet"}
              {revalDates.length > 0 && revalDates.length < m.revalidation.length ? <span className="sub"> · other enrollments: no date set yet</span> : null}
              {m.asOf.revalidation && <span className="sub"> · as of {m.asOf.revalidation}</span>}
            </dd>
          </>
        )}
        {individual && past.length > 0 && (
          <>
            <dt>Past opt-outs</dt>
            <dd>
              {past.map((o, i) => (
                <span key={i}>{i > 0 ? "; " : ""}{o.effective_date ?? "?"} to {o.end_date ?? "?"}{o.state ? ` (${o.state})` : ""}</span>
              ))}
            </dd>
          </>
        )}
      </dl>
      <p className="sub">
        From CMS&apos;s public Medicare files on data.cms.gov, matched by NPI. Confirm in{" "}
        <a href="https://pecos.cms.hhs.gov/" rel="nofollow noopener">PECOS</a> before relying on it.
      </p>
    </section>
  );
}

// Background, group practices and facility affiliations from Medicare's Care Compare (Medicare-enrolled
// clinicians only). Shown only when Care Compare lists the NPI; absence says nothing.
function CareCompareSection({ c, npi }: { c: CareCompare; npi: string }) {
  const k = c.clinician;
  if (!k && c.affiliations.length === 0) return null;
  const secondary = k?.secondary_specialties?.split(",").map((s) => titleCase(s.trim())).filter(Boolean) ?? [];
  const facilities = c.affiliations.map((a) =>
    a.name
      ? `${titleCase(a.name)}${a.city ? `, ${titleCase(a.city)}, ${a.state}` : ""}${a.facility_type !== "Hospital" ? ` (${a.facility_type.toLowerCase()})` : ""}`
      : `${a.facility_type}, CMS certification number ${a.ccn}`);
  return (
    <section>
      <h2>Medicare Care Compare</h2>
      <dl className="facts">
        {k?.med_school && (<><dt>Medical school</dt><dd>{titleCase(k.med_school)}{k.grad_year ? `, ${k.grad_year}` : ""}</dd></>)}
        {!k?.med_school && k?.grad_year && (<><dt>Graduated</dt><dd>{k.grad_year}</dd></>)}
        {secondary.length > 0 && (<><dt>Secondary specialties</dt><dd>{secondary.join(", ")}</dd></>)}
        {k?.assignment && (<><dt>Medicare assignment</dt><dd>{ASSIGNMENT_LABELS[k.assignment]}</dd></>)}
        {k?.telehealth && (<><dt>Telehealth</dt><dd>Offers telehealth services</dd></>)}
      </dl>
      {c.groupCount > 0 && (
        <>
          <h3>Group practices ({c.groupCount})</h3>
          <ul>
            {c.groups.map((g) => (
              <li key={g.org_pac_id}>
                {titleCase(g.group_name) ?? `PAC ID ${g.org_pac_id}`}
                <span className="sub">
                  {g.group_members ? ` · ${g.group_members.toLocaleString()} clinicians` : ""}
                  {g.cities?.length ? ` · ${g.cities.slice(0, 3).join("; ")}${g.cities.length > 3 ? ` +${g.cities.length - 3}` : ""}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {c.groupCount > c.groups.length && (
            <p className="sub">Showing {c.groups.length} of {c.groupCount}. The full list is in the <a href={`/api/npi/${npi}`}>JSON API</a>.</p>
          )}
        </>
      )}
      {facilities.length > 0 && (
        <>
          <h3>Hospital and facility affiliations ({facilities.length})</h3>
          <ul>{facilities.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </>
      )}
      <p className="sub">From CMS&apos;s Care Compare data for Medicare-enrolled clinicians{c.asOf ? `, as of ${c.asOf}` : ""}.</p>
    </section>
  );
}

export default async function ProviderPage({ params }: { params: Promise<{ npi: string }> }) {
  const { npi } = await params;
  const [p, x, changes, oig, op, mc, cc] = await Promise.all([
    getProvider(npi), getProviderExtras(npi), getProviderChanges(npi), getOigExclusions(npi), getOpenPayments(npi), getMedicare(npi),
    getCareCompare(npi),
  ]);
  if (!p) notFound();

  const name = fullName(p);
  const loc = locationLine(p);
  const valid = isValidNpi(p.npi);
  const lv = p.license_number ? licenseVerification(p) : null;
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

      {oig.length > 0 && (
        <div className="banner">
          <strong>This NPI is on the HHS OIG List of Excluded Individuals/Entities (LEIE).</strong>{" "}
          {oig.map((e, i) => (
            <span key={i}>
              {i > 0 ? "; " : ""}Excluded {e.excl_date ? `since ${e.excl_date} ` : ""}under {oigSection(e.excl_type)}
              {oigTypeLabel(e.excl_type) ? ` (${oigTypeLabel(e.excl_type)})` : ""}
              {e.waiver_date ? `, with a waiver from ${e.waiver_date}${e.waiver_state ? ` in ${e.waiver_state}` : ""}` : ""}
            </span>
          ))}
          . Matched by NPI to OIG&apos;s list{oig[0].loaded_at ? ` as of ${oig[0].loaded_at}` : ""}. Confirm at{" "}
          <a href={OIG_VERIFY_URL} rel="nofollow noopener">exclusions.oig.hhs.gov</a> before relying on it. To check
          a list of NPIs at once, use the <Link href="/oig-exclusion-check">OIG exclusion check</Link>.
        </div>
      )}

      <dl className="facts">
        <dt>NPI</dt><dd>{p.npi}</dd>
        <dt>Type</dt><dd>{p.entity_type === "org" ? "Organization (Type 2)" : "Individual (Type 1)"}</dd>
        {p.specialty && (<><dt>Primary specialty</dt><dd>{p.specialty}{p.classification && p.classification !== p.specialty ? ` (${p.classification})` : ""}</dd></>)}
        {p.grouping && (<><dt>Specialty group</dt><dd>{p.grouping}</dd></>)}
        {p.primary_taxonomy_code && (<><dt>Taxonomy code</dt><dd>{p.specialty_slug ? <Link href={`/specialty/${p.specialty_slug}`}>{p.primary_taxonomy_code}</Link> : p.primary_taxonomy_code}</dd></>)}
        {p.license_number && (<><dt>License number</dt><dd>{p.license_number}{p.license_state ? ` (${p.license_state})` : ""}{lv && (
          <span className="sub"> · {lv.url ? <a href={lv.url} rel="nofollow noopener">{lv.text}</a> : lv.text}</span>
        )}</dd></>)}
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

      <MedicareSection m={mc} individual={p.entity_type !== "org"} />
      <CareCompareSection c={cc} npi={p.npi} />

      {op.latestYear !== null && (
        <section>
          <h2>Payments from drug and device companies</h2>
          <p className="sub">
            General payments reported to CMS Open Payments, as published (disputed payments included).
            Reporting a payment does not imply wrongdoing. <Link href="/open-payments">About Open Payments</Link>.
          </p>
          <table className="bulk">
            <thead><tr><th>Year</th><th>Total</th><th>Payments</th><th>Companies</th></tr></thead>
            <tbody>
              {op.years.map((y) => (
                <tr key={y.program_year}>
                  <td>{y.program_year}</td><td>{usd(y.total_usd)}</td><td>{y.payments.toLocaleString()}</td><td>{y.companies}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {op.companies.length > 0 && (
            <>
              <h3>Top companies, {op.latestYear}</h3>
              <ul>{op.companies.map((c, i) => <li key={i}>{c.company ?? "Unknown"} · {usd(c.total_usd)}</li>)}</ul>
            </>
          )}
          {op.natures.length > 0 && (
            <>
              <h3>By type, {op.latestYear}</h3>
              <ul>{op.natures.map((n, i) => <li key={i}>{n.nature ?? "Other"} · {usd(n.total_usd)} ({n.payments.toLocaleString()})</li>)}</ul>
            </>
          )}
        </section>
      )}

      {x.otherNames.length > 0 && (
        <section>
          <h2>Other names</h2>
          <ul>
            {x.otherNames.map((n, i) => (
              <li key={i}>{titleCase(n.name)}{OTHER_NAME_TYPES[n.type_code ?? ""] ? <span className="sub"> · {OTHER_NAME_TYPES[n.type_code ?? ""]}</span> : null}</li>
            ))}
          </ul>
        </section>
      )}

      {x.locationCount > 0 && (
        <section>
          <h2>Other practice locations ({x.locationCount})</h2>
          <ul>
            {x.locations.map((l, i) => (
              <li key={i}>
                {[titleCase(l.addr1), titleCase(l.addr2), titleCase(l.city), [l.state, formatZip(l.zip)].filter(Boolean).join(" "),
                  l.country && l.country !== "US" ? l.country : null].filter(Boolean).join(", ")}
                {l.phone ? <span className="sub"> · {formatPhone(l.phone)}</span> : null}
              </li>
            ))}
          </ul>
          {x.locationCount > x.locations.length && (
            <p className="sub">Showing {x.locations.length} of {x.locationCount}. The full list is in the <a href={`/api/npi/${p.npi}`}>JSON API</a>.</p>
          )}
        </section>
      )}

      {x.endpointCount > 0 && (
        <section>
          <h2>Electronic endpoints ({x.endpointCount})</h2>
          <p className="sub">Direct secure-messaging addresses and health-data (FHIR, CONNECT, SOAP) URLs registered for this NPI.</p>
          <ul>
            {x.endpoints.map((e, i) => (
              <li key={i}>
                <strong>{e.endpoint_type_desc ?? e.endpoint_type}</strong>: <code>{e.endpoint}</code>
                {e.affiliation_name ? <span className="sub"> · {e.affiliation_name}</span> : null}
              </li>
            ))}
          </ul>
          {x.endpointCount > x.endpoints.length && (
            <p className="sub">Showing {x.endpoints.length} of {x.endpointCount}. The full list is in the <a href={`/api/npi/${p.npi}`}>JSON API</a>.</p>
          )}
        </section>
      )}

      {changes.length > 0 && (
        <section>
          <h2>Registry history</h2>
          <p className="sub">Changes NPIRadar detected between monthly NPPES releases. CMS publishes only the current record.</p>
          <ul>
            {changes.map(describeChange).map((c, i) => (
              <li key={i}>
                <span className="sub">{monthYear(c.release)}</span> · <strong>{c.label}</strong>
                {c.from || c.to ? <>: {c.from ?? "—"} → {c.to ?? "—"}</> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!p.deactivation_date && related.length > 0 && (
        <LinkChips title="Find more providers" links={related} />
      )}
    </article>
  );
}
