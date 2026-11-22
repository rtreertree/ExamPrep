import type { Database } from "./db";

export const testDatabasePath = "/api/_test/database";
export const testDatabaseHeader = "X-ExamPrep-Test-Challenge";
export const testDatabaseProofHeader = "X-ExamPrep-Test-Proof";
export const runtimeDatabaseRole = "examprep_runtime";

export function isLoopbackOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      value === url.origin &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export async function testDatabaseDigest(token: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function matchesTestDatabase(
  db: Pick<Database, "$queryRaw">,
  runtime = false,
) {
  try {
    const [row] = await db.$queryRaw<{ matched: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM examprep_test.target)
        AND (NOT ${runtime} OR current_user = ${runtimeDatabaseRole}) AS matched
    `;
    return row?.matched === true;
  } catch {
    return false;
  }
}
