import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import type { Database } from "../server/db";
import {
  testDatabaseDigest,
  testDatabaseHeader,
  testDatabasePath,
  testDatabaseProofHeader,
} from "../server/testDatabase";
import { assertRuntimeRole } from "../scripts/runtime-role";
import { readTestTarget, verifyTestApp } from "../scripts/test-target";

const origin = "http://127.0.0.1:8791";
const token = "a".repeat(64);
const runtime =
  "postgres://examprep_runtime:fake@ep-test-pooler.us-east-2.aws.neon.tech/test?sslmode=require";
const direct =
  "postgres://owner:fake@ep-test.us-east-2.aws.neon.tech/test?sslmode=require";
const env = {
  TEST_DATABASE_URL: runtime,
  TEST_DATABASE_URL_UNPOOLED: direct,
  TEST_DATABASE_TOKEN: token,
};

afterEach(() => vi.restoreAllMocks());

describe("live database guards", () => {
  it("requires test-only credentials with a single database and distinct roles", () => {
    expect(() =>
      readTestTarget({ DATABASE_URL: runtime, DATABASE_URL_UNPOOLED: direct }),
    ).toThrow(/test-only/);
    expect(() =>
      readTestTarget({
        ...env,
        TEST_DATABASE_URL_UNPOOLED: direct.replace("ep-test", "ep-other"),
      }),
    ).toThrow(/same Neon/);
    expect(() =>
      readTestTarget({
        ...env,
        TEST_DATABASE_URL_UNPOOLED: direct.replace(
          "owner:",
          "examprep_runtime:",
        ),
      }),
    ).toThrow(/separate roles/);
    expect(readTestTarget(env)).toEqual({ runtime, direct, token });
  });

  it("accepts the proof only on the configured test runtime and blocks sign-up when the marker fails", async () => {
    const query = vi.fn().mockResolvedValue([{ matched: true }]);
    const disconnect = vi.fn();
    const db = {
      $queryRaw: query,
      $disconnect: disconnect,
    } as unknown as Database;
    const config = {
      DATABASE_URL: runtime,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: "b".repeat(32),
      PASSWORD_PEPPER: "c".repeat(32),
    };
    const marker = new Request(origin + testDatabasePath, {
      headers: { [testDatabaseHeader]: token },
    });
    const signUp = new Request(origin + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await createApp(config, () => db).fetch(marker)).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    const app = createApp({ ...config, TEST_DATABASE_TOKEN: token }, () => db);
    const proof = await app.fetch(marker);
    expect(proof.status).toBe(204);
    expect(proof.headers.get(testDatabaseProofHeader)).toBe(
      await testDatabaseDigest(token),
    );
    query.mockRejectedValueOnce(new Error("Missing marker table"));
    expect((await app.fetch(signUp)).status).toBe(503);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("requires proof before accepting a local URL and refuses owner-level privileges", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    await expect(verifyTestApp("https://example.test", token)).rejects.toThrow(
      /loopback/,
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(verifyTestApp(origin, token)).rejects.toThrow(/marker/);
    expect(fetch).toHaveBeenCalledWith(
      origin + testDatabasePath,
      expect.objectContaining({ redirect: "error" }),
    );
    fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(verifyTestApp(origin, token)).rejects.toThrow(/marker/);
    await expect(
      assertRuntimeRole({
        $queryRaw: vi.fn().mockResolvedValue([{ safe: false }]),
      }),
    ).rejects.toThrow(/restricted runtime/);
  });
});
