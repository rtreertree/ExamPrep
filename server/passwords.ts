import { createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { APIError } from "better-auth/api";
import type { Database } from "./db";

export const PASSWORD_PREFIX = "ep-bcrypt-sha384-v1:";
export const PASSWORD_PATTERN =
  /^ep-bcrypt-sha384-v1:\$2a\$12\$[./A-Za-z0-9]{53}$/;
const LEGACY_PATTERN = /^[a-f0-9]{32}:[a-f0-9]{128}$/;
const isCurrentHash = (hash: string) =>
  hash.length === PASSWORD_PREFIX.length + 60 && PASSWORD_PATTERN.test(hash);

// bcrypt receives 64 printable ASCII bytes, so long/Unicode passwords never
// encounter its 72-byte truncation or NUL rules. The pepper stays outside Neon.
export function passwordInput(password: string, pepper: string): string {
  return createHmac("sha384", pepper)
    .update("Exam Prep password v1\0")
    .update(password.normalize("NFKC"))
    .digest("base64");
}

async function legacyMatches(password: string, hash: string): Promise<boolean> {
  const [salt, expected] = hash.split(":");
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      { N: 16384, r: 16, p: 1, maxmem: 67108864 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
  return timingSafeEqual(key, Buffer.from(expected, "hex"));
}

/** Better Auth callbacks shared by both runtimes. Slow work runs in PostgreSQL. */
export function databasePasswords(
  db: Pick<Database, "$queryRaw">,
  pepper: string,
  runtime: "worker" | "node",
) {
  if (pepper.length < 32)
    throw new Error("PASSWORD_PEPPER must contain at least 32 characters.");

  async function hash(password: string): Promise<string> {
    try {
      const input = passwordInput(password, pepper);
      const rows = await db.$queryRaw<{ hash: string }[]>`
        SELECT public.crypt(${input}, public.gen_salt('bf', 12)) AS hash
      `;
      const encoded = PASSWORD_PREFIX + rows[0]?.hash;
      if (!isCurrentHash(encoded)) throw new Error();
      return encoded;
    } catch {
      // Driver exceptions can contain bound inputs. Never forward their details
      // to Better Auth's logger or to an HTTP response.
      throw new APIError("SERVICE_UNAVAILABLE", {
        message:
          "Password processing is unavailable. Check the database migration and server configuration.",
        code: "PASSWORD_PROCESSING_UNAVAILABLE",
      });
    }
  }

  async function verify({
    hash: encoded,
    password,
  }: {
    hash: string;
    password: string;
  }): Promise<boolean> {
    if (isCurrentHash(encoded)) {
      try {
        const input = passwordInput(password, pepper);
        const stored = encoded.slice(PASSWORD_PREFIX.length);
        const rows = await db.$queryRaw<{ valid: boolean }[]>`
          SELECT public.crypt(${input}, ${stored}) = ${stored} AS valid
        `;
        return rows[0]?.valid === true;
      } catch {
        throw new APIError("SERVICE_UNAVAILABLE", {
          message:
            "Password processing is unavailable. Check the database migration and server configuration.",
          code: "PASSWORD_PROCESSING_UNAVAILABLE",
        });
      }
    }
    if (encoded.length !== 161 || !LEGACY_PATTERN.test(encoded)) return false;
    if (runtime === "worker") {
      // Do not run a CPU-heavy fallback on the free Worker. The deployment
      // readiness check rejects remaining legacy credentials before publishing.
      throw new APIError("SERVICE_UNAVAILABLE", {
        message:
          "This account needs one successful sign-in on the local Node application before Cloudflare deployment.",
        code: "PASSWORD_MIGRATION_REQUIRED",
      });
    }
    if (!(await legacyMatches(password, encoded))) return false;
    const replacement = await hash(password);
    try {
      // Compare-and-set prevents an upgrade from overwriting a concurrent
      // password change. IDs, sessions, sets, and attempts are untouched.
      const updated = await db.$queryRaw<{ id: string }[]>`
        UPDATE account SET password = ${replacement}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "providerId" = 'credential' AND password = ${encoded} RETURNING id
      `;
      return updated.length > 0;
    } catch {
      throw new APIError("SERVICE_UNAVAILABLE", {
        message: "Password migration could not be saved. Try signing in again.",
        code: "PASSWORD_MIGRATION_UNAVAILABLE",
      });
    }
  }
  return { hash, verify };
}
