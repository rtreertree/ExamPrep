// Run with the direct Neon connection. Audit is the default and uses read-only transactions.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import ws from "ws";
import { z } from "zod";
import { cardFingerprint } from "../server/spacedReview";
import { decodeStorage } from "../server/storage";
import type { Card } from "../shared/content";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean" },
    release: { type: "boolean" },
    copy: { type: "string" },
    matches: { type: "string" },
    details: { type: "boolean" },
  },
});
if (values.release && (values.apply || values.copy || values.matches))
  throw new Error("Use --release on its own.");
const matches = z
  .array(
    z.strictObject({
      copyId: z.string(),
      sourceId: z.string(),
      revision: z.number().int().positive(),
    }),
  )
  .parse(
    values.matches ? JSON.parse(await readFile(values.matches, "utf8")) : [],
  );
const confirmed = new Map(matches.map((m) => [m.copyId, m]));
if (confirmed.size !== matches.length)
  throw new Error("Specify one source per reviewed copy.");
if (!process.env.DATABASE_URL_UNPOOLED)
  throw new Error("Set DATABASE_URL_UNPOOLED for the target database.");
neonConfig.webSocketConstructor = ws;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
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
        WHEN r."linkNonce" LIKE 'editable:%' THEN split_part(r."linkNonce",':',3) ELSE l."studySetId" END AS origin
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
  if (!state || state.convertedAt) return "unavailable";
  const receipt = state.receipt as string | null;
  const reviewed = confirmed.get(copy.id);
  const verified =
    receipt === `discover:${sourceId}` ||
    receipt === `admin:${sourceId}` ||
    !!state.nonce;
  if (
    !verified &&
    !(reviewed?.sourceId === sourceId && reviewed.revision === state.revision)
  )
    return "needs-confirmation";
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
    await db.query(
      `INSERT INTO "StudySetViewer" ("studySetId","userId",course,"folderId","manualRank",pinned,archived,"lastStudiedAt","reviewLimit","linkNonce",discovered)
      SELECT $2,"userId",course,"folderId","manualRank",pinned,archived,"lastStudiedAt","reviewLimit",$3,$4 FROM "StudySet" WHERE id=$1
      ON CONFLICT ("studySetId","userId") DO UPDATE SET discovered="StudySetViewer".discovered OR EXCLUDED.discovered,
        "linkNonce"=COALESCE(EXCLUDED."linkNonce","StudySetViewer"."linkNonce")`,
      [copy.id, sourceId, state.nonce, state.published],
    );
  }
  // Archive the exact stored set and its schedules before retiring the old ID.
  await db.query(
    `UPDATE "CloneConversion" p SET "sourceId"=$2,"convertedAt"=CURRENT_TIMESTAMP,
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
      'UPDATE "LiveSetCutover" SET "completedAt"=now() WHERE id=1',
    );
  } finally {
    await db.query("ROLLBACK");
    await db.query(
      "SELECT pg_advisory_unlock(hashtext('exam-prep-live-set-cutover'))",
    );
  }
}
try {
  const db = await pool.connect();
  try {
    if (values.release) await runRelease(db);
    else await run(db);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
} catch (error) {
  console.error(
    "Clone conversion stopped. Committed conversions can be safely retried.",
    error instanceof Error ? error.name : "Database error",
    (error as { code?: string }).code ?? "",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
