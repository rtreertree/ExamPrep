// Run with the direct Neon connection. Audit is the default and uses read-only transactions.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";
import { z } from "zod";
import { cardFingerprint } from "../server/spacedReview";
import { decodeStorage } from "../server/storage";
import { validateContent, type Card } from "../shared/content";
import { maxReviewStartSkewMs } from "../shared/backup";
import { databaseConnection } from "./deployment-config.mjs";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean" },
    release: { type: "boolean" },
    copy: { type: "string" },
    matches: { type: "string" },
    details: { type: "boolean" },
    recover: { type: "boolean" },
  },
});
if (
  values.release &&
  (values.apply || values.copy || values.matches || values.recover)
)
  throw new Error("Use --release on its own.");
if (values.recover && (!values.copy || values.matches || values.details))
  throw new Error("Use --recover --copy ID and add --apply to write.");
const matches = z
  .array(
    z.strictObject({
      copyId: z.string(),
      sourceId: z.string(),
      revision: z.number().int().positive(),
      evidence: z.string().trim().min(1),
    }),
  )
  .parse(
    values.matches ? JSON.parse(await readFile(values.matches, "utf8")) : [],
  );
const confirmed = new Map(matches.map((m) => [m.copyId, m]));
if (confirmed.size !== matches.length)
  throw new Error("Specify one source per reviewed copy.");
const connection = databaseConnection(process.env.DATABASE_URL_UNPOOLED, false);
neonConfig.webSocketConstructor = ws;
const pool = new Pool({
  connectionString: connection.href,
  max: 1,
});

type Entry = {
  id: string;
  userId: string;
  revision: number;
  kind: string;
  createdAt: Date;
  lastStudiedAt: Date | null;
  signature: string;
  items: string;
  origin: string | null;
  hasReceipt: boolean;
  converted: boolean;
  present: boolean;
  legacy: boolean;
};
async function inventory(db: PoolClient): Promise<Entry[]> {
  return (
    await db.query<Entry>(`
    WITH entries AS (SELECT id FROM "StudySet" UNION SELECT "copyId" FROM "CloneConversion")
    SELECT e.id, COALESCE(c."userId",s."userId") AS "userId", s.revision,s.kind,s."createdAt",s."lastStudiedAt",
      c."copyId" IS NOT NULL AS legacy, s.id IS NOT NULL AS present, c."convertedAt" IS NOT NULL AS converted,
      md5((s.content-'title')::text) AS signature,
      md5((SELECT jsonb_agg(i->>'id' ORDER BY i->>'id')::text FROM jsonb_array_elements(
        COALESCE(s.content->'cards',s.content->'questions')) i)) AS items,
      CASE WHEN r."linkNonce" LIKE 'discover:%' OR r."linkNonce" LIKE 'admin:%' THEN split_part(r."linkNonce",':',2)
        WHEN r."linkNonce" LIKE 'editable:%' THEN split_part(r."linkNonce",':',3) ELSE l."studySetId" END AS origin,
      r."linkNonce" IS NOT NULL AS "hasReceipt"
    FROM entries e LEFT JOIN "StudySet" s ON s.id=e.id LEFT JOIN "CloneConversion" c ON c."copyId"=e.id
    LEFT JOIN "StudySetCopyImport" r ON r."copyId"=e.id AND r."userId"=s."userId"
    LEFT JOIN "StudySetCopyLink" l ON l.nonce=r."linkNonce"
    ORDER BY s."lastStudiedAt" DESC NULLS LAST,s."createdAt" DESC NULLS LAST,e.id
  `)
  ).rows;
}

