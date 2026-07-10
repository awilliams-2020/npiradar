import Link from "next/link";
import { fullName, titleCase } from "@/lib/format";
import { SITE_URL } from "@/lib/sitemap";
import { cityStateSlug } from "@/lib/slug";
import type { ProviderListItem, SlugCount, CityRef } from "@/lib/facets";

// Shared building blocks for the facet pages (specialty / city / specialty×city). Server-only; no client JS.

export interface Crumb { name: string; href: string }

/** Breadcrumb trail + BreadcrumbList JSON-LD (the crawl-path + rich-result signal). */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: SITE_URL + it.href,
    })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <nav className="crumbs" aria-label="Breadcrumb">
        {items.map((it, i) => (
          <span key={it.href}>
            {i > 0 && <span className="sep"> › </span>}
            {i < items.length - 1 ? <Link href={it.href}>{it.name}</Link> : <span>{it.name}</span>}
          </span>
        ))}
      </nav>
    </>
  );
}

function listItemName(p: ProviderListItem): string {
  return fullName(p) + (p.credential ? `, ${p.credential}` : "");
}

function locationLine(p: ProviderListItem): string {
  return [titleCase(p.practice_city), p.practice_state].filter(Boolean).join(", ");
}

/** Paginated provider list + ItemList JSON-LD over the rows on this page. */
export function ProviderList({ items, offset }: { items: ProviderListItem[]; offset: number }) {
  if (items.length === 0) return <p className="sub">No active providers listed for this page.</p>;
  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((p, i) => ({
      "@type": "ListItem",
      position: offset + i + 1,
      url: `${SITE_URL}/npi/${p.npi}`,
      name: fullName(p),
    })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <ul className="plist">
        {items.map((p) => (
          <li key={p.npi}>
            <Link href={`/npi/${p.npi}`}>{listItemName(p)}</Link>
            <span className="meta">
              {p.specialty ? p.specialty : p.entity_type === "org" ? "Organization" : "Provider"}
              {locationLine(p) ? ` · ${locationLine(p)}` : ""} · NPI {p.npi}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Prev/next pager. Page is 1-based; `hasNext` decided by the caller (got a full page back). */
export function Pager({ basePath, page, hasNext }: { basePath: string; page: number; hasNext: boolean }) {
  if (page <= 1 && !hasNext) return null;
  const href = (p: number) => (p <= 1 ? basePath : `${basePath}?page=${p}`);
  return (
    <nav className="pager" aria-label="Pagination">
      {page > 1 ? <Link href={href(page - 1)} rel="prev">← Previous</Link> : <span />}
      <span className="muted">Page {page}</span>
      {hasNext ? <Link href={href(page + 1)} rel="next">Next →</Link> : <span />}
    </nav>
  );
}

/** A block of related-facet links (siblings / nearby) — the interlinking that builds the crawl graph. */
export function LinkChips({ title, links }: { title: string; links: { href: string; label: string; n?: number }[] }) {
  if (links.length === 0) return null;
  return (
    <section className="chips">
      <h2>{title}</h2>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href}>{l.label}</Link>
            {l.n != null && <span className="muted"> ({l.n.toLocaleString()})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function specialtyLinks(items: SlugCount[]): { href: string; label: string; n: number }[] {
  return items.map((s) => ({ href: `/specialty/${s.slug}`, label: s.name, n: s.n }));
}

export function cityLinks(items: CityRef[]): { href: string; label: string; n: number }[] {
  return items.map((c) => ({
    href: `/in/${c.state.toLowerCase()}/${c.city_slug}`,
    label: `${titleCase(c.city_name)}, ${c.state}`,
    n: c.n,
  }));
}

/** Links to specialty×city money pages for one specialty across cities. */
export function moneyLinks(specialtySlug: string, items: CityRef[]): { href: string; label: string; n: number }[] {
  return items.map((c) => ({
    href: `/specialty/${specialtySlug}/${cityStateSlug(c.city_slug, c.state)}`,
    label: `${titleCase(c.city_name)}, ${c.state}`,
    n: c.n,
  }));
}
