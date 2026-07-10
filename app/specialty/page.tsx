import type { Metadata } from "next";
import Link from "next/link";
import { allSpecialties } from "@/lib/facets";
import { Breadcrumbs } from "@/app/_components/facet";

// force-dynamic so it's never prerendered at build (the DB is unreachable there); the query is a
// cheap 870-row read. Matches the home page's approach.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Medical Specialties Directory — NPI Lookup by Specialty",
  description:
    "Browse US healthcare providers by specialty, from physicians and dentists to nurses and therapists. " +
    "Every NUCC provider taxonomy with its active NPI count in the public NPPES registry.",
  alternates: { canonical: "/specialty" },
};

export default async function SpecialtyIndex() {
  const specialties = await allSpecialties();
  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Specialties", href: "/specialty" }]} />
      <h1>Browse providers by specialty</h1>
      <p className="sub">
        {specialties.length.toLocaleString()} provider specialties (NUCC taxonomy) with active NPIs in the
        NPPES registry. Pick a specialty to see providers and drill down by city.
      </p>
      <ul className="plist">
        {specialties.map((s) => (
          <li key={s.slug}>
            <Link href={`/specialty/${s.slug}`}>{s.name}</Link>
            <span className="meta">{s.n.toLocaleString()} providers</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
