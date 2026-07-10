import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getSpecialty, providersBySpecialty, sameSpecialtyOtherCities,
  PAGE_SIZE, MAX_INDEXED_PAGE,
} from "@/lib/facets";
import { Breadcrumbs, ProviderList, Pager, LinkChips, moneyLinks } from "@/app/_components/facet";

export const revalidate = 2592000; // 30d, matches the monthly NPPES refresh
export const dynamicParams = true; // render any specialty on first request, then cache

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const pageNum = (sp: { page?: string | string[] }) => {
  const p = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  return Number.isFinite(p) && p > 1 ? Math.floor(p) : 1;
};

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }): Promise<Metadata> {
  const { slug } = await params;
  const page = pageNum(await searchParams);
  const s = await getSpecialty(slug);
  if (!s) return { title: "Specialty not found — NPIRadar" };
  const base = `/specialty/${slug}`;
  return {
    title: `${s.display_name} — NPI Lookup & Provider Directory`,
    description:
      `Browse ${s.n.toLocaleString()} active ${s.display_name} providers across the US. ` +
      `Look up any of them by NPI number, name, and practice location in the public NPPES registry.`,
    alternates: { canonical: page > 1 ? `${base}?page=${page}` : base },
    robots: page > MAX_INDEXED_PAGE ? { index: false, follow: true } : undefined,
  };
}

export default async function SpecialtyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const page = pageNum(await searchParams);
  const s = await getSpecialty(slug);
  if (!s) notFound();

  const offset = (page - 1) * PAGE_SIZE;
  const [providers, cities] = await Promise.all([
    providersBySpecialty(slug, PAGE_SIZE, offset),
    page === 1 ? sameSpecialtyOtherCities(slug, "", "", 30) : Promise.resolve([]),
  ]);
  const base = `/specialty/${slug}`;

  return (
    <article>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Specialties", href: "/specialty" }, { name: s.display_name, href: base }]} />
      <h1>{s.display_name} Providers</h1>
      <p className="sub">
        {s.n.toLocaleString()} active {s.display_name} providers across the United States
        {s.grouping ? `, part of ${s.grouping}` : ""}. Every listing links to that provider&apos;s full NPI record.
      </p>
      <ProviderList items={providers} offset={offset} />
      <Pager basePath={base} page={page} hasNext={providers.length === PAGE_SIZE} />
      <LinkChips title={`${s.display_name} by city`} links={moneyLinks(slug, cities)} />
    </article>
  );
}
