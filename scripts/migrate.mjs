import "dotenv/config";
import { spawnSync } from "node:child_process";
import { databaseConnection } from "./deployment-config.mjs";

try {
  databaseConnection(process.env.DATABASE_URL_UNPOOLED, false);
  // Prisma 7 CLI reads only the direct URL from prisma.config.ts.
  const result = spawnSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    // Raw migration errors can contain SQL and connection information.
    console.error(
      "Migration failed. Check Neon connectivity, migration history and failed-migration state in the Neon console. No deployment was attempted. Do not reset the database.",
    );
    process.exitCode = 1;
  } else
    console.info(
      "Prisma migrate deploy succeeded; all reviewed migrations are applied.",
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
