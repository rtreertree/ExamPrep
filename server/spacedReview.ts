import { HTTPException } from "hono/http-exception";
import type { Attempt, Prisma } from "../generated/prisma/client";
import { own, type Response, type Responses } from "../shared/attempts";
import { validateContent, type Card } from "../shared/content";
import type { ReviewQueue } from "../shared/spacedReview";
import type { Database } from "./db";
import { markStudied } from "./practice";
import { progressContent, SNAPSHOT_VERSION } from "./snapshots";
import { decodeStorage, encodeStorage } from "./storage";

type ReviewDb = Pick<Database, "$queryRaw" | "studySet" | "attempt">;
const day = 24 * 60 * 60 * 1000;
const successIntervals = [1, 3, 7, 14, 30];
const unavailable = () =>
  new HTTPException(404, { message: "This flashcard set is unavailable." });
const json = (value: unknown) => encodeStorage(value) as Prisma.InputJsonValue;

export async function cardFingerprint(card: Card) {
  const input = new TextEncoder().encode(
    JSON.stringify([card.front, card.back]),
  );
  const bytes = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function nextCardReview(
  previousStreak: number,
  rating: NonNullable<Response["rating"]>,
  at: Date,
) {
  const streak =
    rating === "known"
      ? Math.min(previousStreak + 1, successIntervals.length)
      : 0;
  const interval = streak ? successIntervals[streak - 1] : 1;
  return { streak, dueAt: new Date(at.getTime() + interval * day) };
}

export async function lockReviewDeck(
  db: Pick<ReviewDb, "$queryRaw">,
  userId: string,
  setId: string,
) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "StudySet" WHERE id = ${setId} AND "userId" = ${userId} FOR UPDATE
  `;
  return rows.length > 0;
}

async function activeReview(
  db: Pick<ReviewDb, "$queryRaw">,
  userId: string,
  setId: string,
) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Attempt" WHERE "userId" = ${userId} AND "studySetId" = ${setId}
      AND "reviewMode" AND status = 'in_progress' ORDER BY "startedAt" DESC, id LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function recordSpacedReview(
  db: ReviewDb,
  attempt: Attempt,
  completedAt: Date,
) {
  const { userId, studySetId, startedAt } = attempt;
  if (
    !attempt.reviewMode ||
    !studySetId ||
    !(await lockReviewDeck(db, userId, studySetId))
  )
    return;
  const snapshot = validateContent(decodeStorage(attempt.snapshot));
  if (snapshot.kind !== "flashcards") return;
  const responses = decodeStorage(attempt.responses) as Responses;
  const rated = snapshot.cards.flatMap((card) => {
    const rating = own(responses, card.id)?.rating;
    return rating ? [{ card, rating }] : [];
  });
  if (!rated.length) return;
  const existing = new Map(
    (
      await db.$queryRaw<
        { cardId: string; streak: number; fingerprint: string }[]
      >`
    SELECT "cardId", streak, fingerprint FROM "CardReview" WHERE "studySetId" = ${studySetId}
  `
    ).map((row) => [row.cardId, row]),
  );
  const updates = await Promise.all(
    rated.map(async ({ card, rating }) => {
      const fingerprint = await cardFingerprint(card);
      const previous = existing.get(card.id);
      return {
        cardId: card.id,
        fingerprint,
        ...nextCardReview(
          previous?.fingerprint === fingerprint ? previous.streak : 0,
          rating,
          completedAt,
        ),
      };
    }),
  );
  await db.$queryRaw`
    INSERT INTO "CardReview" ("studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt")
    SELECT ${studySetId}, u."cardId", u.fingerprint, u.streak, u."dueAt", ${startedAt}
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS u("cardId" text, fingerprint text, streak int, "dueAt" timestamp)
    ON CONFLICT ("studySetId", "cardId") DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
      streak = EXCLUDED.streak, "dueAt" = EXCLUDED."dueAt", "attemptStartedAt" = EXCLUDED."attemptStartedAt"
    WHERE "CardReview"."attemptStartedAt" < EXCLUDED."attemptStartedAt"
    RETURNING "cardId"
  `;
}

async function planReview(
  db: ReviewDb,
  userId: string,
  setId: string,
  now: Date,
) {
  const set = await db.studySet.findFirst({
    where: { id: setId, userId, kind: "flashcards" },
  });
  if (!set) throw unavailable();
  const doc = validateContent(decodeStorage(set.content));
  if (doc.kind !== "flashcards") throw unavailable();
  const today = new Date(Math.floor(now.getTime() / day) * day);
  const tomorrow = new Date(today.getTime() + day);
  const [schedules, counted, activeAttemptId] = await Promise.all([
    db.$queryRaw<{ cardId: string; fingerprint: string; dueAt: Date }[]>`
      SELECT "cardId", fingerprint, "dueAt" FROM "CardReview" WHERE "studySetId" = ${setId}
    `,
    db.$queryRaw<{ count: number }[]>`
      SELECT COALESCE(SUM(COALESCE((result->>'known')::int, 0)
        + COALESCE((result->>'reviewAgain')::int, 0)), 0)::int AS count FROM "Attempt"
      WHERE "userId" = ${userId} AND "studySetId" = ${setId} AND "reviewMode"
        AND status = 'completed' AND "completedAt" >= ${today} AND "completedAt" < ${tomorrow}
    `,
    activeReview(db, userId, setId),
  ]);
  const schedulesById = new Map(schedules.map((row) => [row.cardId, row]));
  const cards = await Promise.all(
    doc.cards.map(async (card) => {
      const previous = schedulesById.get(card.id);
      const scheduled =
        previous && previous.fingerprint === (await cardFingerprint(card))
          ? previous.dueAt
          : null;
      return { card, scheduled };
    }),
  );
  const due = cards
    .filter(({ scheduled }) => !scheduled || scheduled <= now)
    .sort(
      (a, b) =>
        (a.scheduled?.getTime() ?? now.getTime()) -
        (b.scheduled?.getTime() ?? now.getTime()),
    );
  const reviewedToday = counted[0]?.count ?? 0;
  const available = Math.max(
    0,
    Math.min(due.length, set.reviewLimit - reviewedToday),
  );
  const queue: ReviewQueue = {
    title: doc.title,
    limit: set.reviewLimit,
    reviewedToday,
    due: due.length,
    available: set.archived ? 0 : available,
    activeAttemptId,
    archived: set.archived,
    resetsAt: tomorrow.toISOString(),
    cards: cards.map(({ card, scheduled }) => ({
      id: card.id,
      front:
        [...card.front].slice(0, 240).join("") +
        ([...card.front].length > 240 ? "…" : ""),
      due: !scheduled || scheduled <= now,
      nextReviewAt: scheduled?.toISOString() ?? null,
    })),
  };
  return { queue, due, doc, revision: set.revision };
}

export async function readReviewQueue(
  db: ReviewDb,
  userId: string,
  setId: string,
) {
  return (await planReview(db, userId, setId, new Date())).queue;
}

export async function changeReviewLimit(
  db: Database,
  userId: string,
  setId: string,
  limit: number,
) {
  return db.$transaction(async (tx) => {
    if (!(await lockReviewDeck(tx, userId, setId))) throw unavailable();
    if (await activeReview(tx, userId, setId))
      throw new HTTPException(409, {
        message:
          "Finish the open review session before changing its daily limit.",
      });
    const updated = await tx.studySet.updateMany({
      where: { id: setId, userId, kind: "flashcards" },
      data: { reviewLimit: limit },
    });
    if (!updated.count) throw unavailable();
    return (await planReview(tx, userId, setId, new Date())).queue;
  });
}

export async function startSpacedReview(
  db: Database,
  userId: string,
  setId: string,
) {
  return db.$transaction(async (tx) => {
    if (!(await lockReviewDeck(tx, userId, setId))) throw unavailable();
    const now = new Date();
    const { queue, due, doc, revision } = await planReview(
      tx,
      userId,
      setId,
      now,
    );
    if (queue.activeAttemptId)
      return { id: queue.activeAttemptId, started: false };
    if (!queue.available)
      throw new HTTPException(409, {
        message: queue.archived
          ? "Restore this deck from the archive to start spaced review."
          : "No cards are available for spaced review right now.",
      });
    const snapshot = {
      ...doc,
      cards: due.slice(0, queue.available).map(({ card }) => card),
    };
    const attempt = await tx.attempt.create({
      data: {
        userId,
        studySetId: setId,
        studySetRevision: revision,
        reviewMode: true,
        fullSet: false,
        startedAt: now,
        settings: {
          count: snapshot.cards.length,
          order: "original",
          timerMinutes: null,
        },
        snapshot: json(snapshot),
        snapshotVersion: SNAPSHOT_VERSION,
        progressContent: json(progressContent(snapshot)),
      },
    });
    await markStudied(tx, userId, setId, now);
    return { id: attempt.id, started: true };
  });
}
