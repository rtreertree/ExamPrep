import "dotenv/config";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse, type ParseError } from "jsonc-parser";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { connectDatabase } from "../server/db";
import { PASSWORD_PATTERN, PASSWORD_PREFIX } from "../server/passwords";

neonConfig.webSocketConstructor = ws;
const local = process.argv.includes("--local");
const failures: string[] = [];
function check(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}
async function files(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(path, entry.name))
          : [join(path, entry.name)],
      ),
    )
  ).flat();
}

const parseErrors: ParseError[] = [];
const config =
  parse(await readFile("wrangler.jsonc", "utf8"), parseErrors, {
    allowTrailingComma: true,
  }) ?? {};
check(parseErrors.length === 0, "Fix wrangler.jsonc syntax.");
check(
  config.limits?.cpu_ms === undefined || config.limits.cpu_ms <= 10,
  "Remove the paid-only CPU allowance.",
);
check(config.minify === true, "Enable Worker minification.");
check(
  config.assets?.not_found_handling === "single-page-application",
  "Keep SPA asset routing enabled.",
);
check(
  config.assets?.run_worker_first?.includes("/api/*"),
  "Keep API requests routed to the Worker first.",
);

try {
  // This conservative project budget also fits accounts with the older 3-MiB
  // compressed-script allowance. Source maps are not uploaded runtime modules.
  const modules = (await files("dist/worker")).filter((path) =>
    /\.(js|mjs|wasm)$/.test(path),
  );
  check(
    modules.length > 0,
    "Run npm run worker:check to produce the Worker package.",
  );
  const bytes = (
    await Promise.all(
      modules.map(async (path) => gzipSync(await readFile(path)).length),
    )
  ).reduce((a, b) => a + b, 0);
  check(
    bytes <= 3 * 1024 * 1024,
    "Worker exceeds the project's conservative 3-MiB compressed budget.",
  );
  console.info(`Worker package: ${Math.ceil(bytes / 1024)} KiB compressed.`);
  const assets = await files("dist/client");
  check(
    assets.length <= 20000,
    "Static assets exceed the free-tier file count.",
  );
  check(
    (
      await Promise.all(assets.map(async (path) => (await stat(path)).size))
    ).every((size) => size <= 25 * 1024 * 1024),
    "A static asset exceeds 25 MiB.",
  );
  console.info(`Static assets: ${assets.length} files.`);
} catch {
  failures.push(
    "Build the client and Worker package before running this check.",
  );
}

check(
  (process.env.BETTER_AUTH_SECRET?.length ?? 0) >= 32,
  "Set a strong BETTER_AUTH_SECRET of at least 32 characters.",
);
check(
  (process.env.PASSWORD_PEPPER?.length ?? 0) >= 32,
  "Set a separate stable PASSWORD_PEPPER of at least 32 characters.",
);
try {
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "");
  check(
    origin.protocol === "https:" ||
      (local && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)),
    "Set BETTER_AUTH_URL to the exact public HTTPS origin (or use --local for local checks).",
  );
  const url = new URL(process.env.DATABASE_URL ?? "");
  check(
    ["require", "verify-ca", "verify-full"].includes(
      url.searchParams.get("sslmode") ?? "",
    ),
    "Use a TLS-protected database connection.",
  );
} catch {
  failures.push("Set valid DATABASE_URL and BETTER_AUTH_URL values.");
}

let db: ReturnType<typeof connectDatabase> | undefined;
try {
  db = connectDatabase(process.env.DATABASE_URL ?? "");
  const probe = await db.$queryRaw<{ supported: boolean }[]>`
    SELECT length(public.crypt('Exam Prep readiness probe', public.gen_salt('bf', 12))) = 60 AS supported
  `;
  check(probe[0]?.supported, "Apply the pgcrypto password-hashing migration.");
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM account WHERE "providerId" = 'credential'
      AND (password IS NULL OR length(password) <> ${PASSWORD_PREFIX.length + 60} OR password !~ ${PASSWORD_PATTERN.source})
  `;
  check(
    rows[0]?.count === 0,
    `${rows[0]?.count ?? "Unknown"} credential account(s) still need migration. Each owner must sign in successfully on the Node app before deploying this database to Workers Free.`,
  );
} catch {
  failures.push(
    "Database password readiness check failed. Check connectivity and apply migrations; driver details are intentionally hidden.",
  );
} finally {
  await db?.$disconnect();
}
if (failures.length) {
  failures.forEach((failure) => console.error(failure));
  process.exitCode = 1;
} else {
  console.info(
    "Free-tier configuration, package, and password readiness checks passed.",
  );
}
console.info(
  "Local checks do not measure Cloudflare's production CPU accounting. Validate real request CPU and quotas on the target account before relying on the free tier.",
);
