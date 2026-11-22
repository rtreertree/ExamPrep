import type { BackupReviewSkips, validateBackup } from "../shared/backup";
import type { Card, StudyContent } from "../shared/content";
import type { Database } from "./db";
import { cardFingerprint } from "./spacedReview";
import { decodeStorage } from "./storage";

type Backup = ReturnType<typeof validateBackup>;
type ReviewDb = Pick<Database, "$queryRaw" | "$executeRaw">;

export async function planBackupReviews(
  db: ReviewDb,
  userId: string,
  backup: Backup,
  setIds: Map<string, string>,
  restore: boolean,
) {
  const reviewSkips: BackupReviewSkips = {
    unchanged: 0,
    inaccessible: 0,
    cardMismatch: 0,
  };
  const candidates = [
    ...backup.reviews.map((review) => ({
      ...review,
      studySetId: setIds.get(review.studySetId)!,
      viewer: false,
    })),
    ...backup.viewerReviews.map((review) => ({ ...review, viewer: true })),
  ];
  const owned = candidates.filter(({ viewer }) => !viewer);
  const viewers = candidates.filter(({ viewer }) => viewer);
  if (!candidates.length) return { owned, viewers, reviewSkips };
  const ownedSetIds = new Set(owned.map(({ studySetId }) => studySetId));
  const viewerSetIds = new Set(viewers.map(({ studySetId }) => studySetId));
  const ownedIds = JSON.stringify([...ownedSetIds]);
  let viewerIds = JSON.stringify([...viewerSetIds]);

  // Set edits and grant revocations take this same lock. Read content and access
  // in a fresh statement after locking so a concurrent edit cannot pass preview.
  if (restore) {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM "StudySet" s
      WHERE (s."userId" = ${userId} AND s.id IN (SELECT jsonb_array_elements_text(${ownedIds}::jsonb)))
        OR (s.id IN (SELECT jsonb_array_elements_text(${viewerIds}::jsonb)) AND EXISTS (
          SELECT 1 FROM "StudySetViewer" v WHERE v."studySetId" = s.id AND v."userId" = ${userId}
        ))
      ORDER BY s.id FOR UPDATE OF s`;
    viewerIds = JSON.stringify(
      locked.map(({ id }) => id).filter((id) => viewerSetIds.has(id)),
    );
    await db.$queryRaw`
      SELECT "studySetId" FROM "StudySetViewer" WHERE "userId" = ${userId}
        AND "studySetId" IN (SELECT jsonb_array_elements_text(${viewerIds}::jsonb))
      ORDER BY "studySetId" FOR KEY SHARE`;
  }

  const decks = await db.$queryRaw<
    { id: string; content: StudyContent | null; viewer: boolean }[]
  >`
    SELECT s.id, CASE WHEN s."userId" = ${userId} THEN s.content END AS content, false AS viewer
      FROM "StudySet" s WHERE s.id IN (SELECT jsonb_array_elements_text(${ownedIds}::jsonb))
    UNION ALL
    SELECT s.id, s.content, true AS viewer FROM "StudySetViewer" v JOIN "StudySet" s ON s.id = v."studySetId"
      WHERE v."userId" = ${userId} AND s.kind = 'flashcards'
        AND s.id IN (SELECT jsonb_array_elements_text(${viewerIds}::jsonb))`;
  const deckCards = new Map<string, Map<string, Card> | null>();
  for (const { id, content, viewer } of decks) {
    const deck = decodeStorage(content);
    deckCards.set(
      JSON.stringify([viewer, id]),
      deck?.kind === "flashcards" && Array.isArray(deck.cards)
        ? new Map(deck.cards.map((card) => [card.id, card]))
        : null,
    );
  }
  if (!restore) {
    for (const set of backup.sets) {
      const id = setIds.get(set.id);
      if (!id || !ownedSetIds.has(id) || set.content.kind !== "flashcards")
        continue;
      const key = JSON.stringify([false, id]);
      if (!deckCards.has(key))
        deckCards.set(
          key,
          new Map(set.content.cards.map((card) => [card.id, card])),
        );
    }
  }

  const outcomes = await Promise.all(
    candidates.map(async (review) => {
      const cards = deckCards.get(
        JSON.stringify([review.viewer, review.studySetId]),
      );
      if (!cards) return "inaccessible";
      const card = cards.get(review.cardId);
      return card && (await cardFingerprint(card)) === review.fingerprint
        ? "ready"
        : "cardMismatch";
    }),
  );
  const eligible = candidates.filter((_, i) => {
    const outcome = outcomes[i];
    if (outcome === "ready") return true;
    reviewSkips[outcome]++;
    return false;
  });
  const primary = eligible.filter(({ viewer }) => !viewer);
  const viewer = eligible.filter(({ viewer }) => viewer);

  if (!restore && eligible.length) {
    const [existing] = await db.$queryRaw<{ count: number }[]>`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(eligible)}::jsonb) AS r(
          "studySetId" text, "cardId" text, viewer bool, "attemptStartedAt" timestamp)
      )
      SELECT count(*)::int AS count FROM input i WHERE
        (NOT i.viewer AND EXISTS (SELECT 1 FROM "CardReview" r
          WHERE r."studySetId" = i."studySetId" AND r."cardId" = i."cardId"))
        OR (i.viewer AND EXISTS (SELECT 1 FROM "ViewerCardReview" r
          WHERE r."studySetId" = i."studySetId" AND r."userId" = ${userId}
            AND r."cardId" = i."cardId" AND r."attemptStartedAt" >= i."attemptStartedAt"))`;
    reviewSkips.unchanged = existing.count;
  }
  return { owned: primary, viewers: viewer, reviewSkips };
}

export async function restoreBackupReviews(
  db: ReviewDb,
  userId: string,
  backup: Backup,
  setIds: Map<string, string>,
) {
  const { owned, viewers, reviewSkips } = await planBackupReviews(
    db,
    userId,
    backup,
    setIds,
    true,
  );
  const primaryCount = owned.length
    ? await db.$executeRaw`
    INSERT INTO "CardReview" ("studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt")
    SELECT "studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt"
    FROM jsonb_to_recordset(${JSON.stringify(owned)}::jsonb) AS r(
      "studySetId" text, "cardId" text, fingerprint text, streak int, "dueAt" timestamp, "attemptStartedAt" timestamp)
    ORDER BY "studySetId", "cardId"
    ON CONFLICT ("studySetId", "cardId") DO NOTHING`
    : 0;
  const viewerCount = viewers.length
    ? await db.$executeRaw`
    INSERT INTO "ViewerCardReview" ("studySetId", "userId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt")
    SELECT "studySetId", ${userId}, "cardId", fingerprint, streak, "dueAt", "attemptStartedAt"
    FROM jsonb_to_recordset(${JSON.stringify(viewers)}::jsonb) AS r(
      "studySetId" text, "cardId" text, fingerprint text, streak int, "dueAt" timestamp, "attemptStartedAt" timestamp)
    ORDER BY "studySetId", "cardId"
    ON CONFLICT ("studySetId", "userId", "cardId") DO UPDATE SET
      fingerprint = EXCLUDED.fingerprint, streak = EXCLUDED.streak,
      "dueAt" = EXCLUDED."dueAt", "attemptStartedAt" = EXCLUDED."attemptStartedAt"
    WHERE "ViewerCardReview"."attemptStartedAt" < EXCLUDED."attemptStartedAt"`
    : 0;
  const reviewCount = primaryCount + viewerCount;
  reviewSkips.unchanged = owned.length + viewers.length - reviewCount;
  return { reviewCount, reviewSkips };
}
