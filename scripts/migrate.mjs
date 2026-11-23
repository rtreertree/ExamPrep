import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { databaseConnection } from "./deployment-config.mjs";

const migrationErrors = {
  P1000: "The direct database login was rejected. Check the owner credentials.",
  P1001: "The direct Neon endpoint could not be reached.",
  P1002:
    "The direct database operation timed out. Check for another migration and retry after it finishes.",
  P1008:
    "The direct database operation timed out. Check for another migration and retry after it finishes.",
  P1010: "The direct database role was denied access.",
  P1017: "The database closed the direct connection.",
  P3005:
    "The database has an existing schema and no compatible Prisma migration baseline.",
  P3009:
    "The target database has a previously failed migration. Inspect its migration history.",
  P3018: "A migration failed to apply. Inspect its recorded SQL error.",
};

export function describeMigrationFailure(result) {
  // Prisma output can contain SQL and credentials. Emit only structured codes and migration names.
  const output = stripVTControlCharacters(
    `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  );
  const code = output.match(/^Error:[ \t]*(P\d{4})\b/m)?.[1];
  const sqlState = output.match(
    /^Database error code:[ \t]*([A-Z0-9]{5})\s*$/m,
  )?.[1];
  const migration = output.match(
    /^Migration name:[ \t]*([0-9]{12,14}_[a-z0-9_]{1,96})\s*$/m,
  )?.[1];
  const details = [code, sqlState && `SQLSTATE ${sqlState}`, migration]
    .filter(Boolean)
    .join(", ");
  const reason =
    code && Object.hasOwn(migrationErrors, code)
      ? migrationErrors[code]
      : result.error
        ? "Prisma could not run to completion. Check the CLI installation and runner logs."
        : "Check the direct Neon connection and migration history.";
  return `Migration failed${details ? ` [${details}]` : ""}. ${reason} Deployment stopped.`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await import("dotenv/config");
    databaseConnection(process.env.DATABASE_URL_UNPOOLED, false);
    // Prisma 7 CLI reads only the direct URL from prisma.config.ts.
    const result = spawnSync(
      "node_modules/.bin/prisma",
      ["migrate", "deploy"],
      {
        stdio: "pipe",
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      console.error(describeMigrationFailure(result));
      process.exitCode = 1;
    } else {
      console.info(
        "Prisma migrate deploy succeeded; all reviewed migrations are applied.",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
