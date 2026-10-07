// Refresh live.mv_facet_insights (pipeline/facets.sql §5) after a load that changes its inputs:
// Open Payments (openpayments.ts) or the OIG list (leie.ts). The NPPES load rebuilds it in facets.sql.
// CONCURRENTLY keeps the city pages readable during the ~20 s refresh. No-op if the view isn't built yet.
import type pg from "pg";

export async function refreshFacetInsights(client: pg.Client, label: string): Promise<void> {
  const r = await client.query(`SELECT to_regclass('live.mv_facet_insights') AS t`);
  if (!r.rows[0].t) return;
  const t0 = Date.now();
  await client.query(`SET work_mem = '64MB'; REFRESH MATERIALIZED VIEW CONCURRENTLY live.mv_facet_insights`);
  console.log(`${label}: refreshed mv_facet_insights (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
