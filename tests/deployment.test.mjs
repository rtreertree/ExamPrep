import { describe, it, expect } from "vitest";
import {
  checkConnections,
  productionConfig,
} from "../scripts/deployment-config.mjs";

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
