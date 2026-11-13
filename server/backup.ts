import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CardReview } from "../generated/prisma/client";
import { backupSummary, validateBackup } from "../shared/backup";
import { itemsOf, type StudyContent } from "../shared/content";
import { practiceSettingsSchema } from "../shared/attempts";
import { BACKUP_BYTES, decodeFile, parseJSON } from "../shared/json";
import type { Context } from "./app";
import type { Database } from "./db";
import {
  joinCoOwner,
  ownedSetIds,
  ownerPreferences,
  ownershipRole,
} from "./setAccess";
import { progressContent, SNAPSHOT_VERSION } from "./snapshots";
import { decodeStorage, encodeStorage } from "./storage";

async function exportBackup(
  db: Database,
  userId: string,
  includeHistory: boolean,
) {
  // A single PostgreSQL statement sees a consistent view of sets and attempts.
  // Guard the data size before transferring a full account to the application.
  const [rows] = await db.$queryRaw<
    {
      tooLarge: boolean;
      sets:
        | {
            id: string;
            content: StudyContent;
            revision: number;
            course: string;
            pinned: boolean;
            archived: boolean;
            reviewLimit: number;
            lastStudiedAt: string | null;
            createdAt: string;
            updatedAt: string;
          }[]
        | null;
      attempts:
        | {
            id: string;
            studySetId: string | null;
            studySetRevision: number | null;
            sourceAttemptId: string | null;
            snapshot: StudyContent;
            settings: unknown;
            reviewMode: boolean;
            fullSet: boolean;
            responses: unknown;
            result: unknown;
            status: string;
            position: number;
            startedAt: string;
            updatedAt: string;
            completedAt: string | null;
          }[]
        | null;
      reviews: CardReview[] | null;
    }[]
  >(sql`
    WITH accessible_sets AS (
      SELECT s.id, s.content, s.revision, s."createdAt", s."updatedAt",
        ${ownerPreferences}, ${ownershipRole}
      FROM "StudySet" s ${joinCoOwner(userId)} WHERE s.id IN ${ownedSetIds(userId)}
    ), sets AS (
      SELECT id, content, revision, course, pinned, archived, "reviewLimit",
        "lastStudiedAt", "createdAt", "updatedAt" FROM accessible_sets
    ), attempts AS (
      SELECT id, "studySetId", "studySetRevision", "sourceAttemptId", snapshot,
        settings, "reviewMode", "fullSet", responses, result, status, position,
        "startedAt", "updatedAt", "completedAt" FROM "Attempt"
      WHERE ${includeHistory} AND "userId" = ${userId}
    ), reviews AS (
      SELECT r.* FROM "CardReview" r JOIN accessible_sets s ON s.id = r."studySetId"
      WHERE ${includeHistory} AND s.content->>'kind' = 'flashcards' AND s."ownershipRole" = 'primary'
      UNION ALL
      SELECT r."studySetId", r."cardId", r.fingerprint, r.streak, r."dueAt", r."attemptStartedAt"
      FROM "CoOwnerCardReview" r JOIN accessible_sets s ON s.id = r."studySetId"
      WHERE ${includeHistory} AND s.content->>'kind' = 'flashcards' AND r."userId" = ${userId}
        AND s."ownershipRole" = 'co_owner'
    ), size AS (
      SELECT (
        COALESCE((SELECT sum(pg_column_size(s)) FROM sets s), 0) +
        COALESCE((SELECT sum(pg_column_size(a)) FROM attempts a), 0) +
        COALESCE((SELECT sum(pg_column_size(r)) FROM reviews r), 0)
      ) > ${BACKUP_BYTES} AS "tooLarge"
    )
    SELECT "tooLarge",
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(s ORDER BY id) FROM sets s) END AS sets,
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(a ORDER BY id) FROM attempts a) END AS attempts,
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(r ORDER BY "studySetId", "cardId") FROM reviews r) END AS reviews
    FROM size`);
  if (rows.tooLarge)
    throw new HTTPException(413, {
      message:
        "This backup exceeds 16 MiB. Try exporting the library without practice history.",
    });

  const archive = { schemaVersion: 1 as const, backupId: crypto.randomUUID() };
  const sets = (rows.sets ?? []).map((row) => ({
    ...decodeStorage(row),
    createdAt: utc(row.createdAt),
    updatedAt: utc(row.updatedAt),
    lastStudiedAt: row.lastStudiedAt && utc(row.lastStudiedAt),
  }));
  const attempts = (rows.attempts ?? []).map((stored) => {
    const row = decodeStorage(stored);
    const parsed = practiceSettingsSchema.safeParse(row.settings);
    return {
      ...row,
      startedAt: utc(row.startedAt),
      updatedAt: utc(row.updatedAt),
      completedAt: row.completedAt && utc(row.completedAt),
      settings: parsed.success
        ? parsed.data
        : {
            count: itemsOf(row.snapshot).length,
            order: "original",
            timerMinutes: null,
          },
    };
  });
  const reviews = (rows.reviews ?? []).map((row) => ({
    ...row,
    dueAt: utc(row.dueAt),
    attemptStartedAt: utc(row.attemptStartedAt),
  }));
  const backup = {
    library: { ...archive, kind: "exam-prep-library", sets },
    ...(includeHistory
      ? {
          history: { ...archive, kind: "exam-prep-history", attempts, reviews },
        }
      : {}),
  };
  const serialized = JSON.stringify(backup);
  if (new TextEncoder().encode(serialized).byteLength > BACKUP_BYTES)
    throw new HTTPException(413, {
      message:
        "This backup exceeds 16 MiB. Try exporting the library without practice history.",
    });
  return serialized;
}

