import { getProvider } from "@/lib/provider";
import { fullName, titleCase } from "@/lib/format";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/app/_og/card";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Healthcare provider on NPIRadar";

// Cache the rendered card (ISR). Satori renders are CPU-bound and single-threaded, so under crawler
// bursts many concurrent renders serialize and the tail latency balloons (seen: ~6.5s). NPPES data
// changes ~monthly, so serve a cached PNG for a week; first hit per NPI renders, the rest are free.
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
