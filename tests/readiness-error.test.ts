import { describe, expect, it } from "vitest";
import { readinessError } from "../scripts/readiness-error";

describe("safe deployment readiness failures", () => {
  it("distinguishes a rejected runtime password from a schema reset", () => {
    expect(readinessError({ code: "28P01" }, "connection")).toContain(
      "password is rejected",
    );
    expect(
      readinessError({ meta: { code: "42P01" } }, "credential-table query"),
    ).toContain("migration history was retained");
  });
  it("finds SQL codes in Prisma driver adapter errors", () => {
    const error = {
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: { originalCode: "42883", originalMessage: "sensitive SQL" },
        },
      },
    };
    expect(readinessError(error, "password-hashing probe")).toContain(
      "pgcrypto",
    );
    expect(readinessError(error, "password-hashing probe")).not.toContain(
      "sensitive SQL",
    );
  });
  it("does not expose driver messages, parameters or unexpected code values", () => {
    const secret = "postgresql://private:secret@example.test/db";
    const output = readinessError(
      {
        code: secret,
        message: secret,
        meta: { query: secret, parameters: [secret] },
      },
      "runtime connection",
    );
    expect(output).not.toContain(secret);
    expect(output).toContain(
      "direct migration connection succeeding does not validate",
    );
  });
  it("reports permission failures without echoing the role or query", () => {
    const output = readinessError(
      {
        cause: {
          originalCode: "42501",
          user: "private-role",
          originalMessage: "private query",
        },
      },
      "password-hashing probe",
    );
    expect(output).toContain("lacks a required permission");
    expect(output).not.toContain("private-role");
    expect(output).not.toContain("private query");
  });
});