async function inspect(db: PoolClient, copy: Entry, sourceId: string) {
  const {
    rows: [state],
  } = await db.query(
    `
    SELECT s.id,s.published,s."userId"=c."userId" AS primary, m.role,
      l.nonce AS nonce, c.revision, prev."convertedAt", r."linkNonce" AS receipt,
      s.content = c.content AS equivalent,
      c.published OR EXISTS(SELECT 1 FROM "StudySetCopyLink" WHERE "studySetId"=c.id)
      OR EXISTS(SELECT 1 FROM "LibraryMembership" WHERE "studySetId"=c.id)
      OR EXISTS(SELECT 1 FROM "StudySetInvitation" WHERE "studySetId"=c.id)
      OR EXISTS(SELECT 1 FROM "StudySetCopyImport" child JOIN "StudySet" cs ON cs.id=child."copyId"
        WHERE child."linkNonce" IN ('discover:'||c.id,'admin:'||c.id,'editable:discover:'||c.id,'editable:admin:'||c.id))
      AS downstream,
      EXISTS(SELECT 1 FROM "Attempt" a WHERE a."studySetId"=s.id AND a."userId"=c."userId" AND a."reviewMode" AND a.status='in_progress')
      AND EXISTS(SELECT 1 FROM "Attempt" a WHERE a."studySetId"=c.id AND a."userId"=c."userId" AND a."reviewMode" AND a.status='in_progress') AS overlap,
      EXISTS(SELECT 1 FROM "StudySetCopyImport" parent WHERE parent."copyId"=s.id) AS nested
    FROM "CloneConversion" prev JOIN "StudySet" c ON c.id=prev."copyId" AND c."userId"=prev."userId"
    JOIN "StudySet" s ON s.id=$2 AND s.id<>c.id
    LEFT JOIN "LibraryMembership" m ON m."studySetId"=s.id AND m."userId"=c."userId"
    LEFT JOIN "StudySetCopyImport" r ON r."copyId"=c.id AND r."userId"=c."userId"
    LEFT JOIN "StudySetCopyLink" l ON l."studySetId"=s.id AND l.nonce=r."linkNonce"
    WHERE c.id=$1 AND prev."userId"=$3`,
    [copy.id, sourceId, copy.userId],
  );
  return state;
}

