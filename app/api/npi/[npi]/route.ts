import { getProvider, toPublicJson } from "@/lib/provider";
import { guard, CORS } from "@/lib/api";

// Public, CORS-open NPI lookup API. Free endpoint = backlink magnet + seed for a future freemium tier.
// Rate-limited (cost 1) through the shared guard, same budget as the bulk + search endpoints.
export const dynamic = "force-dynamic";

// Successful lookups are cacheable (data changes only on the monthly load); merged onto 200s only.
const CACHE = { "Cache-Control": "public, max-age=3600, s-maxage=86400" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request, { params }: { params: Promise<{ npi: string }> }) {
  const { npi } = await params;
  if (!/^\d{10}$/.test(npi)) {
    return Response.json({ error: "invalid_npi", message: "NPI must be 10 digits." }, { status: 400, headers: CORS });
  }

  const g = await guard(req, 1);
  if ("limited" in g) return g.limited;

  let p;
  try {
    p = await getProvider(npi);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: g.headers });
  }
  if (!p) return Response.json({ error: "not_found", npi }, { status: 404, headers: g.headers });
  return Response.json(toPublicJson(p), { headers: { ...g.headers, ...CACHE } });
}
