import type { Metadata } from "next";
import Link from "next/link";
import { query } from "@/lib/db";
import { topSpecialties, topCities } from "@/lib/facets";
import { LinkChips, specialtyLinks, cityLinks } from "@/app/_components/facet";
import { HomeStructuredData } from "@/app/_components/home-structured-data";

// Render per-request (not prerendered at build, where the DB is unreachable) so the count reflects
// the live registry after a deploy or monthly refresh.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "NPI Lookup — Find Any US Healthcare Provider by NPI Number",
  description:
    "Free NPI lookup over the public NPPES registry. Search 9.5 million US healthcare providers by NPI " +
    "number, name, specialty, or city, and see each provider's taxonomy and practice location.",
  alternates: { canonical: "/" },
};

type Stats = { providers: string; active: string };

// Simple in-process TTL cache so the count(*) (~0.5s on 9.5M rows) runs at most once a day per
// instance — no dependency on Next's on-disk data cache.
let cache: { value: Stats | null; at: number } = { value: null, at: 0 };
const DAY = 86_400_000;

async function getStats(): Promise<Stats | null> {
  if (cache.value && Date.now() - cache.at < DAY) return cache.value;
  const rows = await query<Stats>(
    `SELECT count(*)::text AS providers,
            count(*) FILTER (WHERE deactivation_date IS NULL)::text AS active
     FROM providers`,
  );
  const value = rows[0] ?? null;
  // Never memoize an empty/zero count for a day: during a reload swap or a transient DB blip the
  // count can momentarily read 0, and a poisoned cache would keep showing "0 providers" for 24h
  // after the data is back. Cache only a real, non-zero count; otherwise re-query next request.
  if (value && Number(value.providers) > 0) cache = { value, at: Date.now() };
  return value;
}

export default async function Home() {
  let stats: Stats | null = null;
  let specialties: Awaited<ReturnType<typeof topSpecialties>> = [];
  let cities: Awaited<ReturnType<typeof topCities>> = [];
  try {
    [stats, specialties, cities] = await Promise.all([getStats(), topSpecialties(14), topCities(14)]);
  } catch {
    // DB unavailable — homepage still renders the static content below.
  }

  return (
    <>
      <h1>NPI lookup: find any US healthcare provider</h1>
      <p className="sub">
        Every US healthcare provider has a 10-digit National Provider Identifier (NPI). Enter one below, or
        search by name, to see that provider&apos;s specialty, practice location, and registry details.
      </p>

      <form className="search" action="/search">
        <input name="q" placeholder="NPI number or provider name" aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      {stats && (
        <p className="sub">
          Searching <strong>{Number(stats.providers).toLocaleString()}</strong> providers
          (<strong>{Number(stats.active).toLocaleString()}</strong> active) from the public NPPES registry.
        </p>
      )}

      <section className="tools">
        <Link href="/tools/bulk-lookup" className="card">
          <strong>Bulk NPI lookup</strong>
          <p className="sub">Paste up to 100 NPI numbers and look them all up at once, with CSV export.</p>
        </Link>
        <Link href="/tools/npi-validator" className="card">
          <strong>NPI validator</strong>
          <p className="sub">Check a 10-digit NPI&apos;s check digit instantly — runs in your browser.</p>
        </Link>
      </section>

      <LinkChips title="Popular specialties" links={specialtyLinks(specialties)} />
      <LinkChips title="Providers by city" links={cityLinks(cities)} />

      <section style={{ marginTop: 36 }}>
        <h2>What is an NPI?</h2>
        <p>
          The <strong>National Provider Identifier (NPI)</strong> is a unique 10-digit number assigned to every
          US healthcare provider, both individuals (a doctor, dentist, or nurse) and organizations (a clinic,
          hospital, or pharmacy). CMS issues it through the{" "}
          <Link href="/nppes"><strong>National Plan &amp; Provider Enumeration System (NPPES)</strong></Link>, and it appears on insurance
          claims and prescriptions. NPIRadar makes that public registry searchable: look up a provider by NPI
          number, browse <Link href="/specialty">providers by specialty</Link>, or find providers in your city.
          Developers can use the free <Link href="/npi-api">NPI API</Link>.
        </p>
        <p className="sub">
          Example: <Link href="/npi/1275073215">/npi/1275073215</Link>
        </p>
      </section>

      <HomeStructuredData />
    </>
  );
}
