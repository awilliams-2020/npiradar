// refresh-state.mjs — tiny CLI the refresh-run.sh shell calls to mark a run done.
// Usage: node refresh-state.mjs <success|fail> <runId> <message>
// The refresh_runs table lives in `public` (NOT live/staging) so it survives the schema swap.
import pg from "pg";

const [, , action, id, message = ""] = process.argv;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
if (action === "success") {
  await c.query(
    "UPDATE public.refresh_runs SET state='success', finished_at=now(), message=$2 WHERE id=$1",
    [id, message || "ok"],
  );
} else {
  await c.query(
    "UPDATE public.refresh_runs SET state='failed', finished_at=now(), message=$2 WHERE id=$1",
    [id, message || "failed"],
  );
}
await c.end();
