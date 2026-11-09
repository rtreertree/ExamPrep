import type { Database } from "./db";

export async function markStudied(
  db: Pick<Database, "$executeRaw">,
  userId: string,
  setId: string | null,
  at: Date,
) {
  if (!setId) return;
  await db.$executeRaw`
    UPDATE "StudySet" SET "lastStudiedAt" = ${at}
    WHERE id = ${setId} AND "userId" = ${userId}
      AND ("lastStudiedAt" IS NULL OR "lastStudiedAt" < ${at})
  `;
}
