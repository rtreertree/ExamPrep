import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import type { StudySet } from "../generated/prisma/client";
import type { OwnershipRole } from "../shared/sharing";
import type { SetOrganization } from "../shared/listing";
import type { Database } from "./db";
import { encodeStorage } from "./storage";
import { folderForLegacyName, lockLibrary, readFolder } from "./libraryOrder";

type QueryDb = Pick<Database, "$queryRaw">;
export type LibrarySet = Omit<StudySet, "manualRank" | "published"> & {
  ownershipRole: OwnershipRole;
  folderName: string | null;
  ownerName: string;
};

export const unavailableSet = () =>
  new HTTPException(404, { message: "This study set is unavailable." });

// These projections use s for the set and co for the requesting user's membership.
export const joinMembership = (userId: string) => sql`
  LEFT JOIN "LibraryMembership" co ON co."studySetId" = s.id AND co."userId" = ${userId}
`;
export const libraryAccess = (userId: string) =>
  sql`(s."userId" = ${userId} OR co."userId" IS NOT NULL)`;
export const librarySetIds = (userId: string) => sql`(
  SELECT id FROM "StudySet" WHERE "userId" = ${userId}
  UNION
  SELECT "studySetId" FROM "LibraryMembership" WHERE "userId" = ${userId}
)`;
export const ownershipRole = sql`
  COALESCE(co.role, 'primary') AS "ownershipRole"
`;
export const ownerFolderId = sql`CASE WHEN co."userId" IS NULL THEN s."folderId" ELSE co."folderId" END`;
export const ownerRank = sql`COALESCE(co."manualRank", s."manualRank")`;
export const ownerLastStudiedAt = sql`CASE WHEN co."userId" IS NULL THEN s."lastStudiedAt" ELSE co."lastStudiedAt" END`;
export const ownerPreferences = sql`
  f.name AS "folderName",
  COALESCE(f.name, '') AS course,
  ${ownerFolderId} AS "folderId",
  COALESCE(co.pinned, s.pinned) AS pinned,
  COALESCE(co.archived, s.archived) AS archived,
  ${ownerLastStudiedAt} AS "lastStudiedAt",
  COALESCE(co."reviewLimit", s."reviewLimit") AS "reviewLimit"
`;
export const joinOwnerFolder = sql`
  LEFT JOIN "LibraryFolder" f ON f.id = (${ownerFolderId})
`;

export async function readLibrarySet(db: QueryDb, id: string, userId: string) {
  const [set] = await db.$queryRaw<LibrarySet[]>(sql`
    SELECT s.id, s."userId", s.title, s.kind, s.content, s.revision, s."createdAt",
      u.name AS "ownerName", s."updatedAt", ${ownershipRole}, ${ownerPreferences}
    FROM "StudySet" s JOIN "user" u ON u.id = s."userId" ${joinMembership(userId)} ${joinOwnerFolder}
    WHERE s.id = ${id} AND ${libraryAccess(userId)}
  `);
  if (!set) throw unavailableSet();
  return set;
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
    SELECT s.id FROM "StudySet" s ${joinMembership(userId)}
    WHERE s.id = ${id} AND ${libraryAccess(userId)} FOR NO KEY UPDATE OF s
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
      SELECT s.id FROM "StudySet" s ${joinMembership(userId)}
      WHERE s.id IN ${target} AND ${libraryAccess(userId)}
      ORDER BY s.id FOR NO KEY UPDATE OF s
    `);
    if (locked.length !== ids.length) throw unavailableSet();
    const owned = await tx.$queryRaw<{ id: string }[]>(sql`
      SELECT s.id FROM "StudySet" s ${joinMembership(userId)}
      WHERE s.id IN ${target} AND ${libraryAccess(userId)}
    `);
    if (owned.length !== ids.length) throw unavailableSet();
    const movesFolder =
      changes.folderId !== undefined || changes.course !== undefined;
    const folder = changes.folderId
      ? await readFolder(tx, userId, changes.folderId)
      : undefined;
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
      course = CASE WHEN ${movesFolder} THEN ${folder?.name ?? course ?? ""} ELSE course END,
      "folderId" = CASE WHEN ${movesFolder} THEN ${folderId}::text ELSE "folderId" END,
      "manualRank" = CASE WHEN ${locationChanges} THEN nextval('library_manual_rank_seq'::regclass) ELSE "manualRank" END,
      pinned = COALESCE(${pinned}::boolean, pinned),
      archived = COALESCE(${archived}::boolean, archived)
    `;
    const filter = sql`AND (NOT ${changedOnly} OR ${locationChanges} OR pinned <> ${pinned}::boolean)`;
    const primary = await tx.$queryRaw<{ id: string }[]>(sql`
      UPDATE "StudySet" SET ${fields}
      WHERE id IN ${target} AND "userId" = ${userId} ${filter} RETURNING id
    `);
    const coOwned = await tx.$queryRaw<{ id: string }[]>(sql`
      UPDATE "StudySetCoOwner" SET ${fields}
      WHERE "studySetId" IN ${target} AND "userId" = ${userId} ${filter} RETURNING "studySetId" AS id
    `);
    const viewers = await tx.$queryRaw<{ id: string }[]>(sql`
      UPDATE "StudySetViewer" SET ${fields}
      WHERE "studySetId" IN ${target} AND "userId" = ${userId} ${filter} RETURNING "studySetId" AS id
    `);
    return primary.length + coOwned.length + viewers.length;
  });
}