async function convert(db: PoolClient, copy: Entry, sourceId: string) {
  if (values.apply) {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('exam-prep-library'),hashtext($1))",
      [copy.userId],
    );
    await db.query(
      'SELECT id FROM "StudySet" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
      [[copy.id, sourceId]],
    );
  }
  const state = await inspect(db, copy, sourceId);
  if (!state) {
    const result = await db.query('SELECT id FROM "StudySet" WHERE id=$1', [
      sourceId,
    ]);
    return result.rowCount ? "unavailable" : "missing-origin";
  }
  if (state.convertedAt) return "unavailable";
  const receipt = state.receipt as string | null;
  const reviewed = confirmed.get(copy.id);
  const verified =
    receipt === `discover:${sourceId}` ||
    receipt === `admin:${sourceId}` ||
    !!state.nonce;
  const reviewedMatch =
    !receipt &&
    reviewed?.sourceId === sourceId &&
    reviewed.revision === state.revision;
  if (!verified && !reviewedMatch) return "needs-confirmation";
  if (!state.equivalent) return "divergent-content";
  if (
    state.downstream ||
    state.nested ||
    matches.some((m) => m.sourceId === copy.id || m.copyId === sourceId)
  )
    return "shared-or-nested";
  if (!(state.primary || state.role || state.published || state.nonce))
    return "no-current-access";
  if (state.overlap) return "overlapping-open-reviews";
  if (!values.apply) return "eligible";

  const role = state.primary ? "primary" : state.role || "viewer";
  if (role === "viewer" && (state.published || state.nonce)) {
    const discovered = state.published && !state.nonce;
    await db.query(
      `INSERT INTO "StudySetViewer" ("studySetId","userId",course,"folderId","manualRank",pinned,archived,"lastStudiedAt","reviewLimit","linkNonce",discovered)
      SELECT $2,"userId",course,"folderId","manualRank",pinned,archived,"lastStudiedAt","reviewLimit",$3,$4 FROM "StudySet" WHERE id=$1
      ON CONFLICT ("studySetId","userId") DO UPDATE SET discovered="StudySetViewer".discovered OR EXCLUDED.discovered,
        "linkNonce"=COALESCE(EXCLUDED."linkNonce","StudySetViewer"."linkNonce")`,
      [copy.id, sourceId, state.nonce, discovered],
    );
  }
  // Archive the exact stored set and its schedules before retiring the old ID.
  await db.query(
    `UPDATE "CloneConversion" p SET "sourceId"=$2,"convertedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
    recovery=jsonb_build_object('set',to_jsonb(c),'reviews',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM "CardReview" r WHERE r."studySetId"=c.id),'[]'::jsonb))
    FROM "StudySet" c WHERE c.id=$1 AND p."copyId"=c.id`,
    [copy.id, sourceId],
  );
  const {
    rows: [source],
  } = await db.query<{ cards: Card[] | null }>(
    "SELECT content->'cards' AS cards FROM \"StudySet\" WHERE id=$1",
    [sourceId],
  );
  if (source.cards) {
    const fingerprints = await Promise.all(
      decodeStorage(source.cards).map(async (card) => ({
        id: card.id,
        fingerprint: await cardFingerprint(card),
      })),
    );
    const table =
      role === "primary"
        ? '"CardReview"'
        : role === "co_owner"
          ? '"CoOwnerCardReview"'
          : '"ViewerCardReview"';
    const personal = role !== "primary";
    await db.query(
      `INSERT INTO ${table} ("studySetId",${personal ? '"userId",' : ""}"cardId",fingerprint,streak,"dueAt","attemptStartedAt")
      SELECT $2,${personal ? "$4," : ""}r."cardId",r.fingerprint,r.streak,r."dueAt",r."attemptStartedAt" FROM "CardReview" r
      JOIN jsonb_to_recordset($3::jsonb) f(id text,fingerprint text) ON f.id=r."cardId" AND f.fingerprint=r.fingerprint
      WHERE r."studySetId"=$1 ON CONFLICT ("studySetId",${personal ? '"userId",' : ""}"cardId") DO UPDATE SET
      fingerprint=EXCLUDED.fingerprint,streak=EXCLUDED.streak,"dueAt"=EXCLUDED."dueAt","attemptStartedAt"=EXCLUDED."attemptStartedAt"
      WHERE ${table}."attemptStartedAt"<EXCLUDED."attemptStartedAt"`,
      [
        copy.id,
        sourceId,
        JSON.stringify(fingerprints),
        ...(personal ? [copy.userId] : []),
      ],
    );
  }
  // A clone revision number has no meaning in the original's revision history.
  await db.query(
    `UPDATE "Attempt" SET "studySetId"=$2,"studySetRevision"=NULL WHERE "studySetId"=$1 AND "userId"=$3`,
    [copy.id, sourceId, copy.userId],
  );
  await db.query('DELETE FROM "StudySet" WHERE id=$1 AND "userId"=$2', [
    copy.id,
    copy.userId,
  ]);
  return "converted";
}

