import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Prisma, StudySet, Attempt } from "../generated/prisma/client";
import type { Database } from "./db";
import { createAuth, type Config } from "./auth";
import { encodeStorage, decodeStorage } from "./storage";
import {
  parseJSON,
  decodeFile,
  ValidationError,
  MAX_BYTES,
} from "../shared/json";
import {
  validateContent,
  serializeContent,
  type StudyContent,
} from "../shared/content";
import {
  grade,
  mistakes,
  progressSchema,
  revisionSchema,
  validateProgress,
  type Responses,
  type Status,
} from "../shared/attempts";

type Context = {
  Variables: {
    db: Database;
    userId: string;
    auth: ReturnType<typeof createAuth>;
  };
};
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(encodeStorage(value))) as Prisma.InputJsonValue;
const schema = <T>(s: z.ZodType<T>, value: unknown): T => {
  const p = s.safeParse(value);
  if (!p.success)
    throw new ValidationError(
      p.error.issues.map((i) => ({
        path: "/" + i.path.join("/"),
        message: i.message,
      })),
    );
  return p.data;
};
async function read(request: Request, max = MAX_BYTES + 1024) {
  return parseJSON(decodeFile(await request.arrayBuffer(), max), max);
}
const unavailable = () =>
  new HTTPException(404, {
    message: "This item is unavailable or belongs to another account.",
  });
const conflict = () =>
  new HTTPException(409, {
    message:
      "A newer revision was saved on another device. Your changes have been kept here.",
  });
