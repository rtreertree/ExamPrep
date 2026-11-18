import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { ValidationError, BACKUP_BYTES } from "../shared/json";
import { registerAttemptRoutes } from "./attemptRoutes";
import { createAuth, type Config } from "./auth";
import { registerBackup } from "./backup";
import type { Database } from "./db";
import { safeDiagnostic } from "./diagnostics";
import { registerFolders } from "./libraryOrder";
import { passwordRecoveryEnabled } from "./resetEmail";
import { registerReviewRoutes } from "./reviewRoutes";
import { registerSetRoutes } from "./setRoutes";
import { registerSharing } from "./sharing";
import { readStudySuggestion } from "./studySuggestion";

export type Context = {
  Variables: {
    requestId: string;
    started: number;
    db: Database;
    userId: string;
    auth: ReturnType<typeof createAuth>;
  };
};

export function createApp(
  config: Config,
  connectDatabase: (url: string) => Database,
) {
  const app = new Hono<Context>();
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.set("started", performance.now());
    c.header("X-Request-ID", c.get("requestId"));
    c.header("Cache-Control", "no-store, private");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (config.BETTER_AUTH_URL?.startsWith("https:"))
      c.header("Strict-Transport-Security", "max-age=31536000");
    await next();
  });
  app.all("/api", (c) => c.json({ error: "API route not found." }, 404));
  app.get("/api/health", (c) =>
    c.json({ status: "ok", runtime: config.RUNTIME ?? "node" }),
  );
  app.get("/api/account/recovery", (c) =>
    c.json({ enabled: passwordRecoveryEnabled(config) }),
  );
  const standardLimit = bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request is too large." }, 413),
  });
  const backupLimit = bodyLimit({
    maxSize: BACKUP_BYTES,
    onError: (c) => c.json({ error: "This backup exceeds 16 MiB." }, 413),
  });
  app.use("/api/*", (c, next) =>
    c.req.path.startsWith("/api/backup/")
      ? backupLimit(c, next)
      : standardLimit(c, next),
  );
  app.use("/api/*", async (c, next) => {
    if (
      !config.DATABASE_URL ||
      !config.BETTER_AUTH_SECRET ||
      !config.PASSWORD_PEPPER ||
      config.PASSWORD_PEPPER.length < 32 ||
      !config.BETTER_AUTH_URL
    )
      return c.json(
        {
          error:
            "Server configuration is incomplete. Set DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, and PASSWORD_PEPPER (at least 32 characters).",
        },
        503,
      );
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      if (c.req.header("Origin") !== new URL(config.BETTER_AUTH_URL).origin)
        throw new HTTPException(403, {
          message: "Request origin is not allowed.",
        });
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        throw new HTTPException(415, { message: "Use application/json." });
    }
    const db = connectDatabase(config.DATABASE_URL);
    c.set("db", db);
    c.set(
      "auth",
      createAuth(db, config, c.req.path === "/api/auth/reset-password"),
    );
    try {
      await next();
    } finally {
      await db.$disconnect();
    }
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) =>
    c.get("auth").handler(c.req.raw),
  );
  app.use("/api/*", async (c, next) => {
    const session = await c
      .get("auth")
      .api.getSession({ headers: c.req.raw.headers });
    if (!session)
      throw new HTTPException(401, {
        message: "Your session has expired. Sign in again to continue.",
      });
    c.set("userId", session.user.id);
    await next();
  });
  app.get("/api/ready", async (c) => {
    await c.get("db").$queryRaw`SELECT 1`;
    return c.json({ status: "ready" });
  });
  app.get("/api/study/next", async (c) =>
    c.json(await readStudySuggestion(c.get("db"), c.get("userId"))),
  );
  registerReviewRoutes(app);
  registerBackup(app);
  registerSharing(app, config.BETTER_AUTH_SECRET);
  registerFolders(app);
  registerSetRoutes(app);
  registerAttemptRoutes(app);
  app.notFound((c) => c.json({ error: "API route not found." }, 404));
  app.onError((error, c) => {
    if (error instanceof ValidationError)
      return c.json(
        { error: "Validation failed.", issues: error.issues },
        error.status as 413 | 422,
      );
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    const reference = c.get("requestId");
    console.error(
      JSON.stringify(
        safeDiagnostic(error, {
          requestId: reference,
          route: c.req.routePath,
          runtime: config.RUNTIME ?? "node",
          durationMs: Math.round(performance.now() - c.get("started")),
        }),
      ),
    );
    return c.json(
      {
        error:
          "The server could not complete this request. Keep this page open and retry.",
        reference,
      },
      500,
    );
  });
  return app;
}
