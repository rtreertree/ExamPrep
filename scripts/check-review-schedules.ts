import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { databaseConnection } from "./deployment-config.mjs";
import { maxReviewStartSkewMs } from "../shared/backup";

const tables = [
  "CardReview",
  "LegacyCardReview",
  "CoOwnerCardReview",
  "ViewerCardReview",
] as const;
neonConfig.webSocketConstructor = ws;
let pool: Pool | undefined;
try {
  const url = databaseConnection(process.env.DATABASE_URL_UNPOOLED, false);
  pool = new Pool({ connectionString: url.href, max: 1 });
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if (process.argv.includes("--production-cutover")) {
      const {
        rows: [schema],
      } = await db.query<{ receipts: boolean; entries: boolean }>(`
        SELECT to_regclass('public."StudySetOperation"') IS NOT NULL AS receipts,
          to_regclass('public."LibraryEntry"') IS NOT NULL AS entries
      `);
      if (!schema.receipts) {
        console.error(
          "Deploy the duplicate-prevention release before the library cutover.",
        );
        process.exitCode = 1;
      } else if (
        !schema.entries &&
        process.env.LIBRARY_CUTOVER_PREPARED !== "true"
      ) {
        console.error(
          "Dispatch Release after verifying the recovery point and pausing production writers.",
        );
        process.exitCode = 1;
      }
    }
    for (const table of tables) {
      const {
        rows: [relation],
      } = await db.query<{ name: string | null }>(
        "SELECT to_regclass($1)::text AS name",
        [`public."${table}"`],
      );
      if (!relation.name) continue;
      const {
        rows: [counts],
      } = await db.query<{ invalid: number; future: number }>(
        `
        SELECT count(*) FILTER (WHERE streak NOT BETWEEN 0 AND 5 OR NOT isfinite("dueAt")
          OR NOT isfinite("attemptStartedAt") OR "dueAt" < "attemptStartedAt")::int AS invalid,
          count(*) FILTER (WHERE isfinite("attemptStartedAt") AND "attemptStartedAt" >
            (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + $1 * interval '1 millisecond')::int AS future
        FROM public."${table}"`,
        [maxReviewStartSkewMs],
      );
      if (counts.invalid || counts.future) {
        console.error(
          `${table} has ${counts.invalid} invalid and ${counts.future} future-dated schedules. Review before migrating.`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  if (!process.exitCode) console.info("Review schedule preflight passed.");
} catch {
  console.error(
    "Review schedule preflight failed. Verify the explicit direct Neon target and migration access.",
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
