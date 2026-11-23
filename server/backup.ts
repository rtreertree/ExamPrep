import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CardReview } from "../generated/prisma/client";
import {
  backupSummary,
  validateBackup,
  type BackupPreview,
  type BackupRestoreResult,
} from "../shared/backup";
import { itemsOf, type StudyContent } from "../shared/content";
import { practiceSettingsSchema } from "../shared/attempts";
import { BACKUP_BYTES, decodeFile, parseJSON } from "../shared/json";
import type { Context } from "./app";
import type { Database } from "./db";
import {
  joinEntry,
  joinEntryFolder,
  entryPreferences,
} from "./setAccess";
import { progressContent, SNAPSHOT_VERSION } from "./snapshots";
import { decodeStorage, encodeStorage } from "./storage";
import { lockLibrary } from "./libraryOrder";
import type { LibraryFolder } from "../shared/listing";
import { planBackupReviews, restoreBackupReviews } from "./backup-reviews";
import {
  backupSetCounts,
  planBackupSets,
  restoreBackupSets,
  reviewSetIds,
} from "./backup-sets";

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
      folders: LibraryFolder[] | null;
      sets:
        | {
            id: string;
            content: StudyContent;
            revision: number;
            course: string;
            folderId: string | null;
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
      reviews: Omit<CardReview, "userId">[] | null;
      viewerReviews: Omit<CardReview, "userId">[] | null;
    }[]
  >(sql`
    WITH accessible_sets AS (
      SELECT s.id, s.content, s.revision, s."createdAt", s."updatedAt",
        ${entryPreferences}, e."manualRank" AS "manualRank"
      FROM "StudySet" s ${joinEntry(userId)} ${joinEntryFolder} WHERE (e."userId" = s."userId" OR e."coOwner")
    ), folders AS (
      SELECT id, name, "manualRank" FROM "LibraryFolder" WHERE "userId" = ${userId}
    ), sets AS (
      SELECT id, content, revision, course, "folderId", pinned, archived, "reviewLimit",
        "lastStudiedAt", "createdAt", "updatedAt", "manualRank" FROM accessible_sets
    ), attempts AS (
      SELECT id, CASE WHEN "studySetId" IN (SELECT id FROM accessible_sets) THEN "studySetId" END AS "studySetId", "studySetRevision", "sourceAttemptId", snapshot,
        settings, "reviewMode", "fullSet", responses, result, status, position,
        "startedAt", "updatedAt", "completedAt" FROM "Attempt"
      WHERE ${includeHistory} AND "userId" = ${userId}
    ), reviews AS (
      SELECT r."studySetId", r."cardId", r.fingerprint, r.streak, r."dueAt", r."attemptStartedAt"
      FROM "CardReview" r JOIN accessible_sets s ON s.id = r."studySetId"
      WHERE ${includeHistory} AND r."userId" = ${userId} AND s.content->>'kind' = 'flashcards'
    ), viewer_reviews AS (
      SELECT r."studySetId", r."cardId", r.fingerprint, r.streak, r."dueAt", r."attemptStartedAt"
      FROM "LibraryEntry" e JOIN "CardReview" r USING ("studySetId", "userId")
      JOIN "StudySet" s ON s.id = e."studySetId"
      WHERE ${includeHistory} AND s.kind = 'flashcards' AND e."userId" = ${userId}
        AND s."userId" <> ${userId} AND NOT e."coOwner"
    ), size AS (
      SELECT (
        COALESCE((SELECT sum(pg_column_size(f)) FROM folders f), 0) +
        COALESCE((SELECT sum(pg_column_size(s)) FROM sets s), 0) +
        COALESCE((SELECT sum(pg_column_size(a)) FROM attempts a), 0) +
        COALESCE((SELECT sum(pg_column_size(r)) FROM reviews r), 0) +
        COALESCE((SELECT sum(pg_column_size(r)) FROM viewer_reviews r), 0)
      ) > ${BACKUP_BYTES} AS "tooLarge"
    )
    SELECT "tooLarge",
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(to_jsonb(f) - 'manualRank' ORDER BY "manualRank", id) FROM folders f) END AS folders,
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(to_jsonb(s) - 'manualRank' ORDER BY "manualRank", id) FROM sets s) END AS sets,
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(a ORDER BY id) FROM attempts a) END AS attempts,
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(r ORDER BY "studySetId", "cardId") FROM reviews r) END AS reviews,
      CASE WHEN NOT "tooLarge" THEN (SELECT jsonb_agg(r ORDER BY "studySetId", "cardId") FROM viewer_reviews r) END AS "viewerReviews"
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
  const reviewDates = (row: Omit<CardReview, "userId">) => ({
    ...row,
    dueAt: utc(row.dueAt),
    attemptStartedAt: utc(row.attemptStartedAt),
  });
  const reviews = (rows.reviews ?? []).map(reviewDates);
  const viewerReviews = (rows.viewerReviews ?? []).map(reviewDates);
  const backup = {
    library: {
      ...archive,
      kind: "exam-prep-library",
      folders: decodeStorage(rows.folders ?? []),
      sets,
    },
    ...(includeHistory
      ? {
          history: {
            ...archive,
            kind: "exam-prep-history",
            attempts,
            reviews,
            ...(viewerReviews.length ? { viewerReviews } : {}),
          },
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

function backupIdMapper(userId: string, backupId: string) {
  // File-local IDs are remapped for this account. Repeating a restore of the
  // same file skips copies already present, even if the first reply was lost.
  const prefix = JSON.stringify([userId, backupId]);
  return async (kind: string, id: string) => {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(prefix + kind + id),
    );
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
}

async function previewBackup(
  db: Database,
  userId: string,
  backup: ReturnType<typeof validateBackup>,
): Promise<BackupPreview> {
  const remap = backupIdMapper(userId, backup.backupId);
  const plan = await planBackupSets(
    db,
    userId,
    backup,
    await previousSetIds(backup, remap),
  );
  const { eligible, reviewSkips } = await planBackupReviews(
    db,
    userId,
    backup,
    reviewSetIds(plan),
    false,
  );
  return {
    ...backupSummary(backup),
    ...backupSetCounts(plan),
    reviewCount: eligible.length - reviewSkips.unchanged,
    reviewSkips,
  };
}

async function previousSetIds(
  backup: ReturnType<typeof validateBackup>,
  remap: ReturnType<typeof backupIdMapper>,
) {
  return new Map(
    await Promise.all(
      backup.sets.map(async ({ id }) => [id, await remap("set", id)] as const),
    ),
  );
}

async function restoreBackup(
  db: Database,
  userId: string,
  backup: ReturnType<typeof validateBackup>,
): Promise<BackupRestoreResult> {
  const remap = backupIdMapper(userId, backup.backupId);
  const [previousIds, attemptIds, folderIds] = await Promise.all([
    previousSetIds(backup, remap),
    Promise.all(
      backup.attempts.map(
        async ({ id }) => [id, await remap("attempt", id)] as const,
      ),
    ).then((rows) => new Map(rows)),
    Promise.all(
      backup.folders.map(
        async ({ id }) => [id, await remap("folder", id)] as const,
      ),
    ).then((rows) => new Map(rows)),
  ]);
  return db.$transaction(async (tx) => {
    await lockLibrary(tx, userId);
    const plan = await planBackupSets(tx, userId, backup, previousIds);
    const setIds = reviewSetIds(plan);
    const affected = JSON.stringify([
      ...new Set([
        ...backup.attempts.flatMap(({ studySetId }) =>
          studySetId && setIds.has(studySetId) ? [setIds.get(studySetId)!] : [],
        ),
        ...backup.reviews.flatMap(({ studySetId }) =>
          setIds.has(studySetId) ? [setIds.get(studySetId)!] : [],
        ),
        ...backup.viewerReviews.map(({ studySetId }) => studySetId),
      ]),
    ]);
    // Editors, grant changes, and review starts lock the same live set rows.
    // Lock in ID order before inserting attempts or schedules.
    await tx.$queryRaw`
      SELECT s.id FROM "LibraryEntry" e JOIN "StudySet" s ON s.id = e."studySetId"
      WHERE e."userId" = ${userId} AND s.id IN (SELECT jsonb_array_elements_text(${affected}::jsonb))
      ORDER BY s.id FOR NO KEY UPDATE OF s`;
    const folders = JSON.stringify(
      encodeStorage(
        backup.folders.map(({ id, name }, position) => ({
          id: folderIds.get(id),
          name,
          position,
        })),
      ),
    );
    const restoredFolders = await tx.$queryRaw<
      { source: string; id: string; created: boolean }[]
    >`
      WITH input AS MATERIALIZED (
        SELECT * FROM jsonb_to_recordset(${folders}::jsonb) AS f(id text, name text, position int)
      ), inserted AS (
        INSERT INTO "LibraryFolder" (id, "userId", name)
        SELECT id, ${userId}, name FROM input ORDER BY position
        ON CONFLICT DO NOTHING RETURNING id
      )
      SELECT input.id AS source, COALESCE(inserted.id, by_id.id, by_name.id) AS id,
        inserted.id IS NOT NULL AS created
      FROM input LEFT JOIN inserted ON inserted.id = input.id
      LEFT JOIN "LibraryFolder" by_id ON by_id."userId" = ${userId} AND by_id.id = input.id
      LEFT JOIN "LibraryFolder" by_name ON by_name."userId" = ${userId} AND by_name.name = input.name
    `;
    const resolvedFolders = new Map(
      restoredFolders.map(({ source, id }) => [source, id]),
    );
    const legacyNames = [
      ...new Set(
        backup.sets
          .filter(
            (set) =>
              plan.get(set.id)!.create &&
              set.folderId === undefined &&
              set.course,
          )
          .map((set) => set.course),
      ),
    ];
    const legacyRows = legacyNames.length
      ? await tx.$queryRaw<{ id: string; name: string; created: boolean }[]>`
          WITH input AS MATERIALIZED (
            SELECT name, position
            FROM jsonb_array_elements_text(${JSON.stringify(encodeStorage(legacyNames))}::jsonb)
              WITH ORDINALITY AS legacy(name, position)
          ), inserted AS (
            INSERT INTO "LibraryFolder" (id, "userId", name)
            SELECT gen_random_uuid()::text, ${userId}, name FROM input ORDER BY position
            ON CONFLICT ("userId", name) DO NOTHING RETURNING id, name
          )
          SELECT id, name, true AS created FROM inserted
          UNION ALL
          SELECT f.id, f.name, false AS created
          FROM "LibraryFolder" f JOIN input ON input.name = f.name WHERE f."userId" = ${userId}
        `
      : [];
    const legacyFolders = new Map(
      legacyRows.map(({ id, name }) => [decodeStorage(name), id]),
    );
    await restoreBackupSets(tx, userId, backup, plan, (set) => ({
      folderId: set.folderId
        ? (resolvedFolders.get(folderIds.get(set.folderId)!) ?? null)
        : set.folderId === null
          ? null
          : (legacyFolders.get(set.course) ?? null),
    }));

    const sourceRevisions = new Map(
      backup.sets.map(({ id, revision }) => [id, revision]),
    );
    const attempts = JSON.stringify(
      encodeStorage(
        backup.attempts.map((attempt, restoreOrder) => {
          const sourceId = attempt.studySetId;
          const destination = sourceId ? plan.get(sourceId)! : null;
          let studySetRevision = attempt.studySetRevision;
          if (sourceId && destination && !destination.create) {
            // Historical revision numbers belong to the original set. Only its
            // backed-up current version has a known destination revision.
            studySetRevision =
              studySetRevision === sourceRevisions.get(sourceId)
                ? destination.revision
                : null;
          }
          return {
            ...attempt,
            id: attemptIds.get(attempt.id),
            studySetId: sourceId ? (setIds.get(sourceId) ?? null) : null,
            studySetRevision,
            sourceAttemptId: attempt.sourceAttemptId
              ? attemptIds.get(attempt.sourceAttemptId)
              : null,
            snapshotVersion: SNAPSHOT_VERSION,
            progressContent: progressContent(attempt.snapshot),
            restoreOrder,
          };
        }),
      ),
    );
    const restoredAttempts = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Attempt" (id, "userId", "studySetId", "studySetRevision", "sourceAttemptId",
        "snapshotVersion", "progressContent", snapshot, settings, "reviewMode", "fullSet", responses,
        result, status, position, "startedAt", "updatedAt", "completedAt")
      SELECT id, ${userId}, CASE WHEN a."reviewMode" AND a.status = 'in_progress' AND EXISTS (
          SELECT 1 FROM "Attempt" existing WHERE existing."userId" = ${userId}
            AND existing."studySetId" = a."studySetId" AND existing."reviewMode" AND existing.status = 'in_progress'
        ) THEN NULL ELSE a."studySetId" END, "studySetRevision", "sourceAttemptId",
        "snapshotVersion", "progressContent", snapshot, settings, "reviewMode", "fullSet", responses,
        result, status, position, "startedAt", "updatedAt", "completedAt"
      FROM jsonb_to_recordset(${attempts}::jsonb) AS a(
        id text, "studySetId" text, "studySetRevision" int, "sourceAttemptId" text,
        "snapshotVersion" int, "progressContent" jsonb, snapshot jsonb, settings jsonb,
        "reviewMode" bool, "fullSet" bool, responses jsonb, result jsonb, status text,
        position int, "startedAt" timestamp, "updatedAt" timestamp, "completedAt" timestamp, "restoreOrder" int)
      ORDER BY "restoreOrder"
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    const reviewResult = await restoreBackupReviews(tx, userId, backup, setIds);
    return {
      ...(backup.folders.length || legacyNames.length
        ? {
            folderCount:
              restoredFolders.filter(({ created }) => created).length +
              legacyRows.filter(({ created }) => created).length,
          }
        : {}),
      ...backupSetCounts(plan),
      attemptCount: restoredAttempts.length,
      ...reviewResult,
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
    c.json(
      await previewBackup(
        c.get("db"),
        c.get("userId"),
        await readBackup(c.req.raw),
      ),
    ),
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
