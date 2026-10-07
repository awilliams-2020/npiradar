import { getCity } from "@/lib/facets";
import { titleCase } from "@/lib/format";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/app/_og/card";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "City provider directory on NPIRadar";

// Rendered per request, not cached; see the note in app/npi/[npi]/opengraph-image.tsx.
export const revalidate = 604800;

export default async function Image({ params }: { params: Promise<{ state: string; city: string }> }) {
  const { state, city } = await params;
  const c = await getCity(state.toUpperCase(), city).catch(() => null);
  const title = c ? `Providers in ${titleCase(c.city_name)}, ${c.state}` : "Healthcare providers";
  const subtitle = c ? `${c.n.toLocaleString()} with an active NPI` : "NPI provider directory";
  return ogCard({ eyebrow: "NPI directory", title, subtitle });
}
