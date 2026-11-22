import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "jsonc-parser";
import { connectDatabase } from "../server/db";
import { readTestTarget, verifyTestApp, verifyTestTarget } from "./test-target";

const target = readTestTarget();
const productionPackage = process.argv.includes("--production-package");
for (const key of ["PASSWORD_PEPPER", "BETTER_AUTH_SECRET"])
  if ((process.env[key]?.length ?? 0) < 32)
    throw new Error(`Set a test ${key} of at least 32 characters.`);
await verifyTestTarget(target);
const directory = await mkdtemp(join(tmpdir(), "examprep-acceptance-"));
const children = new Set<ChildProcess>();
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10000)]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
async function command(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { env, stdio: "inherit" });
  children.add(child);
  const [code] = await once(child, "exit");
  children.delete(child);
  if (code !== 0) throw new Error(`Acceptance command ${args[0]} failed.`);
}
async function ready(base: string, child: ChildProcess, runtime: string) {
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null)
      throw new Error(
        `${runtime} exited before becoming ready; inspect local runtime configuration.`,
      );
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (
        response.ok &&
        ((await response.json()) as { runtime: string }).runtime === runtime
      )
        return;
    } catch {
      /* startup retry */
    }
    await delay(1000);
  }
  throw new Error(
    `${runtime} did not become ready on its isolated acceptance port.`,
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    for (const child of children) child.kill("SIGTERM");
    process.exitCode = 1;
  });
try {
  const db = connectDatabase(target.direct);
  try {
    // CI requires a pristine branch: this also catches an accidentally populated parent.
    if (process.env.CI && (await db.user.count()) !== 0)
      throw new Error(
        "CI branch contains accounts. Use an empty ci-empty parent, never production.",
      );
  } finally {
    await db.$disconnect();
  }
  for (const [runtime, port] of [
    ["node", 8791],
    ["worker", 8792],
  ] as const) {
    const base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      DATABASE_URL: target.runtime,
      DATABASE_URL_UNPOOLED: target.direct,
      BETTER_AUTH_URL: base,
      TEST_BASE_URL: base,
      RUN_DATABASE_TESTS: "1",
      PORT: String(port),
      WRANGLER_SEND_METRICS: "false",
      RESEND_API_KEY: "",
      RESET_EMAIL_FROM: "",
    };
    let args: string[];
    if (runtime === "worker") {
      const config = parse(await readFile("wrangler.jsonc", "utf8"));
      // Local test config has no production routes, account ID, envs or secrets.
      delete config.env;
      delete config.$schema;
      config.secrets = {
        required: [...config.secrets.required, "TEST_DATABASE_TOKEN"],
      };
      Object.assign(config, {
        name: "exam-prep-acceptance",
        main: resolve(
          productionPackage ? "dist/worker-production/worker.js" : config.main,
        ),
        workers_dev: false,
        routes: [],
        assets: {
          ...config.assets,
          directory: resolve(config.assets.directory),
        },
      });
      await writeFile(join(directory, "wrangler.json"), JSON.stringify(config));
      await writeFile(
        join(directory, ".dev.vars"),
        [
          "DATABASE_URL",
          "BETTER_AUTH_SECRET",
          "PASSWORD_PEPPER",
          "BETTER_AUTH_URL",
          "TEST_DATABASE_TOKEN",
        ]
          .map(
            (key) => `${key}=${JSON.stringify(env[key as keyof typeof env])}`,
          )
          .join("\n"),
        { mode: 0o600 },
      );
      args = [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--config",
        join(directory, "wrangler.json"),
        "--local",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        "--infer-origin-from-routes=false",
      ];
      if (productionPackage) args.push("--no-bundle", "--minify=false");
    } else args = ["dist/server.js"];
    const server = spawn(process.execPath, args, { env, stdio: "ignore" });
    children.add(server);
    try {
      await ready(base, server, runtime);
      await verifyTestApp(base, target.token);
      console.info(`Running API and browser acceptance on ${runtime}.`);
      if (!process.argv.includes("--smoke-only")) {
        await command(
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            "tests/api.integration.test.ts",
          ],
          env,
        );
        await command(["node_modules/@playwright/test/cli.js", "test"], env);
      }
      await command(
        ["scripts/smoke.mjs", base, ...(runtime === "node" ? ["--node"] : [])],
        env,
      );
    } finally {
      await stop(server);
      children.delete(server);
    }
  }
} finally {
  await Promise.all([...children].map(stop));
  await rm(directory, { recursive: true, force: true });
}
