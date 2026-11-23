import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import type { validateBackup } from "../shared/backup";
import type { Database } from "./db";
import {
  exactContent,
  exactMatchOrder,
  insertPrivateSets,
  joinPrimaryEntry,
} from "./setCreation";
import { encodeStorage } from "./storage";

type Backup = ReturnType<typeof validateBackup>;
type Tx = Pick<Database, "$queryRaw" | "$executeRaw">;
type Destination = {
  id: string;
  revision: number;
  exists: boolean;
  create: boolean;
  recorded: boolean;
};

export async function planBackupSets(
  db: Tx,
  userId: string,
  backup: Backup,
  previousIds: Map<string, string>,
) {
  const plan = new Map<string, Destination>();
  if (!backup.sets.length) return plan;
  const input = JSON.stringify(
    encodeStorage(
      backup.sets.map(({ id, content }) => ({
        id,
        content,
        previousId: previousIds.get(id),
      })),
    ),
  );
  type Match = { id: string; revision: number };
  type Mapping = {
    sourceId: string;
    groupId: number;
    receiptId: string | null;
    receiptMatches: boolean;
    receiptRevision: number | null;
    receiptExists: boolean;
    original: Match | null;
    previous: { id: string } | null;
  };
  const [{ rows, groups }] = await db.$queryRaw<
    {
      rows: Mapping[];
      groups: { groupId: number; candidates: Match[] }[] | null;
    }[]
  >(sql`
    WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS i(id text, content jsonb, "previousId" text)
    ), documents AS MATERIALIZED (
      SELECT content, row_number() OVER () AS "groupId" FROM (SELECT DISTINCT content FROM input) d
    ), mappings AS MATERIALIZED (
      SELECT i.id AS "sourceId", d."groupId", r."setId" AS "receiptId",
        r."contentFingerprint" = study_content_fingerprint(d.content) AS "receiptMatches",
        r."destinationRevision" AS "receiptRevision", resolved.id IS NOT NULL AS "receiptExists",
        CASE WHEN previous.id IS NOT NULL THEN jsonb_build_object('id', previous.id) END AS previous,
        CASE WHEN s.id IS NOT NULL THEN jsonb_build_object('id', s.id, 'revision', s.revision) END AS original
      FROM input i JOIN documents d USING (content)
      LEFT JOIN "BackupSetRestore" r ON r."userId" = ${userId} AND r."backupId" = ${backup.backupId} AND r."sourceId" = i.id
      LEFT JOIN "StudySet" resolved ON resolved."userId" = ${userId} AND resolved.id = r."setId"
      LEFT JOIN "StudySet" previous ON previous."userId" = ${userId} AND previous.id = i."previousId"
      LEFT JOIN "StudySet" s ON s."userId" = ${userId} AND s.id = i.id AND s.content = i.content
    ), candidates AS (
      SELECT d."groupId", matches.candidates FROM documents d
      JOIN (SELECT DISTINCT "groupId" FROM mappings WHERE "receiptId" IS NULL) needed USING ("groupId")
      CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'revision', c.revision)
          ORDER BY c.archived, c."createdAt", c.id) AS candidates
        FROM (
          SELECT s.id, s.revision, e.archived, s."createdAt" FROM "StudySet" s ${joinPrimaryEntry}
          WHERE s."userId" = ${userId} AND ${exactContent(sql`d.content`)}
          ORDER BY ${exactMatchOrder} LIMIT ${backup.sets.length}
        ) c
      ) matches
      WHERE matches.candidates IS NOT NULL
    )
    SELECT (SELECT jsonb_agg(m) FROM mappings m) AS rows,
      (SELECT jsonb_agg(c) FROM candidates c) AS groups
  `);
  const candidateGroups = new Map(
    groups?.map(({ groupId, candidates }) => [
      groupId,
      { candidates, next: 0 },
    ]),
  );
  const bySource = new Map(rows.map((row) => [row.sourceId, row]));
  const claimed = new Set<string>();
  function assign(source: string, destination: Destination) {
    plan.set(source, destination);
    claimed.add(destination.id);
  }
  // Reserve prior outcomes, then exact original IDs, before any archive set
  // can claim another archive set's original through content matching.
  for (const row of rows) {
    if (!row.receiptId) continue;
    if (!row.receiptMatches)
      throw new HTTPException(409, {
        message:
          "This backup ID was already restored with different study content.",
      });
    assign(row.sourceId, {
      id: row.receiptId,
      revision: row.receiptRevision!,
      exists: row.receiptExists,
      create: false,
      recorded: true,
    });
  }
  for (const { id, revision } of backup.sets) {
    if (plan.has(id)) continue;
    const previous = bySource.get(id)!.previous;
    if (previous && !claimed.has(previous.id))
      assign(id, {
        id: previous.id,
        revision,
        exists: true,
        create: false,
        recorded: false,
      });
  }
  for (const { id } of backup.sets) {
    if (plan.has(id)) continue;
    const original = bySource.get(id)!.original;
    if (original && !claimed.has(original.id))
      assign(id, { ...original, exists: true, create: false, recorded: false });
  }
  for (const { id, revision } of backup.sets) {
    if (plan.has(id)) continue;
    const group = candidateGroups.get(bySource.get(id)!.groupId);
    while (
      group &&
      group.next < group.candidates.length &&
      claimed.has(group.candidates[group.next].id)
    )
      group.next++;
    const candidate = group?.candidates[group.next++];
    assign(
      id,
      candidate
        ? {
            id: candidate.id,
            revision: candidate.revision,
            exists: true,
            create: false,
            recorded: false,
          }
        : {
            id: crypto.randomUUID(),
            revision,
            exists: false,
            create: true,
            recorded: false,
          },
    );
  }
  return plan;
}

export async function restoreBackupSets(
  tx: Tx,
  userId: string,
  backup: Backup,
  plan: Map<string, Destination>,
  placementFor: (set: Backup["sets"][number]) => {
    folderId: string | null;
  },
) {
  await insertPrivateSets(
    tx,
    userId,
    backup.sets.flatMap((set) => {
      const destination = plan.get(set.id)!;
      return destination.create
        ? [{ ...set, ...placementFor(set), id: destination.id }]
        : [];
    }),
  );
  const receipts = backup.sets.flatMap(({ id, content }) => {
    const destination = plan.get(id)!;
    return destination.recorded
      ? []
      : [
          {
            sourceId: id,
            setId: destination.id,
            destinationRevision: destination.revision,
            content,
          },
        ];
  });
  if (receipts.length)
    await tx.$executeRaw`
      INSERT INTO "BackupSetRestore" ("userId", "backupId", "sourceId", "setId", "contentFingerprint", "destinationRevision")
      SELECT ${userId}, ${backup.backupId}, "sourceId", "setId", study_content_fingerprint(content), "destinationRevision"
      FROM jsonb_to_recordset(${JSON.stringify(encodeStorage(receipts))}::jsonb)
        AS r("sourceId" text, "setId" text, content jsonb, "destinationRevision" int)`;
}

export function backupSetCounts(plan: Map<string, Destination>) {
  let setCount = 0;
  let reusedSetCount = 0;
  for (const destination of plan.values()) {
    if (destination.create) setCount++;
    else if (destination.exists) reusedSetCount++;
  }
  return { setCount, reusedSetCount };
}

export function reviewSetIds(plan: Map<string, Destination>) {
  return new Map(
    [...plan]
      .filter(([, set]) => set.exists || set.create)
      .map(([id, set]) => [id, set.id]),
  );
}
