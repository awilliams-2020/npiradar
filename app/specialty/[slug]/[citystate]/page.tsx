import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getSpecialtyCity, getCity, providersBySpecialtyCity,
  otherSpecialtiesInCity, sameSpecialtyOtherCities,
  PAGE_SIZE, MAX_INDEXED_PAGE, INDEXABLE_MIN, specialtyCodes,
} from "@/lib/facets";
import { facetInsights } from "@/lib/insights";
import { FacetInsightsSection } from "@/app/_components/facet-insights";
import { parseCityState } from "@/lib/slug";
import { titleCase } from "@/lib/format";
import { stateName } from "@/lib/states";
import { Breadcrumbs, ProviderList, Pager, LinkChips, moneyLinks } from "@/app/_components/facet";

export const revalidate = 2592000;
export const dynamicParams = true;

type Params = Promise<{ slug: string; citystate: string }>;
type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const pageNum = (sp: { page?: string | string[] }) => {
  const p = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  return Number.isFinite(p) && p > 1 ? Math.floor(p) : 1;
};

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SP }): Promise<Metadata> {
  const { slug, citystate } = await params;
  const page = pageNum(await searchParams);
  const parsed = parseCityState(citystate);
  if (!parsed) return { title: "Not found — NPIRadar" };
  const sc = await getSpecialtyCity(parsed.state, parsed.citySlug, slug);
  if (!sc) return { title: "Not found — NPIRadar" };
  const city = `${titleCase(sc.city_name)}, ${sc.state}`;
  const base = `/specialty/${slug}/${citystate}`;
  // Thin pages (few providers) and deep pagination stay reachable but out of the index.
  const indexable = sc.n >= INDEXABLE_MIN && page <= MAX_INDEXED_PAGE;
  return {
    title: `${sc.specialty_name} in ${city} — NPI Lookup`,
    description:
      `${sc.n.toLocaleString()} ${sc.specialty_name} providers in ${city}. ` +
      `See each provider's NPI number, credentials, and practice location in the NPPES registry.`,
    alternates: { canonical: page > 1 ? `${base}?page=${page}` : base },
    robots: indexable ? undefined : { index: false, follow: true },
  };
}

export default async function SpecialtyCityPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { slug, citystate } = await params;
  const page = pageNum(await searchParams);
  const parsed = parseCityState(citystate);
  if (!parsed) notFound();
  const { state, citySlug } = parsed;

  const [sc, city] = await Promise.all([
    getSpecialtyCity(state, citySlug, slug),
    getCity(state, citySlug),
  ]);
  if (!sc || !city) notFound();

  const offset = (page - 1) * PAGE_SIZE;
  const indexable = sc.n >= INDEXABLE_MIN; // stats only where they can earn search traffic
  const [providers, otherSpecs, otherCities, insights] = await Promise.all([
    providersBySpecialtyCity(state, city.raw_cities, slug, PAGE_SIZE, offset),
    page === 1 ? otherSpecialtiesInCity(state, citySlug, slug, 24) : Promise.resolve([]),
    page === 1 ? sameSpecialtyOtherCities(slug, state, citySlug, 24) : Promise.resolve([]),
    page === 1 && indexable
      ? specialtyCodes(slug).then((codes) => (codes.length ? facetInsights(state, city.raw_cities, codes) : null))
      : Promise.resolve(null),
  ]);

  const cityLabel = `${titleCase(sc.city_name)}, ${sc.state}`;
  const base = `/specialty/${slug}/${citystate}`;

  return (
    <article>
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: "Specialties", href: "/specialty" },
          { name: sc.specialty_name, href: `/specialty/${slug}` },
          { name: cityLabel, href: base },
        ]}
      />
      <h1>{sc.specialty_name} in {cityLabel}</h1>
      <p className="sub">
        {sc.n.toLocaleString()} {sc.specialty_name} {sc.n === 1 ? "provider has" : "providers have"} an active NPI in{" "}
        {titleCase(sc.city_name)}, {stateName(sc.state)}. Each links to the provider&apos;s full registry record.
      </p>
      <ProviderList items={providers} offset={offset} />
      <Pager basePath={base} page={page} hasNext={providers.length === PAGE_SIZE} />
      {insights && <FacetInsightsSection x={insights} label={`${sc.specialty_name} providers in ${titleCase(sc.city_name)}`} />}
      <LinkChips
        title={`Other specialties in ${titleCase(sc.city_name)}`}
        links={otherSpecs.map((o) => ({ href: `/specialty/${o.slug}/${citystate}`, label: o.name, n: o.n }))}
      />
      <LinkChips title={`${sc.specialty_name} in other cities`} links={moneyLinks(slug, otherCities)} />
    </article>
  );
}
