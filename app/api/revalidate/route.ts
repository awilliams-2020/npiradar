import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";

// Authed ISR-cache purge, called by the refresh runner right after a successful monthly schema swap.
// The swap makes Postgres serve the new month instantly, but rendered pages in .next/cache carry a
// 30-day `revalidate`, so they'd stay stale. revalidatePath("/", "layout") marks every route under
// the root layout for re-render on next hit — one call, no need to enumerate 9.5M provider pages.
export async function POST(req: NextRequest) {
  const secret = process.env.REFRESH_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  revalidatePath("/", "layout");
  return Response.json({ revalidated: true, scope: "/ (layout)", at: new Date().toISOString() });
}
