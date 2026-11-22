import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import {
  runtimeDatabaseRole,
  testDatabaseDigest,
} from "../server/testDatabase";
import { provisionRuntimeRole } from "./provision-runtime-role";
import { readTestTarget, verifyTestTarget } from "./test-target";

type Branch = { id: string; name: string; parent_id?: string };
type Endpoint = { id: string; host: string; branch_id: string; type: string };

const {
  GITHUB_ACTIONS,
  GITHUB_REF,
  GITHUB_RUN_ID,
  GITHUB_RUN_ATTEMPT,
  GITHUB_ENV,
  NEON_TEST_API_KEY,
  NEON_TEST_PROJECT_ID,
  NEON_TEST_PARENT_ID,
  NEON_TEST_DATABASE,
  NEON_TEST_OWNER,
} = process.env;
if (
  GITHUB_ACTIONS !== "true" ||
  GITHUB_REF !== "refs/heads/main" ||
  !GITHUB_ENV ||
  !/^\d+$/.test(GITHUB_RUN_ID ?? "") ||
  !/^\d+$/.test(GITHUB_RUN_ATTEMPT ?? "") ||
  !NEON_TEST_API_KEY ||
  !/^[a-z0-9-]+$/.test(NEON_TEST_PROJECT_ID ?? "") ||
  !/^br-[a-z0-9-]+$/.test(NEON_TEST_PARENT_ID ?? "")
)
  throw new Error(
    "Configure the protected Neon acceptance environment on main.",
  );

const name = `examprep-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`;
const base = `https://console.neon.tech/api/v2/projects/${NEON_TEST_PROJECT_ID}`;

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${NEON_TEST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && !(method === "DELETE" && response.status === 404))
    throw new Error(
      `Neon test branch ${method} failed with HTTP ${response.status}.`,
    );
  return method === "DELETE"
    ? (undefined as T)
    : ((await response.json()) as T);
}

function isRunBranch(branch: Branch) {
  return (
    branch.name === name &&
    branch.parent_id === NEON_TEST_PARENT_ID &&
    /^br-[a-z0-9-]+$/.test(branch.id) &&
    branch.id !== NEON_TEST_PARENT_ID
  );
}

async function isEmpty(pool: Pool) {
  for (let i = 0; i < 10; i++) {
    try {
      const {
        rows: [row],
      } = await pool.query<{ empty: boolean }>(`
        SELECT NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'examprep_test') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ) AS empty`);
      return row?.empty === true;
    } catch {
      if (i === 9)
        throw new Error("The isolated branch database could not be reached.");
      await delay(2000);
    }
  }
  return false;
}

async function prepare() {
  if (!NEON_TEST_DATABASE || !NEON_TEST_OWNER)
    throw new Error("Set the isolated database and owner names.");
  const { branch, endpoints } = await api<{
    branch: Branch;
    endpoints: Endpoint[];
  }>("/branches", "POST", {
    branch: { name, parent_id: NEON_TEST_PARENT_ID },
    endpoints: [{ type: "read_write" }],
  });
  const endpoint = endpoints.find(
    (item) => item.branch_id === branch.id && item.type === "read_write",
  );
  if (!isRunBranch(branch) || !endpoint || !/^ep-[a-z0-9-]+$/.test(endpoint.id))
    throw new Error(
      "Neon did not return the expected branch and endpoint identity.",
    );
  const query = new URLSearchParams({
    branch_id: branch.id,
    endpoint_id: endpoint.id,
    database_name: NEON_TEST_DATABASE,
    role_name: NEON_TEST_OWNER,
  });
  const { uri } = await api<{ uri: string }>(`/connection_uri?${query}`);
  const direct = new URL(uri);
  if (
    direct.hostname !== endpoint.host ||
    direct.hostname.split(".")[0] !== endpoint.id ||
    decodeURIComponent(direct.pathname.slice(1)) !== NEON_TEST_DATABASE ||
    decodeURIComponent(direct.username) !== NEON_TEST_OWNER
  )
    throw new Error(
      "Neon did not return credentials for the new branch endpoint.",
    );

  const password = randomBytes(32).toString("hex");
  const token = randomBytes(32).toString("hex");
  const pooled = new URL(direct);
  pooled.hostname = pooled.hostname.replace(".", "-pooler.");
  pooled.username = runtimeDatabaseRole;
  pooled.password = password;
  const env = {
    TEST_DATABASE_URL: pooled.href,
    TEST_DATABASE_URL_UNPOOLED: direct.href,
    TEST_DATABASE_TOKEN: token,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    PASSWORD_PEPPER: randomBytes(32).toString("hex"),
  };
  const target = readTestTarget(env);
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({
    connectionString: target.direct,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    if (!(await isEmpty(pool)))
      throw new Error(
        "The new test branch is populated. Acceptance was blocked.",
      );
    const migration = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
      env: { ...process.env, DATABASE_URL_UNPOOLED: target.direct },
      stdio: "inherit",
      timeout: 120_000,
    });
    if (migration.status !== 0)
      throw new Error("The test branch migration failed.");
    await provisionRuntimeRole(target.direct, password);
    await pool.query(`CREATE SCHEMA examprep_test;
      CREATE TABLE examprep_test.target (digest text PRIMARY KEY);
      GRANT USAGE ON SCHEMA examprep_test TO examprep_runtime;
      GRANT SELECT ON examprep_test.target TO examprep_runtime;`);
    await pool.query("INSERT INTO examprep_test.target (digest) VALUES ($1)", [
      await testDatabaseDigest(token),
    ]);
  } finally {
    await pool.end();
  }
  await verifyTestTarget(target);
  for (const secret of [
    ...Object.values(env),
    password,
    decodeURIComponent(direct.password),
  ])
    console.log(
      `::add-mask::${secret.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  await appendFile(
    GITHUB_ENV!,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  console.info("Isolated Neon branch migrated and verified.");
}

async function cleanup() {
  const { branches } = await api<{ branches: Branch[] }>(
    `/branches?search=${name}`,
  );
  const matches = branches.filter((branch) => branch.name === name);
  if (matches.length === 0) return;
  if (matches.length !== 1 || !isRunBranch(matches[0]))
    throw new Error(
      "Cleanup could not verify the branch identity. Inspect the isolated test project.",
    );
  for (let attempt = 0; ; attempt++) {
    try {
      await api(`/branches/${matches[0].id}`, "DELETE");
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await delay(2000);
    }
  }
  console.info("Disposable Neon branch deleted.");
}

try {
  if (process.argv[2] === "prepare") await prepare();
  else if (process.argv[2] === "cleanup") await cleanup();
  else throw new Error("Specify prepare or cleanup.");
} catch (error) {
  // Driver and API response bodies can contain connection information.
  const safeMessages =
    /^(Neon test branch|Neon did not return|The isolated branch|The new test branch|The test branch migration|Cleanup could not|Set the isolated|Specify prepare)/;
  console.error(
    error instanceof Error && safeMessages.test(error.message)
      ? error.message
      : "Isolated Neon branch operation failed. Inspect the protected test environment.",
  );
  process.exitCode = 1;
}
