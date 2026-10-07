import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";

// Authed ISR-cache purge, called by the refresh runner after the monthly schema swap and by the dataset
// loaders. revalidatePath("/", "layout") marks every cached route for re-render on next hit. Only the
// static pages (/about, /nppes, the tools, …) are actually cached: provider, specialty and city pages
// render per request (see app/npi/[npi]/page.tsx), so they show new data without any purge.
export async function POST(req: NextRequest) {
  const secret = process.env.REFRESH_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  revalidatePath("/", "layout");
  return Response.json({ revalidated: true, scope: "/ (layout)", at: new Date().toISOString() });
}