async function run(db: PoolClient) {
  await db.query("BEGIN READ ONLY");
  const entries = await inventory(db);
  await db.query("COMMIT");
  const legacy = entries.filter(
    (e) => e.legacy && (!values.copy || e.id === values.copy),
  );
  if (values.copy && !legacy.length)
    throw new Error("No historical inventory entry for that copy.");
  const counts: Record<string, number> = {};
  const signatures = new Map<string, Entry[]>();
  for (const entry of entries.filter((e) => e.present)) {
    for (const key of new Set([entry.signature, entry.items].filter(Boolean))) {
      const group = signatures.get(key) ?? [];
      group.push(entry);
      signatures.set(key, group);
    }
  }
  for (const copy of legacy) {
    const reviewed = confirmed.get(copy.id);
    const sourceId = copy.origin ?? reviewed?.sourceId;
    let status: string;
    let candidates: string[] = [];
    if (copy.converted) status = "previously-converted";
    else if (!copy.present) status = "deleted";
    else if (copy.origin && reviewed && copy.origin !== reviewed.sourceId)
      status = "conflicting-origin";
    else if (copy.hasReceipt && !copy.origin) status = "missing-origin";
    else if (sourceId) {
      await db.query(values.apply ? "BEGIN" : "BEGIN READ ONLY");
      status = await convert(db, copy, sourceId);
      await db.query("COMMIT");
    } else {
      candidates = [
        ...new Set(
          [
            ...(signatures.get(copy.signature) ?? []),
            ...(signatures.get(copy.items) ?? []),
          ]
            .filter(
              (s) =>
                s.id !== copy.id &&
                s.kind === copy.kind &&
                s.createdAt <= copy.createdAt,
            )
            .map((s) => s.id),
        ),
      ];
      status = candidates.length
        ? "needs-confirmation"
        : "no-recorded-original";
    }
    counts[status] = (counts[status] ?? 0) + 1;
    if (values.details)
      console.log(
        JSON.stringify({
          copyId: copy.id,
          revision: copy.revision,
          sourceId,
          status,
          candidates,
        }),
      );
  }
  console.log(JSON.stringify({ inventory: legacy.length, counts }));
  return counts;
}
async function runRelease(db: PoolClient) {
  await db.query(
    "SELECT pg_advisory_lock(hashtext('exam-prep-live-set-cutover'))",
  );
  try {
    const {
      rows: [cutover],
    } = await db.query('SELECT "completedAt" FROM "LiveSetCutover" WHERE id=1');
    if (cutover.completedAt) {
      console.log("Historical live-set conversion already completed.");
      return;
    }
    await run(db);
    values.apply = true;
    await run(db);
    values.apply = false;
    const counts = await run(db);
    if (counts.eligible)
      throw new Error("Eligible copies still pending after conversion.");
    await db.query(
      `UPDATE "LiveSetCutover" SET "completedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE id=1`,
    );
  } finally {
    await db.query("ROLLBACK");
    await db.query(
      "SELECT pg_advisory_unlock(hashtext('exam-prep-live-set-cutover'))",
    );
  }
}

const archivedReview = z.object({
  studySetId: z.string(),
  cardId: z.string(),
  fingerprint: z.string(),
  streak: z.number().int().min(0).max(5),
  dueAt: z.iso.datetime({ local: true }),
  attemptStartedAt: z.iso.datetime({ local: true }),
});

class RecoveryError extends Error {}

