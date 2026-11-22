import { appendFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { productionConfig } from "./deployment-config.mjs";

let directory;
let phase = "Production preflight";
const workerPackage = [
  "deploy",
  "dist/worker-production/worker.js",
  "--env",
  "production",
  "--no-bundle",
  "--minify=false",
  "--upload-source-maps",
];
function run(nextPhase, command, args) {
  phase = nextPhase;
  console.info(`### ${phase}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${phase} failed. See the command output above.`);
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
  const tag = process.env.RELEASE_TAG;
  if (!/^gha-\d+-\d+$/.test(tag ?? ""))
    throw new Error("The GitHub release attempt tag is missing or invalid.");
  productionConfig(process.env);
  // Package errors must fail before any production migration is applied.
  run("Worker package preflight", "node_modules/.bin/wrangler", [
    ...workerPackage,
    "--dry-run",
  ]);
  run("Review schedule preflight", process.execPath, [
    "--import",
    "tsx",
    "scripts/check-review-schedules.ts",
  ]);
  run("Database migrations", process.execPath, ["scripts/migrate.mjs"]);
  run("Production readiness", process.execPath, [
    "--import",
    "tsx",
    "scripts/free-tier-check.ts",
    "--production-package",
  ]);
  phase = "Cloudflare deployment";
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
  run(phase, "node_modules/.bin/wrangler", [
    ...workerPackage,
    "--secrets-file",
    path,
    "--tag",
    tag,
    "--message",
    `GitHub ${process.env.GITHUB_SHA ?? "manual release"}`,
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `failed_phase=${phase}\n`);
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
