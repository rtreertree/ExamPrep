export function databaseConnection(value, pooled) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Set valid Neon database connection URLs.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname.endsWith(".neon.tech") ||
    !url.username ||
    !url.password ||
    !["require", "verify-ca", "verify-full"].includes(
      url.searchParams.get("sslmode"),
    ) ||
    url.hostname.includes("-pooler.") !== pooled
  ) {
    throw new Error(
      pooled
        ? "DATABASE_URL must be a pooled Neon connection with TLS enabled."
        : "DATABASE_URL_UNPOOLED must be a direct Neon connection with TLS enabled.",
    );
  }
  return url;
}

export function checkConnections(env) {
  const runtime = databaseConnection(env.DATABASE_URL, true);
  const migration = databaseConnection(env.DATABASE_URL_UNPOOLED, false);
  if (
    runtime.hostname.replace("-pooler.", ".") !== migration.hostname ||
    runtime.pathname !== migration.pathname
  )
    throw new Error(
      "Runtime and migration URLs must target the same Neon endpoint and database.",
    );
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
