const reasons: Record<string, string> = {
  "28P01":
    "The runtime database password is rejected. Update production DATABASE_URL with the current pooled connection credentials.",
  P1000:
    "The runtime database password is rejected. Update production DATABASE_URL with the current pooled connection credentials.",
  "28000":
    "The runtime database role cannot access the database. Check production DATABASE_URL and the role's access.",
  "42501":
    "The runtime database role lacks a required permission. Check access to the application tables and pgcrypto functions.",
  "42P01":
    "A required application table is missing. If tables were removed while migration history was retained, migrate deploy will not recreate already-recorded migrations. Restore the reviewed schema or use a fresh database; do not reset production data.",
  "42703":
    "A required application column is missing. Check schema drift and the reviewed migration history.",
  "42883":
    "A required password-hashing function is missing. Check that pgcrypto is installed in public as defined by the password-hashing migration.",
  "3D000":
    "The runtime database does not exist. Update production DATABASE_URL to the intended database.",
  "53300":
    "The runtime database has too many connections. Check Neon connection limits and use the pooled runtime URL.",
  P1001:
    "The runtime database cannot be reached. Check the pooled hostname, Neon availability and network access.",
  P1002:
    "The runtime database connection timed out. Check Neon availability and network access.",
  P1017:
    "The runtime database connection was closed. Check Neon availability and retry the deployment.",
};

/** Read only known error-code fields; never echo messages, URLs, SQL or parameters. */
export function readinessError(error: unknown, stage: string): string {
  const codes = new Set<string>();
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== "object" || depth > 5) return;
    const object = value as Record<string, unknown>;
    for (const field of ["code", "originalCode"])
      if (
        typeof object[field] === "string" &&
        Object.hasOwn(reasons, object[field])
      )
        codes.add(object[field]);
    for (const field of ["meta", "cause", "driverAdapterError"])
      visit(object[field], depth + 1);
  }
  visit(error, 0);
  const code = [...codes][0];
  return `Database readiness failed during ${stage}. ${code ? `[${code}] ${reasons[code]}` : "Check the pooled DATABASE_URL credentials, runtime role permissions, Neon availability and required schema/functions. The direct migration connection succeeding does not validate the pooled runtime connection."} Driver details are hidden.`;
}
