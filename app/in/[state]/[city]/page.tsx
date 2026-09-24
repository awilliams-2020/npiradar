import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getCity, providersByCity, specialtiesForCity, topCitiesInState,
  PAGE_SIZE, MAX_INDEXED_PAGE, CITY_INDEXABLE_MIN,
} from "@/lib/facets";
import { cityStateSlug } from "@/lib/slug";
import { titleCase } from "@/lib/format";
import { stateName } from "@/lib/states";
import { Breadcrumbs, ProviderList, Pager, LinkChips, cityLinks } from "@/app/_components/facet";

export const revalidate = 2592000;
export const dynamicParams = true;

type Params = Promise<{ state: string; city: string }>;
type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const pageNum = (sp: { page?: string | string[] }) => {
  const p = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  return Number.isFinite(p) && p > 1 ? Math.floor(p) : 1;
};

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SP }): Promise<Metadata> {
  const { state, city } = await params;
  const page = pageNum(await searchParams);
  const c = await getCity(state.toUpperCase(), city);
  if (!c) return { title: "City not found — NPIRadar" };
  const label = `${titleCase(c.city_name)}, ${c.state}`;
  const base = `/in/${state.toLowerCase()}/${city}`;
  return {
    title: `Healthcare Providers in ${label} — NPI Lookup & Directory`,
    description:
      `${c.n.toLocaleString()} healthcare providers in ${label}, from doctors and dentists to clinics and ` +
      `pharmacies. Search the NPPES registry by NPI number, name, or specialty.`,
    alternates: { canonical: page > 1 ? `${base}?page=${page}` : base },
    // Thin cities (few providers — often NPPES address typos like "crystal-cty") and deep pagination
    // stay reachable but out of the index; mirrors the specialty×city rule.
    robots: c.n >= CITY_INDEXABLE_MIN && page <= MAX_INDEXED_PAGE ? undefined : { index: false, follow: true },
  };
}

export default async function CityPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { state: stateParam, city } = await params;
  const state = stateParam.toUpperCase();
  const page = pageNum(await searchParams);
  const c = await getCity(state, city);
  if (!c) notFound();

  const offset = (page - 1) * PAGE_SIZE;
  const [providers, specs, otherCities] = await Promise.all([
    providersByCity(state, c.raw_cities, PAGE_SIZE, offset),
    page === 1 ? specialtiesForCity(state, city, 30) : Promise.resolve([]),
    page === 1 ? topCitiesInState(state, city, 24) : Promise.resolve([]),
  ]);

  const label = `${titleCase(c.city_name)}, ${c.state}`;
  const base = `/in/${state.toLowerCase()}/${city}`;
  const cs = cityStateSlug(city, state);

  return (
    <article>
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: stateName(c.state) ?? c.state, href: `/in/${state.toLowerCase()}` },
          { name: label, href: base },
        ]}
      />
      <h1>Healthcare providers in {label}</h1>
      <p className="sub">
        {c.n.toLocaleString()} providers have an active NPI in {titleCase(c.city_name)},{" "}
        {stateName(c.state)}. Browse the list below, or jump to a specialty.
      </p>
      <ProviderList items={providers} offset={offset} />
      <Pager basePath={base} page={page} hasNext={providers.length === PAGE_SIZE} />
      <LinkChips
        title={`Specialties in ${titleCase(c.city_name)}`}
        links={specs.map((s) => ({ href: `/specialty/${s.slug}/${cs}`, label: s.name, n: s.n }))}
      />
      <LinkChips title={`Other cities in ${stateName(c.state)}`} links={cityLinks(otherCities)} />
    </article>
  );
}
