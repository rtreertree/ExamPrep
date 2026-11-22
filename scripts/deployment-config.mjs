export function databaseConnection(
  value,
  pooled,
  name = pooled ? "DATABASE_URL" : "DATABASE_URL_UNPOOLED",
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${name} must contain only a Neon PostgreSQL connection URL.`,
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2 ||
    [...url.searchParams.keys()].some((key) =>
      [
        "host",
        "hostaddr",
        "port",
        "user",
        "username",
        "database",
        "dbname",
        "password",
        "ssl",
      ].includes(key.toLowerCase()),
    )
  )
    throw new Error(
      `${name} must use a Neon hostname, database, username and password with no query overrides for connection settings or TLS.`,
    );
  if (url.hostname.includes("-pooler.") !== pooled)
    throw new Error(
      pooled
        ? `${name} must use the pooled Neon hostname containing -pooler.`
        : `${name} must use the direct Neon hostname without -pooler.`,
    );
  if (
    url.searchParams.getAll("sslmode").length !== 1 ||
    !["require", "verify-ca", "verify-full"].includes(
      url.searchParams.get("sslmode"),
    )
  )
    throw new Error(
      `${name} needs one TLS sslmode of require, verify-ca, or verify-full.`,
    );
  return url;
}

export function checkConnections(env, names = {}) {
  const runtime = databaseConnection(env.DATABASE_URL, true, names.runtime);
  const migration = databaseConnection(
    env.DATABASE_URL_UNPOOLED,
    false,
    names.migration,
  );
  if (
    runtime.hostname.replace("-pooler.", ".") !== migration.hostname ||
    (runtime.port || "5432") !== (migration.port || "5432") ||
    runtime.pathname !== migration.pathname
  )
    throw new Error(
      "Runtime and migration URLs must target the same Neon endpoint and database.",
    );
  return { runtime, migration };
}

export function productionConfig(env) {
  checkConnections(env);
  for (const name of ["BETTER_AUTH_SECRET", "PASSWORD_PEPPER"])
    if ((env[name]?.length ?? 0) < 32)
      throw new Error(
        `Set ${name} to a separate random secret of at least 32 characters.`,
      );
  if (env.BETTER_AUTH_SECRET === env.PASSWORD_PEPPER)
    throw new Error("Use different authentication and pepper secrets.");
  if (env.BETTER_AUTH_URL !== "https://exam.phonet.app")
    throw new Error(
      "Production BETTER_AUTH_URL must be https://exam.phonet.app.",
    );
  if (
    !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
    !env.CLOUDFLARE_API_TOKEN
  )
    throw new Error(
      "Set production CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
    );
}
