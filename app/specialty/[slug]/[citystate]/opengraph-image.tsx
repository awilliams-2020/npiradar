import { getSpecialtyCity } from "@/lib/facets";
import { parseCityState } from "@/lib/slug";
import { titleCase } from "@/lib/format";
import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from "@/app/_og/card";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "Local provider directory on NPIRadar";

// Cache the rendered card (ISR) — see note in app/npi/[npi]/opengraph-image.tsx.
export const revalidate = 604800;

export default async function Image({ params }: { params: Promise<{ slug: string; citystate: string }> }) {
  const { slug, citystate } = await params;
  const parsed = parseCityState(citystate);
  const sc = parsed ? await getSpecialtyCity(parsed.state, parsed.citySlug, slug).catch(() => null) : null;
  const title = sc ? sc.specialty_name : "Healthcare providers";
  const subtitle = sc
    ? `${sc.n.toLocaleString()} in ${titleCase(sc.city_name)}, ${sc.state}`
    : "NPI provider directory";
  return ogCard({ eyebrow: "NPI directory", title, subtitle });
}
