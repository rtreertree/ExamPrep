import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { productionConfig } from "./deployment-config.mjs";

let directory;
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      `${command} failed; production release stopped. Check the preceding step.`,
    );
}
try {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_JOB !== "production"
  )
    throw new Error(
      "Use the GitHub Release workflow on main. Production migration/deployment is restricted to its production job.",
    );
  productionConfig(process.env);
  // Package errors must fail before any production migration is applied.
  run("node_modules/.bin/wrangler", [
    "deploy",
    "--env",
    "production",
    "--dry-run",
    "--outdir",
    "dist/worker-production",
  ]);
  run(process.execPath, ["scripts/migrate.mjs"]);
  run(process.execPath, ["--import", "tsx", "scripts/free-tier-check.ts"]);
  directory = await mkdtemp(join(tmpdir(), "exam-prep-release-"));
  const path = join(directory, "secrets.json");
  const keys = ["DATABASE_URL", "BETTER_AUTH_SECRET", "PASSWORD_PEPPER"];
  if (
    process.env.RESEND_API_KEY?.trim() &&
    process.env.RESET_EMAIL_FROM?.trim()
  )
    keys.push("RESEND_API_KEY", "RESET_EMAIL_FROM");
  await writeFile(
    path,
    JSON.stringify(
      Object.fromEntries(keys.map((key) => [key, process.env[key]])),
    ),
    { mode: 0o600 },
  );
  // One version contains the code and its matching secrets. Never upload the direct URL.
  run("node_modules/.bin/wrangler", [
    "deploy",
    "--env",
    "production",
    "--secrets-file",
    path,
    "--message",
    `GitHub ${process.env.GITHUB_SHA ?? "manual release"}`,
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
