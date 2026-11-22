import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { connectDatabase } from "../server/db";
import { assertRuntimeRole } from "./runtime-role";
import { checkConnections } from "./deployment-config.mjs";
import {
  isLoopbackOrigin,
  matchesTestDatabase,
  testDatabaseDigest,
  testDatabaseHeader,
  testDatabasePath,
  testDatabaseProofHeader,
} from "../server/testDatabase";

type Target = { runtime: string; direct: string; token: string };

export function readTestTarget(
  env: { [key: string]: string | undefined } = process.env,
): Target {
  const runtime = env.TEST_DATABASE_URL;
  const direct = env.TEST_DATABASE_URL_UNPOOLED;
  const token = env.TEST_DATABASE_TOKEN;
  if (!runtime || !direct || !token || !/^[\da-f]{64}$/.test(token))
    throw new Error(
      "Set test-only pooled and direct URLs and a 64-digit hex TEST_DATABASE_TOKEN.",
    );
  try {
    const urls = checkConnections({
      DATABASE_URL: runtime,
      DATABASE_URL_UNPOOLED: direct,
    });
    if (
      decodeURIComponent(urls.runtime.username) ===
      decodeURIComponent(urls.migration.username)
    )
      throw new Error("Live tests require separate database roles.");
  } catch {
    throw new Error(
      "Test connections must use separate roles on the same Neon database, pooled and direct with TLS.",
    );
  }
  return { runtime, direct, token };
}

export async function verifyTestTarget({ runtime, direct, token }: Target) {
  neonConfig.webSocketConstructor = ws;
  for (const url of [runtime, direct]) {
    const db = connectDatabase(url);
    try {
      if (!(await matchesTestDatabase(db, token, url === runtime)))
        throw new Error(
          "The dedicated database marker could not be verified. Live tests were blocked.",
        );
      if (url === runtime) {
        await assertRuntimeRole(db);
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

export async function verifyTestApp(base: string, token: string) {
  if (!isLoopbackOrigin(base))
    throw new Error("Live tests require an explicit loopback HTTP origin.");
  const response = await fetch(base + testDatabasePath, {
    headers: { [testDatabaseHeader]: token },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (
    response.status !== 204 ||
    response.headers.get(testDatabaseProofHeader) !==
      (await testDatabaseDigest(token))
  )
    throw new Error(
      "The local app did not verify the dedicated database marker. Live tests were blocked.",
    );
}
