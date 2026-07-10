import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { topCitiesInState } from "@/lib/facets";
import { stateName, STATE_NAMES } from "@/lib/states";
import { Breadcrumbs, LinkChips, cityLinks } from "@/app/_components/facet";

export const revalidate = 2592000;
export const dynamicParams = true;

export async function generateMetadata({ params }: { params: Promise<{ state: string }> }): Promise<Metadata> {
  const { state } = await params;
  const name = STATE_NAMES[state.toUpperCase()];
  if (!name) return { title: "State not found — NPIRadar" };
  return {
    title: `Healthcare Providers in ${name} — NPI Lookup by City`,
    description: `Find healthcare providers in ${name} by city. Browse doctors, dentists, and clinics by NPI number from the public NPPES registry.`,
    alternates: { canonical: `/in/${state.toLowerCase()}` },
  };
}

export default async function StatePage({ params }: { params: Promise<{ state: string }> }) {
  const { state: stateParam } = await params;
  const state = stateParam.toUpperCase();
  const name = STATE_NAMES[state];
  if (!name) notFound();

  const cities = await topCitiesInState(state, "", 300);
  if (cities.length === 0) notFound();

  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: name, href: `/in/${state.toLowerCase()}` }]} />
      <h1>Healthcare providers in {name}</h1>
      <p className="sub">
        Browse healthcare providers in {name} by city. Showing the {cities.length.toLocaleString()} largest
        cities by provider count.
      </p>
      <LinkChips title={`Cities in ${name}`} links={cityLinks(cities)} />
    </article>
  );
}
