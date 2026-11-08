import type { Database } from "./db";
import type { Attempt } from "../generated/prisma/client";
import { z } from "zod";
import { contentId, type StudyContent } from "../shared/content";

// Private database format, independent of the unchanged portable v1 contract.
// Only created after full validation at the immutable snapshot boundary.
export const SNAPSHOT_VERSION = 1;
export function progressContent(doc: StudyContent): StudyContent {
  const base = { schemaVersion: 1 as const, title: "Snapshot", kind: doc.kind };
  return doc.kind === "exam"
    ? {
        ...base,
        kind: "exam",
        questions: doc.questions.map((q) =>
          q.type === "single_choice"
            ? {
                id: q.id,
                type: q.type,
                prompt: "",
                answer: q.answer,
                options: q.options.map((o) => ({ id: o.id, text: "" })),
              }
            : {
                id: q.id,
                type: q.type,
                prompt: "",
                answer: "",
                ...(q.rubric
                  ? {
                      rubric: q.rubric.map((c) => ({
                        id: c.id,
                        points: c.points,
                        description: "",
                      })),
                    }
                  : {}),
              },
        ),
      }
    : {
        ...base,
        kind: "flashcards",
        cards: doc.cards.map((c) => ({ id: c.id, front: "", back: "" })),
      };
}
const blank = z.literal("");
const rulesSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    title: z.literal("Snapshot"),
    kind: z.literal("exam"),
    questions: z
      .array(
        z.discriminatedUnion("type", [
          z.strictObject({
            id: contentId,
            type: z.literal("single_choice"),
            prompt: blank,
            answer: contentId,
            options: z
              .array(z.strictObject({ id: contentId, text: blank }))
              .min(2)
              .max(6),
          }),
          z.strictObject({
            id: contentId,
            type: z.literal("written"),
            prompt: blank,
            answer: blank,
            rubric: z
              .array(
                z.strictObject({
                  id: contentId,
                  points: z.number().int().min(1).max(100),
                  description: blank,
                }),
              )
              .min(1)
              .max(20)
              .optional(),
          }),
        ]),
      )
      .min(1)
      .max(500),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    title: z.literal("Snapshot"),
    kind: z.literal("flashcards"),
    cards: z
      .array(z.strictObject({ id: contentId, front: blank, back: blank }))
      .min(1)
      .max(500),
  }),
]);
export const readProgressContent = (value: unknown): StudyContent =>
  rulesSchema.parse(value);
export async function readAttemptProgress(
  db: Pick<Database, "$queryRaw">,
  id: string,
  userId: string,
) {
  const rows = await db.$queryRaw<Omit<Attempt, "snapshot">[]>`
    SELECT id, "userId", "studySetId", "sourceAttemptId", status, position, result,
      revision, "startedAt", "updatedAt", "completedAt", responses, "snapshotVersion", "progressContent"
    FROM "Attempt" WHERE id = ${id} AND "userId" = ${userId}`;
  return rows[0];
}
export function metadataOnly(attempt: Omit<Attempt, "snapshot">) {
  const { responses, progressContent, snapshotVersion, ...metadata } = attempt;
  return metadata;
}
