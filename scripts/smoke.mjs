import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

function assert(ok, message) {
  if (!ok) throw new Error(message);
}
export async function checkSmoke(base, { worker, releaseTag }) {
  const request = (path) =>
    fetch(new URL(path, base), {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  const html = await request("/");
  assert(
    html.status === 200 &&
      html.headers.get("content-type")?.includes("text/html"),
    "Frontend must return HTTP 200 HTML.",
  );
  const text = await html.text();
  assert(
    text.includes("<title>Exam Prep</title>") && text.includes('id="root"'),
    "Frontend identity/root is missing.",
  );
  assert(
    html.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
    "Frontend CSP is missing.",
  );
  const asset = text.match(/src="(\/assets\/[^\"]+\.js)"/);
  assert(asset, "Built frontend JavaScript is missing.");
  const javascript = await request(asset[1]);
  assert(
    javascript.ok &&
      javascript.headers.get("content-type")?.includes("javascript"),
    "Frontend JavaScript asset is unavailable.",
  );
  if (worker)
    assert(
      javascript.headers.get("cache-control")?.includes("immutable"),
      "Hashed asset cache policy is missing.",
    );
  const deep = await request("/history");
  assert(
    deep.status === 200 && (await deep.text()).includes('id="root"'),
    "Client routing failed on /history.",
  );
  const health = await request("/api/health");
  assert(
    health.status === 200 &&
      health.headers.get("content-type")?.includes("application/json"),
    "Safe API health endpoint failed.",
  );
  const data = await health.json();
  assert(
    data.status === "ok" && data.runtime === (worker ? "worker" : "node"),
    "Health response reports the wrong runtime.",
  );
  assert(
    releaseTag === undefined || data.releaseTag === releaseTag,
    "The expected release attempt is not serving traffic.",
  );
  assert(
    health.headers.get("cache-control")?.includes("no-store"),
    "API must never enter shared cache.",
  );
  const privateResponse = await request("/api/sets");
  assert(
    privateResponse.status === 401 &&
      privateResponse.headers.get("cache-control")?.includes("no-store"),
    "Private API must require sign-in and disable caching.",
  );
  const missing = await request("/api/__smoke_missing");
  assert(
    missing.headers.get("content-type")?.includes("application/json") &&
      missing.status >= 400,
    "Missing API routes must not return the SPA.",
  );
  const apiRoot = await request("/api");
  assert(
    apiRoot.status === 404 &&
      apiRoot.headers.get("content-type")?.includes("application/json"),
    "Bare /api must return a JSON error, not the SPA.",
  );
  if (base.protocol === "https:")
    assert(
      html.headers.has("strict-transport-security"),
      "HTTPS frontend HSTS is missing.",
    );
}
async function main() {
  const { values, positionals } = parseArgs({
    options: { node: { type: "boolean" }, "release-tag": { type: "string" } },
    allowPositionals: true,
  });
  const base = new URL(positionals[0] ?? "https://exam.phonet.app");
  const worker = !values.node;
  const releaseTag = values["release-tag"];
  assert(
    base.protocol === "https:" ||
      ["127.0.0.1", "localhost"].includes(base.hostname),
    "Smoke checks require HTTPS outside localhost.",
  );
  assert(
    releaseTag === undefined || (worker && /^gha-\d+-\d+$/.test(releaseTag)),
    "Supply a valid GitHub attempt tag for Worker release smoke.",
  );
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await checkSmoke(base, { worker, releaseTag });
      console.info(
        `Smoke passed: frontend, assets, client routing, ${worker ? "Worker" : "Node"} health and private API policy.`,
      );
      return;
    } catch (error) {
      // Never emit server bodies, cookies, connection strings or raw fetch errors.
      if (attempt === 6) {
        console.error(
          `Smoke failed: ${error instanceof TypeError ? "Network/TLS connection failed." : error.message} Check Cloudflare deployment logs, DNS/TLS, ASSETS binding and runtime secrets. Smoke performs no writes.`,
        );
        process.exitCode = 1;
      } else await delay(5000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
