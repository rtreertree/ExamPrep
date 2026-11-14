import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
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
import { itemsOf, validateContent } from "../shared/content";
import type { Context } from "./app";
import { readHistory } from "./history";
import { listPage } from "./libraryOrder";
import { markStudied } from "./practice";
import { read, schema } from "./request";
import { conflict, json, unavailable } from "./routeHelpers";
import { readLockedOwnedSet } from "./setAccess";
import {
  SNAPSHOT_VERSION,
  metadataOnly,
  progressContent,
  readAttemptProgress,
  resolveProgressRules,
} from "./snapshots";
import { recordSpacedReview } from "./spacedReview";
import { decodeStorage } from "./storage";

export function registerAttemptRoutes(app: Hono<Context>) {
  app.post("/api/sets/:id/attempts", async (c) => {
    const input = schema(
      practiceSettingsSchema.partial(),
      await read(c.req.raw, 4096),
    );
    const db = c.get("db");
    const userId = c.get("userId");
    const attempt = await db.$transaction(async (tx) => {
      const set = await readLockedOwnedSet(tx, c.req.param("id"), userId);
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
      const { rules: snapshot, needsUpgrade } = await resolveProgressRules(
        current,
        async () => (await tx.attempt.findFirstOrThrow({ where })).snapshot,
      );
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
      const position =
        current.status === "completed" ? current.position : input.position;
      const now = new Date();
      // Study-set writes precede attempt writes, matching review completion.
      const studySetId =
        current.status === "completed" ||
        (await markStudied(tx, where.userId, current.studySetId, now))
          ? current.studySetId
          : null;
      const changed = await tx.attempt.updateMany({
        where: { ...where, revision: input.revision, status: current.status },
        data: {
          ...(needsUpgrade
            ? {
                snapshotVersion: SNAPSHOT_VERSION,
                progressContent: json(snapshot),
              }
            : {}),
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
            studySetId,
            position,
            revision: current.revision + 1,
            ...(scored
              ? {
                  status: scored.status,
                  result: scored.result,
                  completedAt: scored.status === "completed" ? now : null,
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
      const { rules } = await resolveProgressRules(
        current,
        async () => (await tx.attempt.findFirstOrThrow({ where })).snapshot,
      );
      const scored = grade(
        rules,
        decodeStorage(current.responses) as Responses,
      );
      const now = new Date();
      const role = await markStudied(tx, where.userId, current.studySetId, now);
      const changed = await tx.attempt.updateMany({
        where: { ...where, status: "in_progress", revision: input.revision },
        data: {
          result: json(scored.result),
          status: scored.status,
          revision: { increment: 1 },
          completedAt: scored.status === "completed" ? now : null,
        },
      });
      if (
        role &&
        changed.count &&
        current.reviewMode &&
        scored.status === "completed"
      )
        await recordSpacedReview(
          tx,
          await tx.attempt.findFirstOrThrow({ where }),
          now,
          role === "primary",
        );
      const saved = compact
        ? await readAttemptProgress(tx, where.id, where.userId)
        : await tx.attempt.findFirst({ where });
      if (!saved) throw unavailable();
      if (
        !changed.count &&
        (saved.status === "in_progress" ||
          (compact && saved.revision > input.revision + 1))
      )
        throw conflict();
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
      const role = await markStudied(
        tx,
        where.userId,
        source.studySetId,
        startedAt,
      );
      const studySetId = role
        ? (await tx.attempt.findFirstOrThrow({ where })).studySetId
        : null;
      return tx.attempt.create({
        data: {
          userId: c.get("userId"),
          studySetId,
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
}
