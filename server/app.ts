import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Prisma, StudySet } from "../generated/prisma/client";
import type { Database } from "./db";
import { createAuth, type Config } from "./auth";
import { encodeStorage, decodeStorage } from "./storage";
import {
  parseJSON,
  decodeFile,
  ValidationError,
  MAX_BYTES,
  BACKUP_BYTES,
} from "../shared/json";
import {
  validateContent,
  serializeContent,
  itemsOf,
  type StudyContent,
} from "../shared/content";
import {
  grade,
  practiceSettingsSchema,
  practiceSnapshot,
  retryModeSchema,
  retrySnapshot,
  progressSchema,
  revisionSchema,
  validateProgress,
  validateProgressChanges,
  type Responses,
  type Status,
} from "../shared/attempts";

import {
  SNAPSHOT_VERSION,
  progressContent,
  readProgressContent,
  readAttemptProgress,
  metadataOnly,
} from "./snapshots";
import { safeDiagnostic } from "./diagnostics";
import { readInsights } from "./insights";
import {
  changeReviewLimit,
  lockReviewDeck,
  readReviewQueue,
  recordSpacedReview,
  startSpacedReview,
} from "./spacedReview";
import { MAX_DAILY_REVIEWS } from "../shared/spacedReview";
import { registerBackup } from "./backup";
import { passwordRecoveryEnabled } from "./resetEmail";
import { markStudied } from "./practice";
import {
  LIST_PAGE_SIZE,
  MAX_LIST_PAGE,
  type CourseSummary,
} from "../shared/listing";
import { readHistory } from "./history";

