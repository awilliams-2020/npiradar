// Next.js calls register() once when the server starts. Warm the national Open Payments / OIG stats
// (lib/insights.ts) so the first visitor to /open-payments after a deploy or restart doesn't wait ~7 s.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { warmInsights } = await import("@/lib/insights");
  // Not awaited: startup must not wait on the DB, and a failure only means the first request computes it.
  warmInsights().catch((e) => console.error("insights: warm-up failed:", e));
}
