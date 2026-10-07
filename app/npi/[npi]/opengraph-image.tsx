import { getProvider } from "@/lib/provider";
import { fullName, titleCase } from "@/lib/format";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/app/_og/card";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Healthcare provider on NPIRadar";

// Meant to cache the rendered card: Satori renders are CPU-bound and single-threaded, so under crawler
// bursts concurrent renders serialize and tail latency balloons (seen: ~6.5s). But like the page, this
// dynamic route has no generateStaticParams, so the server renders it on every request (~110 ms,
// 2026-10-07); `revalidate` has no effect. Clients and crawlers do get `immutable, max-age=31536000`.
export const revalidate = 604800;

export default async function Image({ params }: { params: Promise<{ npi: string }> }) {
  const { npi } = await params;
  const p = await getProvider(npi).catch(() => null);
  const title = p ? fullName(p) + (p.credential ? `, ${p.credential}` : "") : `NPI ${npi}`;
  const subtitle = p
    ? [p.specialty, [titleCase(p.practice_city), p.practice_state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
    : "Healthcare provider lookup";
  return ogCard({ eyebrow: `NPI ${npi}`, title, subtitle });
}