export type Context = {
  Variables: {
    requestId: string;
    started: number;
    db: Database;
    userId: string;
    auth: ReturnType<typeof createAuth>;
  };
};
const json = (value: unknown) => encodeStorage(value) as Prisma.InputJsonValue;
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
const courseSchema = z.string().trim().max(100);
const organizationFields = {
  course: courseSchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
};
function listPage(value?: string) {
  const page = Number(value ?? 0);
  if (!Number.isInteger(page) || page < 0 || page > MAX_LIST_PAGE)
    throw new HTTPException(400, { message: "Invalid page." });
  return page;
}
function archiveFilter(value = "false") {
  if (value !== "true" && value !== "false")
    throw new HTTPException(400, { message: "Invalid archive filter." });
  return value === "true";
}
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
    c.req.path.startsWith("/api/backup/") ? backupLimit(c, next) : standardLimit(c, next),
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
    c.set("auth", createAuth(db, config, c.req.path === "/api/auth/reset-password"));
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
  app.get("/api/insights", async (c) =>
    c.json(await readInsights(c.get("db"), c.get("userId"), c.req.query("setId") ?? null)),
  );
  app.get("/api/sets/:id/review", async (c) =>
    c.json(await readReviewQueue(c.get("db"), c.get("userId"), c.req.param("id"))),
  );
  app.patch("/api/sets/:id/review", async (c) => {
    const { limit } = schema(
      z.strictObject({ limit: z.number().int().min(1).max(MAX_DAILY_REVIEWS) }),
      await read(c.req.raw),
    );
    return c.json(await changeReviewLimit(c.get("db"), c.get("userId"), c.req.param("id"), limit));
  });
  app.post("/api/sets/:id/review", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw));
    const { id, started } = await startSpacedReview(c.get("db"), c.get("userId"), c.req.param("id"));
    return c.json({ id }, started ? 201 : 200);
  });
  registerBackup(app);
  app.get("/api/sets", async (c) => {
    const page = listPage(c.req.query("page"));
    const kind = c.req.query("kind");
    if (kind && kind !== "exam" && kind !== "flashcards")
      throw new HTTPException(400, { message: "Invalid kind." });
    const search = encodeStorage((c.req.query("search") ?? "").slice(0, 200));
    const course = c.req.query("course");
    const storedCourse =
      course === undefined ? null : encodeStorage(schema(courseSchema, course));
    const archived = archiveFilter(c.req.query("archived"));
    const sort = c.req.query("sort") ?? "updated";
    if (!["updated", "studied"].includes(sort))
      throw new HTTPException(400, { message: "Invalid sort order." });
    const db = c.get("db");
    const userId = c.get("userId");
    // Project metadata in PostgreSQL: a page must not load thirty 2-MiB documents.
    const [sets, courses] = await Promise.all([
      db.$queryRaw<(Omit<StudySet, "content"> & { count: number })[]>`
        SELECT s.id, s."userId", s.title, s.kind, s.revision, s."createdAt",
          s."updatedAt", s.course, s.pinned, s.archived, s."lastStudiedAt",
          COALESCE(jsonb_array_length(s.content->'questions'), jsonb_array_length(s.content->'cards')) AS count,
          (SELECT jsonb_build_object(
            'id', a.id, 'status', a.status, 'position', a.position, 'result', a.result, 'kind', a.snapshot->>'kind',
            'total', COALESCE(jsonb_array_length(a.snapshot->'questions'), jsonb_array_length(a.snapshot->'cards')),
            'isOlderVersion', COALESCE(a."studySetRevision" <> s.revision, a."fullSet" AND a.snapshot <> s.content)
          )
          FROM "Attempt" a WHERE a."studySetId" = s.id AND a."userId" = ${userId}
          AND a.status IN ('in_progress', 'reviewing') ORDER BY a."updatedAt" DESC, a.id ASC LIMIT 1) AS continuation
        FROM "StudySet" s WHERE s."userId" = ${userId}
          AND s.archived = ${archived}
          AND (${kind ?? null}::text IS NULL OR s.kind = ${kind ?? null}::text)
          AND (${storedCourse}::text IS NULL OR s.course = ${storedCourse}::text)
          AND strpos(lower(s.title), lower(${search})) > 0
        ORDER BY s.pinned DESC,
          CASE WHEN ${sort} = 'studied' THEN s."lastStudiedAt" END DESC NULLS LAST,
          s."updatedAt" DESC, s.id ASC LIMIT ${LIST_PAGE_SIZE + 1} OFFSET ${page * LIST_PAGE_SIZE}
      `,
      db.$queryRaw<{ course: string }[]>`
        SELECT DISTINCT course FROM "StudySet"
        WHERE "userId" = ${userId} AND course <> '' ORDER BY course
      `,
    ]);
    return c.json(
      decodeStorage({
        items: sets.slice(0, LIST_PAGE_SIZE),
        hasMore: sets.length > LIST_PAGE_SIZE,
        page,
        courses: courses.map(({ course }) => course),
      }),
    );
  });
  app.get("/api/sets/courses", async (c) => {
    const page = listPage(c.req.query("page"));
    const archived = archiveFilter(c.req.query("archived"));
    const rows = await c.get("db").$queryRaw<CourseSummary[]>`
      SELECT course, COUNT(*)::int AS count
      FROM "StudySet" WHERE "userId" = ${c.get("userId")} AND archived = ${archived}
      GROUP BY course ORDER BY (course = ''), lower(course), course
      LIMIT ${LIST_PAGE_SIZE + 1} OFFSET ${page * LIST_PAGE_SIZE}
    `;
    return c.json(
      decodeStorage({
        items: rows.slice(0, LIST_PAGE_SIZE),
        hasMore: rows.length > LIST_PAGE_SIZE,
      }),
    );
  });
  app.patch("/api/sets/organization", async (c) => {
    const { ids, course, pinned, archived } = schema(
      z
        .strictObject({
          ids: z
            .array(z.string().min(1).max(64))
            .min(1)
            .max(LIST_PAGE_SIZE)
            .refine(
              (ids) => new Set(ids).size === ids.length,
              "Select distinct study sets.",
            ),
          ...organizationFields,
        })
        .refine(
          ({ course, pinned, archived }) =>
            course !== undefined ||
            pinned !== undefined ||
            archived !== undefined,
          "Choose a field to update.",
        ),
      await read(c.req.raw),
    );
    const userId = c.get("userId");
    const storedCourse = encodeStorage(course);
    const changed = await c.get("db").$transaction(async (tx) => {
      // Lock in a stable order so an overlapping batch cannot change membership mid-update.
      const owned = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "StudySet" WHERE "userId" = ${userId}
        AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
        ORDER BY id FOR UPDATE
      `;
      if (owned.length !== ids.length) throw unavailable();
      return tx.studySet.updateMany({
        where: {
          userId,
          id: { in: ids },
          OR: [
            ...(storedCourse === undefined
              ? []
              : [{ course: { not: storedCourse } }]),
            ...(pinned === undefined ? [] : [{ pinned: !pinned }]),
            ...(archived === undefined ? [] : [{ archived: !archived }]),
          ],
        },
        data: { course: storedCourse, pinned, archived },
      });
    });
    return c.json({ updated: changed.count });
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
    const storedContent = json(content);
    const set = await db.$transaction(async (tx) => {
      const changed = await tx.studySet.updateMany({
        where: {
          id,
          userId,
          revision: input.revision,
          NOT: { content: { equals: storedContent } },
        },
        data: {
          content: storedContent,
          title: encodeStorage(content.title),
          kind: content.kind,
          revision: { increment: 1 },
        },
      });
      const saved = await tx.studySet.findFirst({ where: { id, userId } });
      if (!saved) throw unavailable();
      if (!changed.count && saved.revision !== input.revision) throw conflict();
      return saved;
    });
    return c.json(decodeStorage(set));
  });
  app.patch("/api/sets/:id/organization", async (c) => {
    const { course, ...flags } = schema(
      z
        .strictObject(organizationFields)
        .refine((fields) => Object.keys(fields).length > 0, "Choose a field to update."),
      await read(c.req.raw),
    );
    const changed = await c.get("db").studySet.updateMany({
      where: { id: c.req.param("id"), userId: c.get("userId") },
      data: { ...flags, course: encodeStorage(course) },
    });
    if (!changed.count) throw unavailable();
    return c.json({ updated: true });
  });
  app.post("/api/sets/:id/duplicate", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw));
    const db = c.get("db");
    const userId = c.get("userId");
    const original = await db.studySet.findFirst({
      where: { id: c.req.param("id"), userId },
    });
    if (!original) throw unavailable();
    const content = validateContent(decodeStorage(original.content));
    const titled = {
      ...content,
      title: [...`Copy of ${content.title}`].slice(0, 200).join(""),
    };
    const copy =
      new TextEncoder().encode(JSON.stringify(titled)).length <= MAX_BYTES
        ? titled
        : content;
    const set = await db.studySet.create({
      data: {
        userId,
        title: encodeStorage(copy.title),
        kind: copy.kind,
        course: original.course,
        content: json(copy),
      },
    });
    return c.json(decodeStorage(set), 201);
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
    const input = schema(
      practiceSettingsSchema.partial(),
      await read(c.req.raw, 4096),
    );
    const db = c.get("db");
    const userId = c.get("userId");
    const attempt = await db.$transaction(async (tx) => {
      const set = await tx.studySet.findFirst({
        where: { id: c.req.param("id"), userId },
      });
      if (!set) throw unavailable();
      const { settings, snapshot, fullSet } = practiceSnapshot(
        validateContent(decodeStorage(set.content)),
        input,
      );
      const startedAt = new Date();
      await markStudied(tx, userId, set.id, startedAt);
      return tx.attempt.create({
        data: {
          snapshotVersion: SNAPSHOT_VERSION,
          progressContent: json(progressContent(snapshot)),
          userId,
          studySetId: set.id,
          studySetRevision: set.revision,
          settings: json(settings),
          fullSet,
          snapshot: json(snapshot),
          startedAt,
        },
      });
    });
    return c.json(decodeStorage(attempt), 201);
  });
  app.get("/api/attempts", async (c) =>
    c.json(
      await readHistory(
        c.get("db"),
        c.get("userId"),
        c.req.query(),
        listPage(c.req.query("page")),
        false,
      ),
    ),
  );
  app.get("/api/attempts/groups", async (c) =>
    c.json(
      await readHistory(
        c.get("db"),
        c.get("userId"),
        c.req.query(),
        listPage(c.req.query("page")),
        true,
      ),
    ),
  );
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
      const current = await readAttemptProgress(tx, where.id, where.userId);
      if (!current) throw unavailable();
      if (current.revision !== input.revision) throw conflict();
      let snapshot: StudyContent;
      if (
        current.snapshotVersion === SNAPSHOT_VERSION &&
        current.progressContent
      )
        snapshot = readProgressContent(decodeStorage(current.progressContent));
      else {
        const legacy = await tx.attempt.findFirstOrThrow({ where });
        snapshot = progressContent(
          validateContent(decodeStorage(legacy.snapshot)),
        );
      }
      const responses =
        "changes" in input
          ? validateProgressChanges(
              snapshot,
              current.status as Status,
              decodeStorage(current.responses) as Responses,
              input.changes,
              input.position,
            )
          : validateProgress(
              snapshot,
              current.status as Status,
              decodeStorage(current.responses) as Responses,
              input.responses,
              input.position,
            );
      const scored =
        current.status === "reviewing" ? grade(snapshot, responses) : undefined;
      const position = current.status === "completed" ? current.position : input.position;
      const now = new Date();
      // Study-set writes precede attempt writes, matching review completion.
      if (current.status !== "completed")
        await markStudied(tx, where.userId, current.studySetId, now);
      const changed = await tx.attempt.updateMany({
        where: { ...where, revision: input.revision, status: current.status },
        data: {
          snapshotVersion: SNAPSHOT_VERSION,
          progressContent: json(snapshot),
          responses: json(responses),
          position,
          revision: { increment: 1 },
          ...(scored
            ? {
                result: json(scored.result),
                status: scored.status,
                completedAt: scored.status === "completed" ? now : null,
              }
            : {}),
        },
      });
      if (!changed.count) throw conflict();
      return "changes" in input
        ? {
            ...metadataOnly(current),
            position,
            revision: current.revision + 1,
            ...(scored
              ? {
                  status: scored.status,
                  result: scored.result,
                  completedAt:
                    scored.status === "completed" ? now : null,
                }
              : {}),
          }
        : tx.attempt.findFirstOrThrow({ where });
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
    const compact = c.req.query("compact") === "1";
    const attempt = await db.$transaction(async (tx) => {
      const current = await readAttemptProgress(tx, where.id, where.userId);
      if (!current) throw unavailable();
      if (current.status !== "in_progress") {
        if (compact && current.revision > input.revision + 1) throw conflict();
        return compact
          ? metadataOnly(current)
          : tx.attempt.findFirstOrThrow({ where });
      }
      if (current.revision !== input.revision) throw conflict();
      const rules =
        current.snapshotVersion === SNAPSHOT_VERSION && current.progressContent
          ? readProgressContent(decodeStorage(current.progressContent))
          : progressContent(
              validateContent(
                decodeStorage((await tx.attempt.findFirstOrThrow({ where })).snapshot),
              ),
            );
      const scored = grade(rules, decodeStorage(current.responses) as Responses);
      const now = new Date();
      if (current.reviewMode && current.studySetId)
        await lockReviewDeck(tx, where.userId, current.studySetId);
      await markStudied(tx, where.userId, current.studySetId, now);
      const changed = await tx.attempt.updateMany({
        where: { ...where, status: "in_progress", revision: input.revision },
        data: {
          result: json(scored.result),
          status: scored.status,
          revision: { increment: 1 },
          completedAt: scored.status === "completed" ? now : null,
        },
      });
      if (changed.count && current.reviewMode && scored.status === "completed")
        await recordSpacedReview(
          tx,
          await tx.attempt.findFirstOrThrow({ where }),
          now,
        );
      const saved = compact
        ? await readAttemptProgress(tx, where.id, where.userId)
        : await tx.attempt.findFirst({ where });
      if (!saved) throw unavailable();
      if (
        !changed.count &&
        (saved.status === "in_progress" || (compact && saved.revision > input.revision + 1))
      ) throw conflict();
      return compact ? metadataOnly(saved) : saved;
    });
    return c.json(decodeStorage(attempt));
  });
  app.post("/api/attempts/:id/retry", async (c) => {
    const input = schema(
      z.strictObject({ mode: retryModeSchema.default("mistakes") }),
      await read(c.req.raw),
    );
    const db = c.get("db");
    const where = { id: c.req.param("id"), userId: c.get("userId") };
    const attempt = await db.$transaction(async (tx) => {
      const source = await tx.attempt.findFirst({ where });
      if (!source) throw unavailable();
      if (source.status !== "completed")
        throw new HTTPException(409, {
          message: "Complete the source attempt before retrying.",
        });
      const snapshot = retrySnapshot(
        validateContent(decodeStorage(source.snapshot)),
        decodeStorage(source.responses) as Responses,
        input.mode,
      );
      if (!snapshot) return null;
      const startedAt = new Date();
      await markStudied(tx, where.userId, source.studySetId, startedAt);
      return tx.attempt.create({
        data: {
          userId: c.get("userId"),
          studySetId: source.studySetId,
          studySetRevision: source.studySetRevision,
          sourceAttemptId: source.id,
          settings: json({
            count: itemsOf(snapshot).length,
            order: "original",
            timerMinutes: null,
          }),
          fullSet: false,
          startedAt,
          snapshot: json(snapshot),
          snapshotVersion: SNAPSHOT_VERSION,
          progressContent: json(progressContent(snapshot)),
        },
      });
    });
    return attempt
      ? c.json(decodeStorage(attempt), 201)
      : c.json(
          {
            error:
              input.mode === "unreviewed"
                ? "No unreviewed cards to study."
                : "No items to review again.",
          },
          422,
        );
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
