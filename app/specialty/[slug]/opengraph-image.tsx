import { getSpecialty } from "@/lib/facets";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/app/_og/card";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Specialty directory on NPIRadar";

// Cache the rendered card (ISR) — see note in app/npi/[npi]/opengraph-image.tsx.
export const revalidate = 604800;

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getSpecialty(slug).catch(() => null);
  const title = s ? s.display_name : "Provider specialty";
  const subtitle = s ? `${s.n.toLocaleString()} providers in the NPPES registry` : "NPI provider directory";
  return ogCard({ eyebrow: "Specialty", title, subtitle });
}
