import { appendFile, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export function ciSettings(env) {
  for (const name of [
    "NEON_API_KEY",
    "NEON_PROJECT_ID",
    "NEON_PARENT_BRANCH_ID",
    "GITHUB_REPOSITORY_ID",
  ])
    if (
      !env[name] ||
      (!/^[A-Za-z0-9_-]+$/.test(env[name]) && name !== "NEON_API_KEY")
    )
      throw new Error(
        `Configure integration ${name}. Never use the production Neon project.`,
      );
  return {
    project: env.NEON_PROJECT_ID,
    parent: env.NEON_PARENT_BRANCH_ID,
    prefix: `examprep-ci-${env.GITHUB_REPOSITORY_ID}-`,
  };
}

// Safety checks are repeated against live metadata immediately before each deletion.
export function disposable(branch, settings) {
  return (
    typeof branch.id === "string" &&
    branch.id !== settings.parent &&
    branch.parent_id === settings.parent &&
    branch.name?.startsWith(settings.prefix) &&
    branch.default === false &&
    branch.protected !== true
  );
}

export async function neonCI(command, env = process.env, request = fetch) {
  const stateFile = join(env.RUNNER_TEMP ?? "/tmp", "examprep-neon-ci.json");
  let state;
  if (command === "cleanup") {
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch (error) {
      // A build/setup failure before creation has nothing to clean up, even if
      // integration credentials have not been configured yet.
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
  const settings = ciSettings(env);
  const root = `/projects/${encodeURIComponent(settings.project)}`;
  async function api(method, path, body, allowMissing = false) {
    let response;
    try {
      response = await request(`https://console.neon.tech/api/v2${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.NEON_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error(
        `Neon ${method} connection failed. Check integration API access; inspect CI-prefixed branches for an interrupted request.`,
      );
    }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `Neon ${method} returned HTTP ${response.status}. Check integration permissions, configuration and branch quota. Response details are hidden.`,
      );
    return response.json();
  }
  async function verifyParent() {
    const { branch } = await api(
      "GET",
      `${root}/branches/${encodeURIComponent(settings.parent)}`,
    );
    if (branch.name !== "ci-empty")
      throw new Error(
        "CI parent must be named ci-empty in a dedicated test project; refusing to clone a production branch.",
      );
  }
  async function remove(branch) {
    const live = await api(
      "GET",
      `${root}/branches/${encodeURIComponent(branch.id)}`,
      undefined,
      true,
    );
    if (!live) return;
    if (!disposable(live.branch, settings))
      throw new Error(
        "Refusing to delete a branch outside this repository CI scope.",
      );
    await api("DELETE", `${root}/branches/${encodeURIComponent(branch.id)}`);
    console.info("Deleted disposable Neon CI branch.");
  }
  if (command === "create") {
    await verifyParent();
    for (const key of [
      "NEON_DATABASE_NAME",
      "NEON_ROLE_NAME",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_ENV",
    ])
      if (!env[key]) throw new Error(`Configure integration ${key}.`);
    const name = `${settings.prefix}${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
    // Save the intended name first so cleanup can recover even if a POST response is lost.
    await writeFile(
      stateFile,
      JSON.stringify({
        project: settings.project,
        parent: settings.parent,
        name,
      }),
      { mode: 0o600 },
    );
    const { branch } = await api("POST", `${root}/branches`, {
      branch: { name, parent_id: settings.parent },
      endpoints: [{ type: "read_write" }],
    });
    await writeFile(
      stateFile,
      JSON.stringify({
        project: settings.project,
        parent: settings.parent,
        name,
        id: branch.id,
      }),
      { mode: 0o600 },
    );
    if (!disposable(branch, settings))
      throw new Error(
        "Unexpected test branch metadata; refusing to use its connection.",
      );
    const urls = {};
    for (const [key, pooled] of [
      ["DATABASE_URL", true],
      ["DATABASE_URL_UNPOOLED", false],
    ]) {
      const query = new URLSearchParams({
        branch_id: branch.id,
        database_name: env.NEON_DATABASE_NAME,
        role_name: env.NEON_ROLE_NAME,
        pooled: String(pooled),
      });
      const { uri } = await api("GET", `${root}/connection_uri?${query}`);
      const url = new URL(uri);
      url.searchParams.set("sslmode", "require");
      urls[key] = url.toString();
    }
    Object.assign(urls, {
      BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      PASSWORD_PEPPER: randomBytes(48).toString("base64url"),
    });
    for (const [key, value] of Object.entries(urls)) {
      // Register masks before writing environment values; never use step outputs for secrets.
      console.info(
        `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
      );
      await appendFile(env.GITHUB_ENV, `${key}=${value}\n`);
    }
    await appendFile(
      env.GITHUB_ENV,
      "RUN_DATABASE_TESTS=1\nTEST_DATABASE_CONFIRMED=1\n",
    );
    console.info(
      "Created isolated Neon branch and fresh test authentication settings.",
    );
  } else if (command === "cleanup" || command === "sweep") {
    if (command === "cleanup") {
      if (
        state.project !== settings.project ||
        state.parent !== settings.parent ||
        !state.name?.startsWith(settings.prefix)
      )
        throw new Error(
          "CI cleanup state does not match this project and repository.",
        );
    }
    await verifyParent();
    // Paginate fully before deleting; deletion must not disturb pagination.
    const branches = [];
    let cursor;
    do {
      const query = new URLSearchParams({
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      const page = await api("GET", `${root}/branches?${query}`);
      branches.push(...page.branches);
      cursor = page.pagination?.next;
    } while (cursor);
    for (const branch of branches) {
      const matches =
        command === "cleanup"
          ? branch.name === state.name && (!state.id || branch.id === state.id)
          : disposable(branch, settings) &&
            Date.now() - Date.parse(branch.created_at) > 2 * 60 * 60 * 1000;
      if (matches) await remove(branch);
    }
    if (command === "cleanup") await rm(stateFile, { force: true });
  } else throw new Error("Use neon-ci.mjs create, cleanup or sweep.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await neonCI(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
