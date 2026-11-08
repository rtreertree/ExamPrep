import { describe, expect, it, vi } from "vitest";
import { scryptSync } from "node:crypto";
import {
  databasePasswords,
  PASSWORD_PREFIX,
  passwordInput,
} from "../server/passwords";

const pepper = "test-only-pepper-".repeat(3);
const bcrypt = "$2a$12$" + "a".repeat(53);
const stored = PASSWORD_PREFIX + bcrypt;
const password = "Long Unicode 🦊 password ".repeat(4);
function legacy(value: string) {
  const salt = "0123456789abcdef0123456789abcdef";
  return (
    salt +
    ":" +
    scryptSync(value.normalize("NFKC"), salt, 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 67108864,
    }).toString("hex")
  );
}

describe("database-backed password callbacks", () => {
  it("keeps Unicode, long suffixes, and NUL distinct without bcrypt truncation", () => {
    const digest = passwordInput(password, pepper);
    expect(digest).toMatch(/^[A-Za-z0-9+/]{64}$/);
    expect(passwordInput(password + "x", pepper)).not.toBe(digest);
    expect(passwordInput("a\0b", pepper)).not.toBe(passwordInput("a", pepper));
    expect(passwordInput("café", pepper)).toBe(
      passwordInput("cafe\u0301", pepper),
    );
    expect(passwordInput(password, pepper + "x")).not.toBe(digest);
  });
  it("rejects missing/short peppers", () => {
    expect(() =>
      databasePasswords({ $queryRaw: vi.fn() }, "", "worker"),
    ).toThrow("PASSWORD_PEPPER");
  });
  it("delegates cost-12 hashing to parameterized SQL without sending the password or pepper", async () => {
    const query = vi.fn().mockResolvedValue([{ hash: bcrypt }]);
    expect(
      await databasePasswords({ $queryRaw: query }, pepper, "worker").hash(
        password,
      ),
    ).toBe(stored);
    expect(query.mock.calls[0][0].join("?")).toContain("gen_salt('bf', 12)");
    expect(query.mock.calls[0].slice(1)).toEqual([
      passwordInput(password, pepper),
    ]);
  });
  it("verifies in the database and never accepts a missing/non-boolean result", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ valid: true }])
      .mockResolvedValueOnce([{ valid: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ valid: "true" }]);
    const callbacks = databasePasswords({ $queryRaw: query }, pepper, "worker");
    for (const expected of [true, false, false, false])
      expect(await callbacks.verify({ hash: stored, password })).toBe(expected);
  });
  it.each([
    "",
    bcrypt,
    PASSWORD_PREFIX + bcrypt.replace("12$", "04$"),
    PASSWORD_PREFIX + bcrypt.replace("12$", "31$"),
    stored + "x",
    stored + "\n",
    "unknown:v2",
  ])("rejects malformed or unsupported hash %s before SQL", async (hash) => {
    const query = vi.fn();
    expect(
      await databasePasswords({ $queryRaw: query }, pepper, "worker").verify({
        hash,
        password,
      }),
    ).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("sanitizes SQL failures instead of logging credential-bearing driver errors", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error("sensitive-driver-details"));
    const callbacks = databasePasswords({ $queryRaw: query }, pepper, "worker");
    await expect(callbacks.hash(password)).rejects.toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      body: { code: "PASSWORD_PROCESSING_UNAVAILABLE" },
    });
    await expect(
      callbacks.verify({ hash: stored, password }),
    ).rejects.not.toThrow("sensitive-driver-details");
  });
  it("does not invoke expensive legacy hashing on Workers", async () => {
    const query = vi.fn();
    await expect(
      databasePasswords({ $queryRaw: query }, pepper, "worker").verify({
        hash: legacy(password),
        password,
      }),
    ).rejects.toMatchObject({ body: { code: "PASSWORD_MIGRATION_REQUIRED" } });
    expect(query).not.toHaveBeenCalled();
  });
  it("upgrades a correct legacy password on Node with compare-and-set", async () => {
    const encoded = legacy(password);
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ hash: bcrypt }])
      .mockResolvedValueOnce([{ id: "existing-account" }]);
    expect(
      await databasePasswords({ $queryRaw: query }, pepper, "node").verify({
        hash: encoded,
        password,
      }),
    ).toBe(true);
    expect(query.mock.calls[1][0].join("?")).toContain("AND password =");
    expect(query.mock.calls[1].slice(1)).toEqual([stored, encoded]);
  });
  it("leaves a legacy account untouched after an incorrect password", async () => {
    const query = vi.fn();
    expect(
      await databasePasswords({ $queryRaw: query }, pepper, "node").verify({
        hash: legacy(password),
        password: "wrong-password",
      }),
    ).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it("does not authenticate against a stale legacy hash after a concurrent password change", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ hash: bcrypt }])
      .mockResolvedValueOnce([]);
    expect(
      await databasePasswords({ $queryRaw: query }, pepper, "node").verify({
        hash: legacy(password),
        password,
      }),
    ).toBe(false);
  });
});
