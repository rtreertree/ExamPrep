import { fileURLToPath } from "node:url";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { runtimeDatabaseRole } from "../server/testDatabase";
import { databaseConnection } from "./deployment-config.mjs";
import { runtimeGrants } from "./runtime-role";

export async function provisionRuntimeRole(direct: string, password: string) {
  databaseConnection(direct, false);
  if (!/^[\da-f]{64}$/.test(password))
    throw new Error(
      "Set an explicit direct Neon URL and a random 64-digit hex runtime password.",
    );
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: direct, max: 1 });
  try {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtext('exam-prep-runtime-role'))",
      );
      const result = await db.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [runtimeDatabaseRole],
      );
      // The password is hex-only and is never passed through a shell or printed.
      if (!result.rowCount)
        await db.query(
          `CREATE ROLE ${runtimeDatabaseRole} NOINHERIT LOGIN PASSWORD '${password}'`,
        );
      await db.query(runtimeGrants);
      await db.query("COMMIT");
    } finally {
      try {
        await db.query("ROLLBACK");
      } finally {
        db.release();
      }
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await provisionRuntimeRole(
      process.env.DATABASE_URL_UNPOOLED ?? "",
      process.env.RUNTIME_DATABASE_PASSWORD ?? "",
    );
    console.info(
      "Restricted runtime role provisioned. Verify its pooled connection before release.",
    );
  } catch {
    console.error(
      "Runtime role provisioning failed. Verify the explicit direct target, password format, and migration ownership.",
    );
    process.exitCode = 1;
  }
}
