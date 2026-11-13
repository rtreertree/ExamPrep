import type { Database } from "./db";
import type { OwnershipRole } from "../shared/sharing";

export async function markStudied(
  db: Pick<Database, "$queryRaw" | "$executeRaw">,
  userId: string,
  setId: string | null,
  at: Date,
): Promise<OwnershipRole | null> {
  if (!setId) return null;
  const [locked] = await db.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "StudySet" WHERE id = ${setId} FOR NO KEY UPDATE
  `;
  if (!locked) return null;
  if (locked.userId === userId) {
    await db.$executeRaw`
      UPDATE "StudySet" SET "lastStudiedAt" = ${at} WHERE id = ${setId}
      AND ("lastStudiedAt" IS NULL OR "lastStudiedAt" < ${at})
    `;
    return "primary";
  }
  const [member] = await db.$queryRaw<{ studySetId: string }[]>`
    UPDATE "StudySetCoOwner" SET "lastStudiedAt" = GREATEST("lastStudiedAt", ${at})
    WHERE "studySetId" = ${setId} AND "userId" = ${userId}
    RETURNING "studySetId"
  `;
  return member ? "co_owner" : null;
}
