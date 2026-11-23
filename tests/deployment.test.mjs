import { afterEach, describe, it, expect, vi } from "vitest";
import {
  checkConnections,
  productionConfig,
} from "../scripts/deployment-config.mjs";
import { isCurrentMain } from "../scripts/release-head.mjs";
import { describeMigrationFailure } from "../scripts/migrate.mjs";
import { checkSmoke } from "../scripts/smoke.mjs";
import { createApp } from "../server/app";

afterEach(() => vi.unstubAllGlobals());

it("reports Prisma migration codes without exposing raw errors or credentials", () => {
  const output = describeMigrationFailure({
    stderr:
      "\x1b[31mError: P3018\x1b[0m\nMigration name: 202611210001_live_sets\nDatabase error code: 42501\nDatabase error: private SQL and postgresql://owner:password@test",
  });
  expect(output).toContain("P3018, SQLSTATE 42501, 202611210001_live_sets");
  expect(output).not.toMatch(/private SQL|password|postgresql:/);
  expect(describeMigrationFailure({ stderr: "Error: P3009" })).toMatch(
    /previously failed migration/,
  );
  expect(describeMigrationFailure({ stderr: "Error: P1001" })).toMatch(
    /could not be reached/,
  );
});

describe("production deployment configuration", () => {
  const env = {
    DATABASE_URL:
      "postgresql://examprep_runtime:fake@ep-ci-pooler.ap-southeast-1.aws.neon.tech/test?sslmode=require",
    DATABASE_URL_UNPOOLED:
      "postgresql://test:fake@ep-ci.ap-southeast-1.aws.neon.tech/test?sslmode=require",
    BETTER_AUTH_SECRET: "a".repeat(48),
    PASSWORD_PEPPER: "b".repeat(48),
    BETTER_AUTH_URL: "https://exam.phonet.app",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "fake",
  };

  it("allows shared or separate roles for the pooled and direct production URLs", () => {
    expect(() => productionConfig(env)).not.toThrow();
    expect(() =>
      productionConfig({
        ...env,
        DATABASE_URL: env.DATABASE_URL.replace("examprep_runtime:", "test:"),
      }),
    ).not.toThrow();
  });

  it("rejects pooled migrations, cross-database configuration, insecure TLS and shared auth secrets", () => {
    expect(() =>
      checkConnections({ ...env, DATABASE_URL_UNPOOLED: env.DATABASE_URL }),
    ).toThrow(/direct/);
    expect(() =>
      checkConnections({
        ...env,
        DATABASE_URL_UNPOOLED: env.DATABASE_URL_UNPOOLED.replace(
          "/test?",
          "/production?",
        ),
      }),
    ).toThrow(/same/);
    expect(() =>
      checkConnections({
        ...env,
        DATABASE_URL: env.DATABASE_URL.replace("require", "disable"),
      }),
    ).toThrow(/TLS/);
    expect(() =>
      checkConnections({
        ...env,
        DATABASE_URL: env.DATABASE_URL + "&host=other.neon.tech",
      }),
    ).toThrow(/TLS/);
    expect(() =>
      productionConfig({ ...env, PASSWORD_PEPPER: env.BETTER_AUTH_SECRET }),
    ).toThrow(/different/);
    expect(() =>
      productionConfig({ ...env, BETTER_AUTH_URL: "http://exam.phonet.app" }),
    ).toThrow(/https/);
  });
});

describe("release freshness", () => {
  const env = {
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_REPOSITORY: "test/ExamPrep",
    GITHUB_SHA: "a".repeat(40),
    GH_TOKEN: "test-token",
  };

  it.each([
    [env.GITHUB_SHA, true],
    ["b".repeat(40), false],
  ])("compares the candidate with the live main ref", async (sha, current) => {
    const fetch = vi.fn(async () =>
      Response.json({ ref: "refs/heads/main", object: { sha } }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(isCurrentMain(env)).resolves.toBe(current);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.test/repos/test/ExamPrep/git/ref/heads/main",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails closed when GitHub cannot verify main", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    await expect(isCurrentMain(env)).rejects.toThrow(/could not verify/);
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ref: "refs/heads/other",
        object: { sha: env.GITHUB_SHA },
      }),
    );
    await expect(isCurrentMain(env)).rejects.toThrow(/could not verify/);
  });
});

describe("release smoke", () => {
  const releaseTag = "gha-123-2";
  const base = new URL("https://exam.example");

  it.each([
    ["gha-123-1", false],
    [undefined, false],
    [releaseTag, true],
  ])("requires the expected release tag", async (servingTag, matches) => {
    const connect = vi.fn();
    const app = createApp(
      { RUNTIME: "worker", RELEASE_TAG: servingTag },
      connect,
    );
    vi.stubGlobal("fetch", (url) => {
      switch (url.pathname) {
        case "/":
        case "/history":
          return new Response(
            '<title>Exam Prep</title><div id="root"></div><script src="/assets/abc.js"></script>',
            {
              headers: {
                "content-type": "text/html",
                "content-security-policy": "frame-ancestors 'none'",
                "strict-transport-security": "max-age=31536000",
              },
            },
          );
        case "/assets/abc.js":
          return new Response("", {
            headers: {
              "content-type": "application/javascript",
              "cache-control": "public, immutable",
            },
          });
        case "/api/health":
          return app.request(url);
        case "/api/sets":
          return Response.json(
            {},
            { status: 401, headers: { "cache-control": "no-store, private" } },
          );
        default:
          return Response.json({}, { status: 404 });
      }
    });
    const result = checkSmoke(base, { worker: true, releaseTag });
    if (matches) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow(/expected release attempt/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("preserves the Node health response", async () => {
    const app = createApp({ RELEASE_TAG: releaseTag }, vi.fn());
    const response = await app.request("/api/health");
    expect(await response.json()).toEqual({ status: "ok", runtime: "node" });
  });
});
