import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { searchProviders } from "@/lib/facets";
import { ProviderList } from "@/app/_components/facet";

export const dynamic = "force-dynamic";

// Search results are a UX surface, not an indexable page (avoids thin/duplicate query pages).
export const metadata: Metadata = {
  title: "Search providers by NPI or name — NPIRadar",
  robots: { index: false, follow: false },
};

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim();

  // A 10-digit NPI goes straight to the provider page (the dominant "npi number lookup" case).
  if (/^\d{10}$/.test(q)) redirect(`/npi/${q}`);

  const results = q.length >= 2 ? await searchProviders(q, 50) : [];

  return (
    <>
      <h1>Search providers</h1>
      <form className="search" action="/search">
        <input name="q" defaultValue={q} placeholder="NPI number or last name" aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      {q.length < 2 ? (
        <p className="sub">Enter a 10-digit NPI number, or a provider / organization name to search.</p>
      ) : results.length === 0 ? (
        <p className="sub">No providers found for “{q}”. Try a last name (e.g. “Smith”) or a 10-digit NPI number.</p>
      ) : (
        <>
          <p className="sub">
            {results.length === 50 ? "Top 50 matches" : `${results.length} ${results.length === 1 ? "match" : "matches"}`}{" "}
            for “{q}”. Paste a 10-digit NPI to go straight to a provider.
          </p>
          <ProviderList items={results} offset={0} />
        </>
      )}
    </>
  );
}