async function recover(db: PoolClient, copyId: string) {
  await db.query(values.apply ? "BEGIN" : "BEGIN READ ONLY");
  const owner = await db.query<{ userId: string }>(
    'SELECT "userId" FROM "CloneConversion" WHERE "copyId"=$1 AND "convertedAt" IS NOT NULL',
    [copyId],
  );
  const userId = owner.rows[0]?.userId;
  if (!userId) throw new RecoveryError("No converted archive for this ID.");
  if (values.apply) {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('exam-prep-library'),hashtext($1))",
      [userId],
    );
  }
  const {
    rows: [record],
  } = await db.query<{
    restoredCopyId: string | null;
    recovery: {
      set?: {
        id?: string;
        userId?: string;
        content?: unknown;
        title?: string;
        kind?: string;
      };
      reviews?: unknown[];
    } | null;
  }>(
    `SELECT "restoredCopyId", recovery FROM "CloneConversion" WHERE "copyId"=$1 AND "userId"=$2
    AND "convertedAt" IS NOT NULL ${values.apply ? "FOR UPDATE" : ""}`,
    [copyId, userId],
  );
  if (record?.restoredCopyId) {
    await db.query("COMMIT");
    console.log(
      JSON.stringify({
        status: "previously-recovered",
        recoveredCopyId: record.restoredCopyId,
      }),
    );
    return;
  }
  const archived = record?.recovery?.set;
  if (
    archived?.id !== copyId ||
    archived.userId !== userId ||
    !Array.isArray(record?.recovery?.reviews)
  )
    throw new RecoveryError(
      "The archive does not match the retired copy and owner.",
    );
  const content = validateContent(decodeStorage(archived.content));
  if (
    content.title !== decodeStorage(archived.title) ||
    content.kind !== archived.kind
  )
    throw new RecoveryError("The archive contains inconsistent set metadata.");
  const fingerprints = new Map(
    await Promise.all(
      (content.kind === "flashcards" ? content.cards : []).map(
        async (card) => [card.id, await cardFingerprint(card)] as const,
      ),
    ),
  );
  const reviews = new Map<string, z.infer<typeof archivedReview>>();
  const latestAllowed = Date.now() + maxReviewStartSkewMs;
  for (const item of record.recovery.reviews) {
    const parsed = archivedReview.safeParse(item);
    if (!parsed.success) continue;
    const review = parsed.data;
    const due = new Date(review.dueAt.replace(/Z?$/, "Z"));
    const start = new Date(review.attemptStartedAt.replace(/Z?$/, "Z"));
    if (
      review.studySetId === copyId &&
      fingerprints.get(review.cardId) === review.fingerprint &&
      due.getTime() >= start.getTime() &&
      start.getTime() <= latestAllowed
    ) {
      reviews.set(review.cardId, {
        ...review,
        dueAt: due.toISOString(),
        attemptStartedAt: start.toISOString(),
      });
    }
  }
  const counts = {
    reviewCount: reviews.size,
    skippedReviewCount: record.recovery.reviews.length - reviews.size,
  };
  if (!values.apply) {
    await db.query("COMMIT");
    console.log(JSON.stringify({ status: "recoverable", ...counts }));
    return;
  }

  const recoveredCopyId = crypto.randomUUID();
  await db.query(
    `INSERT INTO "StudySet" (
      id, "userId", title, kind, content, revision, course, "folderId", pinned, archived,
      "reviewLimit", "lastStudiedAt", "createdAt", "updatedAt"
    ) SELECT $2, s."userId", s.title, s.kind, s.content, s.revision, s.course,
      f.id, s.pinned, s.archived, s."reviewLimit", s."lastStudiedAt", s."createdAt", s."updatedAt"
    FROM "CloneConversion" c
    CROSS JOIN LATERAL jsonb_populate_record(NULL::"StudySet", c.recovery->'set') s
    LEFT JOIN "LibraryFolder" f ON f.id=s."folderId" AND f."userId"=c."userId"
    WHERE c."copyId"=$1`,
    [copyId, recoveredCopyId],
  );
  await db.query(
    `INSERT INTO "CardReview" ("studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt")
    SELECT $1, r."cardId", r.fingerprint, r.streak, r."dueAt", r."attemptStartedAt"
    FROM jsonb_to_recordset($2::jsonb) AS r("cardId" text, fingerprint text, streak int,
      "dueAt" timestamp, "attemptStartedAt" timestamp)`,
    [recoveredCopyId, JSON.stringify([...reviews.values()])],
  );
  await db.query(
    'UPDATE "CloneConversion" SET "restoredCopyId"=$2 WHERE "copyId"=$1',
    [copyId, recoveredCopyId],
  );
  await db.query("COMMIT");
  console.log(
    JSON.stringify({ status: "recovered", recoveredCopyId, ...counts }),
  );
}

try {
  const db = await pool.connect();
  try {
    if (values.recover) await recover(db, values.copy!);
    else if (values.release) await runRelease(db);
    else await run(db);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
} catch (error) {
  console.error(
    values.recover
      ? "Clone recovery stopped."
      : "Clone conversion stopped. Committed conversions can be safely retried.",
    error instanceof RecoveryError
      ? error.message
      : error instanceof Error
        ? error.name
        : "Database error",
    (error as { code?: string }).code ?? "",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