// Prisma's PostgreSQL timestamp columns are stored without a timezone, in UTC.
const utc = (value: string | Date) =>
  (value instanceof Date ? value : new Date(value + "Z")).toISOString();

async function restoreBackup(
  db: Database,
  userId: string,
  backup: ReturnType<typeof validateBackup>,
) {
  // File-local IDs are remapped for this account. Repeating a restore of the
  // same file skips copies already present, even if the first reply was lost.
  const prefix = JSON.stringify([userId, backup.backupId]);
  const remap = async (kind: string, id: string) => {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(prefix + kind + id),
    );
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  const [setIds, attemptIds] = await Promise.all([
    Promise.all(
      backup.sets.map(async ({ id }) => [id, await remap("set", id)] as const),
    ),
    Promise.all(
      backup.attempts.map(
        async ({ id }) => [id, await remap("attempt", id)] as const,
      ),
    ),
  ]).then(([sets, attempts]) => [new Map(sets), new Map(attempts)] as const);

  const sets = JSON.stringify(
    encodeStorage(
      backup.sets.map((set) => ({
        ...set,
        id: setIds.get(set.id),
        title: set.content.title,
        kind: set.content.kind,
      })),
    ),
  );
  const attempts = JSON.stringify(
    encodeStorage(
      backup.attempts.map((attempt, restoreOrder) => ({
        ...attempt,
        id: attemptIds.get(attempt.id),
        studySetId: attempt.studySetId ? setIds.get(attempt.studySetId) : null,
        sourceAttemptId: attempt.sourceAttemptId
          ? attemptIds.get(attempt.sourceAttemptId)
          : null,
        snapshotVersion: SNAPSHOT_VERSION,
        progressContent: progressContent(attempt.snapshot),
        restoreOrder,
      })),
    ),
  );
  const reviews = JSON.stringify(
    backup.reviews.map((review) => ({
      ...review,
      studySetId: setIds.get(review.studySetId),
    })),
  );

  return db.$transaction(async (tx) => {
    const restoredSets = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "StudySet" (id, "userId", title, kind, content, revision, course, pinned,
        archived, "reviewLimit", "lastStudiedAt", "createdAt", "updatedAt")
      SELECT id, ${userId}, title, kind, content, revision, course, pinned, archived,
        "reviewLimit", "lastStudiedAt", "createdAt", "updatedAt"
      FROM jsonb_to_recordset(${sets}::jsonb) AS s(
        id text, title text, kind text, content jsonb, revision int, course text, pinned bool,
        archived bool, "reviewLimit" int, "lastStudiedAt" timestamp, "createdAt" timestamp, "updatedAt" timestamp)
      ORDER BY id
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    const restoredAttempts = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Attempt" (id, "userId", "studySetId", "studySetRevision", "sourceAttemptId",
        "snapshotVersion", "progressContent", snapshot, settings, "reviewMode", "fullSet", responses,
        result, status, position, "startedAt", "updatedAt", "completedAt")
      SELECT id, ${userId}, "studySetId", "studySetRevision", "sourceAttemptId",
        "snapshotVersion", "progressContent", snapshot, settings, "reviewMode", "fullSet", responses,
        result, status, position, "startedAt", "updatedAt", "completedAt"
      FROM jsonb_to_recordset(${attempts}::jsonb) AS a(
        id text, "studySetId" text, "studySetRevision" int, "sourceAttemptId" text,
        "snapshotVersion" int, "progressContent" jsonb, snapshot jsonb, settings jsonb,
        "reviewMode" bool, "fullSet" bool, responses jsonb, result jsonb, status text,
        position int, "startedAt" timestamp, "updatedAt" timestamp, "completedAt" timestamp, "restoreOrder" int)
      ORDER BY "restoreOrder"
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    const restoredReviews = await tx.$queryRaw<{ cardId: string }[]>`
      INSERT INTO "CardReview" ("studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt")
      SELECT "studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt"
      FROM jsonb_to_recordset(${reviews}::jsonb) AS r(
        "studySetId" text, "cardId" text, fingerprint text, streak int, "dueAt" timestamp, "attemptStartedAt" timestamp)
      ORDER BY "studySetId", "cardId"
      ON CONFLICT ("studySetId", "cardId") DO NOTHING RETURNING "cardId"`;
    return {
      setCount: restoredSets.length,
      attemptCount: restoredAttempts.length,
      reviewCount: restoredReviews.length,
    };
  });
}

export function registerBackup(app: Hono<Context>) {
  app.get("/api/backup", async (c) =>
    c.body(
      await exportBackup(
        c.get("db"),
        c.get("userId"),
        c.req.query("history") === "1",
      ),
      200,
      { "Content-Type": "application/json; charset=utf-8" },
    ),
  );
  app.post("/api/backup/preview", async (c) =>
    c.json(backupSummary(await readBackup(c.req.raw))),
  );
  app.post("/api/backup/restore", async (c) => {
    const backup = await readBackup(c.req.raw);
    return c.json(
      await restoreBackup(c.get("db"), c.get("userId"), backup),
      201,
    );
  });
}

async function readBackup(request: Request) {
  return validateBackup(
    parseJSON(
      decodeFile(await request.arrayBuffer(), BACKUP_BYTES),
      BACKUP_BYTES,
    ),
  );
}
