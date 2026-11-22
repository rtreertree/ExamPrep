import { neonConfig } from "@neondatabase/serverless";
import { randomBytes } from "node:crypto";
import ws from "ws";
import { connectDatabase } from "../server/db";
import { assertRuntimeRole } from "./runtime-role";
import { checkConnections } from "./deployment-config.mjs";
import {
  isLoopbackOrigin,
  matchesTestDatabase,
  runtimeDatabaseRole,
  testDatabaseDigest,
  testDatabaseHeader,
  testDatabasePath,
  testDatabaseProofHeader,
} from "../server/testDatabase";

type Target = { runtime: string; direct: string };

export function readTestTarget(
  env: { [key: string]: string | undefined } = process.env,
): Target {
  const runtime = env.TEST_DATABASE_URL;
  const direct = env.TEST_DATABASE_URL_UNPOOLED;
  if (!runtime || !direct)
    throw new Error("Set test-only pooled and direct database URLs.");
  const urls = checkConnections(
    { DATABASE_URL: runtime, DATABASE_URL_UNPOOLED: direct },
    { runtime: "TEST_DATABASE_URL", migration: "TEST_DATABASE_URL_UNPOOLED" },
  );
  if (decodeURIComponent(urls.runtime.username) !== runtimeDatabaseRole)
    throw new Error(
      `TEST_DATABASE_URL must sign in as ${runtimeDatabaseRole}.`,
    );
  if (decodeURIComponent(urls.migration.username) === runtimeDatabaseRole)
    throw new Error(
      "Test connections require separate roles. TEST_DATABASE_URL_UNPOOLED must sign in as the owner.",
    );
  return { runtime, direct };
}

export async function verifyTestTarget(
  { runtime, direct }: Target,
  { beforeMigrations = false } = {},
) {
  neonConfig.webSocketConstructor = ws;
  for (const url of [runtime, direct]) {
    const db = connectDatabase(url);
    try {
      if (!(await matchesTestDatabase(db, url === runtime)))
        throw new Error(
          "The dedicated database marker could not be verified. Live tests were blocked.",
        );
      if (url === runtime) {
        if (!beforeMigrations) await assertRuntimeRole(db);
      } else {
        const [row] = await db.$queryRaw<{ owner: boolean }[]>`
          SELECT count(*) = 2 AND bool_and(relowner = current_user::regrole::oid) AS owner
          FROM pg_class WHERE oid IN ('public."StudySet"'::regclass, 'public."CloneConversion"'::regclass)
        `;
        if (!row?.owner)
          throw new Error(
            "The direct test connection must own the test schema tables.",
          );
      }
    } finally {
      await db.$disconnect();
    }
  }
}

export async function verifyTestApp(base: string, runtime: string) {
  if (!isLoopbackOrigin(base))
    throw new Error("Live tests require an explicit loopback HTTP origin.");
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(base + testDatabasePath, {
    headers: { [testDatabaseHeader]: challenge },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (
    response.status !== 204 ||
    response.headers.get(testDatabaseProofHeader) !==
      (await testDatabaseDigest(`${challenge}\n${runtime}`))
  )
    throw new Error(
      "The local app did not verify the dedicated database marker. Live tests were blocked.",
    );
}
