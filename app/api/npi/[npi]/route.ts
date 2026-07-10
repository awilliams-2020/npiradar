import { getProvider, toPublicJson } from "@/lib/provider";

// Public, CORS-open NPI lookup API. Free endpoint = backlink magnet + seed for a future freemium tier.
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(_req: Request, { params }: { params: Promise<{ npi: string }> }) {
  const { npi } = await params;
  if (!/^\d{10}$/.test(npi)) {
    return Response.json({ error: "invalid_npi", message: "NPI must be 10 digits." }, { status: 400, headers: CORS });
  }
  let p;
  try {
    p = await getProvider(npi);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: CORS });
  }
  if (!p) return Response.json({ error: "not_found", npi }, { status: 404, headers: CORS });
  return Response.json(toPublicJson(p), { headers: CORS });
}
