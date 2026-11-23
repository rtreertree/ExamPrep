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
    ...backup.reviews.flatMap((review) => {
      const studySetId = setIds.get(review.studySetId);
      if (!studySetId) {
        reviewSkips.inaccessible++;
        return [];
      }
      return [{ ...review, studySetId, viewer: false }];
    }),
    ...backup.viewerReviews.map((review) => ({ ...review, viewer: true })),
  ];
  if (!candidates.length) return { eligible: [], reviewSkips };
  const ownedIds = JSON.stringify([
    ...new Set(candidates.filter((r) => !r.viewer).map((r) => r.studySetId)),
  ]);
  const viewerIds = JSON.stringify([
    ...new Set(backup.viewerReviews.map((r) => r.studySetId)),
  ]);
  const decks = await db.$queryRaw<
    { id: string; content: StudyContent; viewer: boolean }[]
  >`
    SELECT s.id, s.content, s."userId" <> ${userId} AS viewer
    FROM "LibraryEntry" e JOIN "StudySet" s ON s.id = e."studySetId"
    WHERE e."userId" = ${userId}
      AND ((s."userId" = ${userId} AND s.id IN (SELECT jsonb_array_elements_text(${ownedIds}::jsonb)))
        OR (s."userId" <> ${userId} AND NOT e."coOwner"
          AND s.id IN (SELECT jsonb_array_elements_text(${viewerIds}::jsonb))))
  `;
  const deckKey = (viewer: boolean, id: string) => JSON.stringify([viewer, id]);
  const cardsByDeck = new Map<string, Map<string, Card> | null>();
  for (const { id, content, viewer } of decks) {
    const deck = decodeStorage(content);
    cardsByDeck.set(
      deckKey(viewer, id),
      deck.kind === "flashcards"
        ? new Map(deck.cards.map((card) => [card.id, card]))
        : null,
    );
  }
  if (!restore) {
    const scheduled = new Set(
      backup.reviews.map(({ studySetId }) => studySetId),
    );
    for (const { id, content } of backup.sets) {
      const destination = setIds.get(id);
      if (!destination || !scheduled.has(id) || content.kind !== "flashcards")
        continue;
      const key = deckKey(false, destination);
      if (!cardsByDeck.has(key))
        cardsByDeck.set(
          key,
          new Map(content.cards.map((card) => [card.id, card])),
        );
    }
  }
  const outcomes = await Promise.all(
    candidates.map(async (review) => {
      const cards = cardsByDeck.get(deckKey(review.viewer, review.studySetId));
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

  if (!restore && eligible.length) {
    const [existing] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM jsonb_to_recordset(${JSON.stringify(eligible)}::jsonb) AS i(
        "studySetId" text, "cardId" text, viewer bool, "attemptStartedAt" timestamp)
      JOIN "CardReview" r USING ("studySetId", "cardId")
      WHERE r."userId" = ${userId} AND (NOT i.viewer OR r."attemptStartedAt" >= i."attemptStartedAt")`;
    reviewSkips.unchanged = existing.count;
  }
  return { eligible, reviewSkips };
}

export async function restoreBackupReviews(
  db: ReviewDb,
  userId: string,
  backup: Backup,
  setIds: Map<string, string>,
) {
  const { eligible, reviewSkips } = await planBackupReviews(
    db,
    userId,
    backup,
    setIds,
    true,
  );
  const reviewCount = eligible.length
    ? await db.$executeRaw`
      INSERT INTO "CardReview" ("userId", "studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt")
      SELECT ${userId}, "studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt"
      FROM jsonb_to_recordset(${JSON.stringify(eligible)}::jsonb) AS r(
        "studySetId" text, "cardId" text, fingerprint text, streak int, "dueAt" timestamp, "attemptStartedAt" timestamp)
      ORDER BY "studySetId", "cardId"
      ON CONFLICT ("userId", "studySetId", "cardId") DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint, streak = EXCLUDED.streak,
        "dueAt" = EXCLUDED."dueAt", "attemptStartedAt" = EXCLUDED."attemptStartedAt"
      WHERE "CardReview"."attemptStartedAt" < EXCLUDED."attemptStartedAt"
        AND EXISTS (SELECT 1 FROM "StudySet" s WHERE s.id = EXCLUDED."studySetId" AND s."userId" <> ${userId})`
    : 0;
  reviewSkips.unchanged = eligible.length - reviewCount;
  return { reviewCount, reviewSkips };
}
