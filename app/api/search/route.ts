import { searchProvidersApi } from "@/lib/facets";
import { guard, CORS } from "@/lib/api";

// Public provider search: GET /api/search?name=&specialty=&state=&city=&limit=&page=
//   name       last/org name prefix
//   specialty  taxonomy slug (e.g. "occupational-therapist")
//   state      2-letter code (required when filtering by city)
//   city       city slug (e.g. "pasadena")
// Requires at least one of name|specialty|state so the query stays on an index. Returns JSON with
// hasMore paging. Heavier than a keyed lookup, so it costs 10 rate-limit tokens.
export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const COST = 10;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const f = {
    name: u.searchParams.get("name")?.trim() || undefined,
    specialtySlug: u.searchParams.get("specialty")?.trim().toLowerCase() || undefined,
    state: u.searchParams.get("state")?.trim() || undefined,
    citySlug: u.searchParams.get("city")?.trim().toLowerCase() || undefined,
  };

  // Guardrails: need a selective filter; city only alongside state (else it's a scan).
  if (!f.name && !f.specialtySlug && !f.state) {
    return Response.json(
      { error: "bad_request", message: "Provide at least one of: name, specialty, state." },
      { status: 400, headers: CORS },
    );
  }
  if (f.citySlug && !f.state) {
    return Response.json({ error: "bad_request", message: "The city filter requires state." }, { status: 400, headers: CORS });
  }
  if (f.state && !/^[A-Za-z]{2}$/.test(f.state)) {
    return Response.json({ error: "bad_request", message: "state must be a 2-letter code." }, { status: 400, headers: CORS });
  }

  const g = await guard(req, COST);
  if ("limited" in g) return g.limited;

  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(u.searchParams.get("limit")) || DEFAULT_LIMIT));
  const page = Math.max(0, Math.floor(Number(u.searchParams.get("page")) || 0));

  let rows;
  try {
    rows = await searchProvidersApi(f, limit + 1, page * limit); // +1 sentinel → hasMore without count(*)
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: g.headers });
  }

  const hasMore = rows.length > limit;
  const results = rows.slice(0, limit).map((r) => ({
    npi: r.npi,
    entityType: r.entity_type === "org" ? "organization" : r.entity_type,
    name: r.org_name ?? ([r.first_name, r.middle_name, r.last_name].filter(Boolean).join(" ") || null),
    credential: r.credential,
    specialty: r.specialty,
    city: r.practice_city,
    state: r.practice_state,
    url: `https://npiradar.com/npi/${r.npi}`,
  }));

  return Response.json({ query: f, page, limit, hasMore, results }, { headers: g.headers });
}
