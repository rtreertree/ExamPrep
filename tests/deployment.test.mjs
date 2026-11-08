import { describe, it, expect } from "vitest";
import {
  checkConnections,
  productionConfig,
} from "../scripts/deployment-config.mjs";

describe("production deployment configuration", () => {
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
});
