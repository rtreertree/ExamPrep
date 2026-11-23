import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import type { StudySet } from "../generated/prisma/client";
import type { OwnershipRole } from "../shared/sharing";
import type { SetOrganization } from "../shared/listing";
import type { Database } from "./db";
import { encodeStorage } from "./storage";
import { folderForLegacyName, lockLibrary, readFolder } from "./libraryOrder";

type QueryDb = Pick<Database, "$queryRaw">;
export type LibrarySet = Omit<StudySet, "contentFingerprint"> & {
  ownershipRole: OwnershipRole;
  folderId: string | null;
  folderName: string | null;
  course: string;
  pinned: boolean;
  archived: boolean;
  lastStudiedAt: Date | null;
  reviewLimit: number;
  ownerName: string;
};

export const unavailableSet = () =>
  new HTTPException(404, { message: "This study set is unavailable." });

export const joinEntry = (userId: string) => sql`
  JOIN "LibraryEntry" e ON e."studySetId" = s.id AND e."userId" = ${userId}
`;
export const entryRole = sql`
  CASE WHEN e."userId" = s."userId" THEN 'primary' WHEN e."coOwner" THEN 'co_owner' ELSE 'viewer' END
`;
export const entryPreferences = sql`
  f.name AS "folderName", COALESCE(f.name, '') AS course, e."folderId",
  e.pinned, e.archived, e."lastStudiedAt", e."reviewLimit"
`;
export const joinEntryFolder = sql`
  LEFT JOIN "LibraryFolder" f ON (f."userId", f.id) = (e."userId", e."folderId")
`;

export async function readLibrarySet(db: QueryDb, id: string, userId: string) {
  const [set] = await db.$queryRaw<LibrarySet[]>(sql`
    SELECT s.id, s."userId", s.title, s.kind, s.content, s.revision, s.published, s."createdAt",
      u.name AS "ownerName", s."updatedAt", ${entryRole} AS "ownershipRole", ${entryPreferences}
    FROM "StudySet" s JOIN "user" u ON u.id = s."userId" ${joinEntry(userId)} ${joinEntryFolder}
    WHERE s.id = ${id}
  `);
  if (!set) throw unavailableSet();
  return set;
}

export async function lockOwnerLibrary(
  tx: Pick<Database, "$queryRaw" | "$executeRaw">,
  id: string,
) {
  const [owner] = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "StudySet" WHERE id = ${id}`;
  if (!owner) throw unavailableSet();
  await lockLibrary(tx, owner.userId);
}

export async function lockPrimarySet(db: QueryDb, id: string, userId: string) {
  const [set] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "StudySet" WHERE id = ${id} AND "userId" = ${userId} FOR NO KEY UPDATE
  `;
  if (!set) throw unavailableSet();
}

export async function lockSet(db: QueryDb, id: string) {
  const [set] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "StudySet" WHERE id = ${id} FOR NO KEY UPDATE
  `;
  return !!set;
}

export async function lockLibrarySet(db: QueryDb, id: string, userId: string) {
  const [locked] = await db.$queryRaw<{ id: string }[]>(sql`
    SELECT s.id FROM "StudySet" s ${joinEntry(userId)}
    WHERE s.id = ${id} FOR NO KEY UPDATE OF s
  `);
  if (!locked) throw unavailableSet();
}

export async function readLockedLibrarySet(
  db: QueryDb,
  id: string,
  userId: string,
) {
  await lockLibrarySet(db, id, userId);
  // A separate statement sees a membership change committed while acquiring the lock.
  return readLibrarySet(db, id, userId);
}

export async function organizeSets(
  db: Database,
  userId: string,
  ids: string[],
  changes: SetOrganization,
  changedOnly: boolean,
) {
  const pinned = changes.pinned ?? null;
  const archived = changes.archived ?? null;
  const target = sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
  return db.$transaction(async (tx) => {
    await lockLibrary(tx, userId);
    const locked = await tx.$queryRaw<{ id: string }[]>(sql`
      SELECT s.id FROM "StudySet" s ${joinEntry(userId)}
      WHERE s.id IN ${target}
      ORDER BY s.id FOR NO KEY UPDATE OF s
    `);
    if (locked.length !== ids.length) throw unavailableSet();
    const owned = await tx.$queryRaw<{ id: string }[]>(sql`
      SELECT s.id FROM "StudySet" s ${joinEntry(userId)}
      WHERE s.id IN ${target}
    `);
    if (owned.length !== ids.length) throw unavailableSet();
    const movesFolder =
      changes.folderId !== undefined || changes.course !== undefined;
    if (changes.folderId) await readFolder(tx, userId, changes.folderId);
    const course =
      changes.course === undefined ? null : encodeStorage(changes.course);
    const folderId =
      changes.folderId === undefined && course !== null
        ? await folderForLegacyName(tx, userId, course)
        : (changes.folderId ?? null);
    const locationChanges = sql`(
      (${movesFolder} AND "folderId" IS DISTINCT FROM ${folderId}::text)
      OR archived <> COALESCE(${archived}::boolean, archived)
    )`;
    const fields = sql`
      "folderId" = CASE WHEN ${movesFolder} THEN ${folderId}::text ELSE "folderId" END,
      "manualRank" = CASE WHEN ${locationChanges} THEN nextval('library_manual_rank_seq'::regclass) ELSE "manualRank" END,
      pinned = COALESCE(${pinned}::boolean, pinned),
      archived = COALESCE(${archived}::boolean, archived)
    `;
    const filter = sql`AND (NOT ${changedOnly} OR ${locationChanges} OR pinned <> ${pinned}::boolean)`;
    const updated = await tx.$queryRaw<{ id: string }[]>(sql`
      UPDATE "LibraryEntry" SET ${fields}
      WHERE "studySetId" IN ${target} AND "userId" = ${userId} ${filter} RETURNING "studySetId" AS id
    `);
    return updated.length;
  });
}