export function createApp(
  config: Config,
  connectDatabase: (url: string) => Database,
) {
  const app = new Hono<Context>();
  app.use("*", async (c, next) => {
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
  app.get("/api/health", (c) =>
    c.json({ status: "ok", runtime: config.RUNTIME ?? "node" }),
  );
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 8 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large." }, 413),
    }),
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
    c.set("auth", createAuth(db, config));
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
  app.get("/api/sets", async (c) => {
    const page = Math.max(0, Number(c.req.query("page") ?? 0));
    if (!Number.isInteger(page))
      throw new HTTPException(400, { message: "Invalid page." });
    const kind = c.req.query("kind");
    if (kind && kind !== "exam" && kind !== "flashcards")
      throw new HTTPException(400, { message: "Invalid kind." });
    // Project metadata in PostgreSQL: a page must not load thirty 2-MiB documents.
    const sets = await c.get("db").$queryRaw<
      (Omit<StudySet, "content"> & { count: number })[]
    >`
      SELECT id, "userId", title, kind, revision, "createdAt", "updatedAt",
        COALESCE(jsonb_array_length(content->'questions'), jsonb_array_length(content->'cards')) AS count
      FROM "StudySet" WHERE "userId" = ${c.get("userId")}
        AND (${kind ?? null}::text IS NULL OR kind = ${kind ?? null}::text)
      ORDER BY "updatedAt" DESC, id ASC LIMIT 31 OFFSET ${page * 30}
    `;
    return c.json(
      decodeStorage({ items: sets.slice(0, 30), hasMore: sets.length > 30 }),
    );
  });
  app.post("/api/sets", async (c) => {
    const content = validateContent(await read(c.req.raw, MAX_BYTES));
    const set = await c.get("db").studySet.create({
      data: {
        userId: c.get("userId"),
        title: encodeStorage(content.title),
        kind: content.kind,
        content: json(content),
      },
    });
    return c.json(decodeStorage(set), 201);
  });
  app.get("/api/sets/:id", async (c) => {
    const set = await c.get("db").studySet.findFirst({
      where: { id: c.req.param("id"), userId: c.get("userId") },
    });
    if (!set) throw unavailable();
    return c.json(decodeStorage(set));
  });
  app.put("/api/sets/:id", async (c) => {
    const input = schema(
      z.strictObject({ revision: revisionSchema, content: z.unknown() }),
      await read(c.req.raw),
    );
    const content = validateContent(input.content);
    const db = c.get("db");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const set = await db.$transaction(async (tx) => {
      const changed = await tx.studySet.updateMany({
        where: { id, userId, revision: input.revision },
        data: {
          content: json(content),
          title: encodeStorage(content.title),
          kind: content.kind,
          revision: { increment: 1 },
        },
      });
      if (!changed.count) {
        if (!(await tx.studySet.findFirst({ where: { id, userId } })))
          throw unavailable();
        throw conflict();
      }
      return tx.studySet.findFirstOrThrow({ where: { id, userId } });
    });
    return c.json(decodeStorage(set));
  });
  app.delete("/api/sets/:id", async (c) => {
    const input = schema(
      z.strictObject({ revision: revisionSchema }),
      await read(c.req.raw),
    );
    const db = c.get("db");
    const where = { id: c.req.param("id"), userId: c.get("userId") };
    const deleted = await db.studySet.deleteMany({
      where: { ...where, revision: input.revision },
    });
    if (!deleted.count) {
      if (!(await db.studySet.findFirst({ where }))) throw unavailable();
      throw conflict();
    }
    return c.json({ deleted: true });
  });
  app.get("/api/sets/:id/export", async (c) => {
    const set = await c.get("db").studySet.findFirst({
      where: { id: c.req.param("id"), userId: c.get("userId") },
    });
    if (!set) throw unavailable();
    const content = validateContent(decodeStorage(set.content));
    c.header(
      "Content-Disposition",
      `attachment; filename="study-set.examprep.json"`,
    );
    return c.body(serializeContent(content), 200, {
      "Content-Type": "application/json; charset=utf-8",
    });
  });
  app.post("/api/sets/:id/attempts", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw));
    const db = c.get("db");
    const userId = c.get("userId");
    const attempt = await db.$transaction(async (tx) => {
      const set = await tx.studySet.findFirst({
        where: { id: c.req.param("id"), userId },
      });
      if (!set) throw unavailable();
      return tx.attempt.create({
        data: {
          userId,
          studySetId: set.id,
          snapshot: json(validateContent(decodeStorage(set.content))),
        },
      });
    });
    return c.json(decodeStorage(attempt), 201);
  });
  app.get("/api/attempts", async (c) => {
    const page = Number(c.req.query("page") ?? 0);
    if (!Number.isInteger(page) || page < 0)
      throw new HTTPException(400, { message: "Invalid page." });
    const attempts = await c.get("db").$queryRaw<
      (Omit<Attempt, "snapshot" | "responses"> & {
        title: string;
        kind: string;
      })[]
    >`
      SELECT id, "userId", "studySetId", "sourceAttemptId", status, position, result,
        revision, "startedAt", "updatedAt", "completedAt", snapshot->>'title' AS title,
        snapshot->>'kind' AS kind
      FROM "Attempt" WHERE "userId" = ${c.get("userId")}
      ORDER BY "startedAt" DESC, id ASC LIMIT 31 OFFSET ${page * 30}
    `;
    return c.json(
      decodeStorage({
        items: attempts.slice(0, 30),
        hasMore: attempts.length > 30,
      }),
    );
  });
  app.get("/api/attempts/:id", async (c) => {
    const attempt = await c.get("db").attempt.findFirst({
      where: { id: c.req.param("id"), userId: c.get("userId") },
    });
    if (!attempt) throw unavailable();
    return c.json(decodeStorage(attempt));
  });
  app.patch("/api/attempts/:id/progress", async (c) => {
    const input = schema(
      progressSchema,
      await read(c.req.raw, 8 * 1024 * 1024),
    );
    const db = c.get("db");
    const where = { id: c.req.param("id"), userId: c.get("userId") };
    const attempt = await db.$transaction(async (tx) => {
      const current = await tx.attempt.findFirst({ where });
      if (!current) throw unavailable();
      if (current.revision !== input.revision) throw conflict();
      const snapshot = validateContent(decodeStorage(current.snapshot));
      const responses = validateProgress(
        snapshot,
        current.status as Status,
        decodeStorage(current.responses) as Responses,
        input.responses,
        input.position,
      );
      const scored =
        current.status === "reviewing" ? grade(snapshot, responses) : undefined;
      const changed = await tx.attempt.updateMany({
        where: { ...where, revision: input.revision, status: current.status },
        data: {
          responses: json(responses),
          position: input.position,
          revision: { increment: 1 },
          ...(scored
            ? {
                result: json(scored.result),
                status: scored.status,
                completedAt: scored.status === "completed" ? new Date() : null,
              }
            : {}),
        },
      });
      if (!changed.count) throw conflict();
      return tx.attempt.findFirstOrThrow({ where });
    });
    return c.json(decodeStorage(attempt));
  });
  app.post("/api/attempts/:id/submit", async (c) => {
    const input = schema(
      z.strictObject({ revision: revisionSchema }),
      await read(c.req.raw),
    );
    const db = c.get("db");
    const where = { id: c.req.param("id"), userId: c.get("userId") };
    const current = await db.attempt.findFirst({ where });
    if (!current) throw unavailable();
    if (current.status !== "in_progress") return c.json(decodeStorage(current));
    if (current.revision !== input.revision) throw conflict();
    const scored = grade(
      validateContent(decodeStorage(current.snapshot)),
      decodeStorage(current.responses) as Responses,
    );
    const changed = await db.attempt.updateMany({
      where: { ...where, status: "in_progress", revision: input.revision },
      data: {
        result: json(scored.result),
        status: scored.status,
        revision: { increment: 1 },
        completedAt: scored.status === "completed" ? new Date() : null,
      },
    });
    const saved = await db.attempt.findFirst({ where });
    if (!saved) throw unavailable();
    if (!changed.count && saved.status === "in_progress") throw conflict();
    return c.json(decodeStorage(saved));
  });
  app.post("/api/attempts/:id/retry", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw));
    const db = c.get("db");
    const where = { id: c.req.param("id"), userId: c.get("userId") };
    const attempt = await db.$transaction(async (tx) => {
      const source = await tx.attempt.findFirst({ where });
      if (!source) throw unavailable();
      if (source.status !== "completed")
        throw new HTTPException(409, {
          message: "Complete the source attempt before retrying.",
        });
      const snapshot = mistakes(
        validateContent(decodeStorage(source.snapshot)),
        decodeStorage(source.responses) as Responses,
      );
      if (!snapshot) return null;
      return tx.attempt.create({
        data: {
          userId: c.get("userId"),
          studySetId: source.studySetId,
          sourceAttemptId: source.id,
          snapshot: json(snapshot),
        },
      });
    });
    return attempt
      ? c.json(decodeStorage(attempt), 201)
      : c.json({ error: "No mistakes to retry." }, 422);
  });
  app.notFound((c) => c.json({ error: "API route not found." }, 404));
  app.onError((error, c) => {
    if (error instanceof ValidationError)
      return c.json(
        { error: "Validation failed.", issues: error.issues },
        error.status as 413 | 422,
      );
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    // Do not log driver errors: they may include connection strings or study content.
    return c.json(
      {
        error:
          "The server could not complete this request. Your unsaved changes are still on this device.",
      },
      500,
    );
  });
  return app;
}
