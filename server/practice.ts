import type { Database } from "./db";
import { lockSet } from "./setAccess";

export async function markStudied(
  db: Pick<Database, "$queryRaw">,
  userId: string,
  setId: string | null,
  at: Date,
) {
  if (!setId || !(await lockSet(db, setId))) return false;
  const [entry] = await db.$queryRaw<{ studySetId: string }[]>`
    UPDATE "LibraryEntry" SET "lastStudiedAt" = GREATEST("lastStudiedAt", ${at})
    WHERE "studySetId" = ${setId} AND "userId" = ${userId}
    RETURNING "studySetId"
  `;
  return !!entry;
}
