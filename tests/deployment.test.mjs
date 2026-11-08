import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { disposable, neonCI } from "../scripts/neon-ci.mjs";
import {
  checkConnections,
  productionConfig,
} from "../scripts/deployment-config.mjs";

const settings = {
  project: "ci-project",
  parent: "br-parent",
  prefix: "examprep-ci-123-",
};
const branch = {
  id: "br-child",
  parent_id: "br-parent",
  name: "examprep-ci-123-4-1",
  default: false,
  protected: false,
};
describe("deployment resource and credential boundaries", () => {
  it("refuses default, protected, parent, foreign-project-parent and other-repository branches", () => {
    expect(disposable(branch, settings)).toBe(true);
    for (const patch of [
      { default: true },
      { protected: true },
      { id: "br-parent" },
      { parent_id: "br-production" },
      { name: "production" },
      { name: "examprep-ci-456-4-1" },
    ])
      expect(disposable({ ...branch, ...patch }, settings)).toBe(false);
  });
  it("rejects pooled migrations, cross-database configuration, insecure TLS and shared auth secrets", () => {
    const env = {
      DATABASE_URL:
        "postgresql://test:fake@ep-ci-pooler.ap-southeast-1.aws.neon.tech/test?sslmode=require",
      DATABASE_URL_UNPOOLED:
        "postgresql://test:fake@ep-ci.ap-southeast-1.aws.neon.tech/test?sslmode=require",
      BETTER_AUTH_SECRET: "a".repeat(48),
      PASSWORD_PEPPER: "b".repeat(48),
      BETTER_AUTH_URL: "https://exam.phonet.app",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "fake",
    };
    expect(() => productionConfig(env)).not.toThrow();
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
      productionConfig({ ...env, PASSWORD_PEPPER: env.BETTER_AUTH_SECRET }),
    ).toThrow(/different/);
    expect(() =>
      productionConfig({ ...env, BETTER_AUTH_URL: "http://exam.phonet.app" }),
    ).toThrow(/https/);
  });
  it("recovers cleanup by exact run name after a lost creation response, with pagination and live metadata checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "examprep-neon-test-"));
    try {
      await writeFile(
        join(directory, "examprep-neon-ci.json"),
        JSON.stringify({ ...settings, name: branch.name }),
      );
      const calls = [];
      await neonCI(
        "cleanup",
        {
          NEON_API_KEY: "fake",
          NEON_PROJECT_ID: settings.project,
          NEON_PARENT_BRANCH_ID: settings.parent,
          GITHUB_REPOSITORY_ID: "123",
          RUNNER_TEMP: directory,
        },
        async (url, options) => {
          calls.push([options.method, url]);
          if (url.endsWith("/br-parent"))
            return Response.json({ branch: { name: "ci-empty" } });
          if (options.method === "DELETE") return Response.json({});
          if (url.endsWith("/br-child")) return Response.json({ branch });
          if (url.includes("cursor=second"))
            return Response.json({ branches: [branch] });
          return Response.json({
            branches: [{ ...branch, id: "br-production", name: "production" }],
            pagination: { next: "second" },
          });
        },
      );
      expect(calls.filter(([method]) => method === "DELETE")).toEqual([
        [
          "DELETE",
          "https://console.neon.tech/api/v2/projects/ci-project/branches/br-child",
        ],
      ]);
      await expect(
        readFile(join(directory, "examprep-neon-ci.json")),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rechecks protection at deletion time and does not expose Neon error bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "examprep-neon-test-"));
    const env = {
      NEON_API_KEY: "fake",
      NEON_PROJECT_ID: settings.project,
      NEON_PARENT_BRANCH_ID: settings.parent,
      GITHUB_REPOSITORY_ID: "123",
      RUNNER_TEMP: directory,
    };
    try {
      await writeFile(
        join(directory, "examprep-neon-ci.json"),
        JSON.stringify({ ...settings, name: branch.name }),
      );
      const methods = [];
      await expect(
        neonCI("cleanup", env, async (url, options) => {
          methods.push(options.method);
          return Response.json(
            url.endsWith("/br-parent")
              ? { branch: { name: "ci-empty" } }
              : url.includes("?")
                ? { branches: [branch] }
                : { branch: { ...branch, protected: true } },
          );
        }),
      ).rejects.toThrow(/Refusing to delete/);
      expect(methods).not.toContain("DELETE");
      await expect(
        neonCI(
          "sweep",
          env,
          async () => new Response("sensitive error body", { status: 403 }),
        ),
      ).rejects.toThrow(/HTTP 403/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
