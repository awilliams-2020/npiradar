import { getProviders, toPublicJson } from "@/lib/provider";
import { guard, CORS } from "@/lib/api";

// Public bulk NPI lookup: POST { "npis": ["1234567890", ...] } → { results, notFound, invalid }.
// One SQL round-trip via getProviders (WHERE npi = ANY), unlike the browser tool's per-NPI fan-out.
// Rate-limited by NUMBER OF NPIs looked up (not per request) so batching can't dodge the limit.
export const dynamic = "force-dynamic";

const MAX = 100;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request", message: "Body must be JSON: { npis: string[] }." }, { status: 400, headers: CORS });
  }

  const raw = (body as { npis?: unknown })?.npis;
  if (!Array.isArray(raw)) {
    return Response.json({ error: "bad_request", message: "Body must be { npis: string[] }." }, { status: 400, headers: CORS });
  }
  if (raw.length > MAX) {
    return Response.json({ error: "too_many", message: `Send at most ${MAX} NPIs per request.`, max: MAX }, { status: 400, headers: CORS });
  }

  // Normalize before charging the limiter: split valid/invalid, dedupe, preserve request order.
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const t of raw) {
    const npi = String(t).trim();
    if (!/^\d{10}$/.test(npi)) {
      invalid.push(npi);
    } else if (!seen.has(npi)) {
      seen.add(npi);
      valid.push(npi);
    }
  }

  // Cost = distinct valid NPIs (min 1, so an all-invalid request still costs a token).
  const g = await guard(req, Math.max(1, valid.length));
  if ("limited" in g) return g.limited;

  let rows;
  try {
    rows = await getProviders(valid);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: g.headers });
  }

  const byNpi = new Map(rows.map((p) => [p.npi, toPublicJson(p)]));
  return Response.json(
    {
      count: valid.length,
      results: valid.map((n) => byNpi.get(n)).filter(Boolean),
      notFound: valid.filter((n) => !byNpi.has(n)),
      invalid,
    },
    { headers: g.headers },
  );
}
