import { z } from "zod";
import { type StudyContent, type Question, codePoints } from "./content";
import { ValidationError } from "./json";
export type Status = "in_progress" | "reviewing" | "completed";
export type Response = {
  selectedOptionId?: string;
  text?: string;
  selfAssessment?: "correct" | "incorrect";
  criterionPoints?: Record<string, number>;
  revealed?: boolean;
  rating?: "known" | "review_again";
};
export type Responses = Record<string, Response>;
export type Category = {
  earnedPoints: number;
  maxPoints: number;
  pendingCount: number;
};
export type Result = {
  automatic?: Category;
  selfAssessed?: Category;
  known?: number;
  reviewAgain?: number;
  unreviewed?: number;
};
export const revisionSchema = z.number().int().positive();
const objectInput = z
  .unknown()
  .refine(
    (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    "Must be an object.",
  );
export const progressSchema = z.strictObject({
  revision: revisionSchema,
  position: z.number().int().nonnegative(),
  responses: objectInput,
});
const choiceResponse = z.strictObject({ selectedOptionId: z.string() });
const writtenResponse = z.strictObject({
  text: z.string(),
  selfAssessment: z.enum(["correct", "incorrect"]).optional(),
  criterionPoints: objectInput.optional(),
});
const cardResponse = z.strictObject({
  revealed: z.boolean(),
  rating: z.enum(["known", "review_again"]).optional(),
});
export const own = <T>(o: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(o, key) ? o[key] : undefined;
function invalid(path: string, message: string): never {
  throw new ValidationError([{ path, message }]);
}
export const answered = (q: Question, r?: Response) =>
  q.type === "single_choice" ? !!r?.selectedOptionId : !!r?.text?.trim();
export const maximum = (q: Question) =>
  q.type === "written" && q.rubric
    ? q.rubric.reduce((n, c) => n + c.points, 0)
    : 1;
export function writtenScore(q: Question, r?: Response): number | null {
  if (!answered(q, r)) return 0;
  if (q.type !== "written") return 0;
  if (!q.rubric)
    return r?.selfAssessment === undefined
      ? null
      : Number(r.selfAssessment === "correct");
  if (
    !q.rubric.every(
      (c) => r?.criterionPoints && own(r.criterionPoints, c.id) !== undefined,
    )
  )
    return null;
  return q.rubric.reduce((n, c) => n + own(r!.criterionPoints!, c.id)!, 0);
}
export function validateProgress(
  doc: StudyContent,
  status: Status,
  old: Responses,
  input: unknown,
  position: number,
): Responses {
  if (status === "completed") invalid("/", "Completed attempts are read-only.");
  const items = doc.kind === "exam" ? doc.questions : doc.cards;
  if (!Number.isInteger(position) || position < 0 || position >= items.length)
    invalid("/position", "Position is outside this attempt.");
  if (typeof input !== "object" || input === null || Array.isArray(input))
    invalid("/responses", "Responses must be an object.");
  const result: Responses = Object.create(null);
  for (const [id, value] of Object.entries(input)) {
    const item = items.find((item) => item.id === id);
    if (!item)
      invalid(`/responses/${id}`, "Item does not exist in this snapshot.");
    const schema =
      doc.kind === "flashcards"
        ? cardResponse
        : "type" in item && item.type === "single_choice"
          ? choiceResponse
          : writtenResponse;
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      invalid(`/responses/${id}`, "Response has invalid or forbidden fields.");
    const r = parsed.data as Response;
    // Zod records discard __proto__; preserve every contract-valid ID explicitly.
    if (r.criterionPoints !== undefined) {
      const awards: Record<string, number> = Object.create(null);
      for (const [key, points] of Object.entries(r.criterionPoints)) {
        if (
          typeof points !== "number" ||
          !Number.isInteger(points) ||
          points < 0
        )
          invalid(
            `/responses/${id}/criterionPoints/${key}`,
            "Award must be a nonnegative whole number.",
          );
        awards[key] = points;
      }
      r.criterionPoints = awards;
    }
    if (doc.kind === "flashcards") {
      if (r.rating && !r.revealed)
        invalid(`/responses/${id}/rating`, "Reveal the card before rating it.");
      if (own(old, id)?.revealed && !r.revealed)
        invalid(
          `/responses/${id}/revealed`,
          "A revealed card cannot become unrevealed.",
        );
    } else if ("type" in item) {
      if (item.type === "single_choice") {
        if (!item.options.some((o) => o.id === r.selectedOptionId))
          invalid(
            `/responses/${id}`,
            "Option does not belong to this question.",
          );
      } else {
        if (codePoints(r.text!) > 20000)
          invalid(`/responses/${id}/text`, "Answer exceeds 20,000 characters.");
        if (
          status === "in_progress" &&
          (r.selfAssessment !== undefined || r.criterionPoints !== undefined)
        )
          invalid(
            `/responses/${id}`,
            "Self-assessment is available after submission.",
          );
        if (r.selfAssessment !== undefined && r.criterionPoints !== undefined)
          invalid(`/responses/${id}`, "Use only one assessment form.");
        if (item.rubric) {
          if (r.selfAssessment !== undefined)
            invalid(
              `/responses/${id}`,
              "Rubric questions require criterion points.",
            );
          for (const [key, points] of Object.entries(r.criterionPoints ?? {})) {
            const c = item.rubric.find((c) => c.id === key);
            if (!c || points > c.points)
              invalid(
                `/responses/${id}/criterionPoints/${key}`,
                "Award must be a whole number within the criterion maximum.",
              );
          }
        } else if (r.criterionPoints !== undefined)
          invalid(`/responses/${id}`, "This question has no rubric.");
        if (
          !answered(item, r) &&
          (r.selfAssessment !== undefined || r.criterionPoints !== undefined)
        )
          invalid(
            `/responses/${id}`,
            "Unanswered written questions receive zero automatically.",
          );
      }
    }
    result[id] = r;
  }
  if (doc.kind === "flashcards")
    for (const [id, r] of Object.entries(old))
      if (r.revealed && !own(result, id)?.revealed)
        invalid(`/responses/${id}`, "Revealed progress cannot be removed.");
  if (status === "reviewing" && doc.kind === "exam") {
    for (const q of doc.questions) {
      const a = own(old, q.id),
        b = own(result, q.id);
      if (
        q.type === "single_choice"
          ? a?.selectedOptionId !== b?.selectedOptionId
          : a?.text !== b?.text
      )
        invalid(
          `/responses/${q.id}`,
          "Submitted answers are frozen. Only self-assessment may change.",
        );
    }
  }
  return result;
}
export function grade(
  doc: StudyContent,
  responses: Responses,
): { status: Status; result: Result } {
  if (doc.kind === "flashcards") {
    const ratings = doc.cards.map((c) => own(responses, c.id)?.rating);
    return {
      status: "completed",
      result: {
        known: ratings.filter((r) => r === "known").length,
        reviewAgain: ratings.filter((r) => r === "review_again").length,
        unreviewed: ratings.filter((r) => r === undefined).length,
      },
    };
  }
  const result: Result = {};
  let pending = 0;
  for (const q of doc.questions) {
    const key = q.type === "single_choice" ? "automatic" : "selfAssessed";
    const cat = (result[key] ??= {
      earnedPoints: 0,
      maxPoints: 0,
      pendingCount: 0,
    });
    cat.maxPoints += maximum(q);
    const r = own(responses, q.id);
    const score =
      q.type === "single_choice"
        ? Number(r?.selectedOptionId === q.answer)
        : writtenScore(q, r);
    if (score === null) {
      cat.pendingCount++;
      pending++;
    } else cat.earnedPoints += score;
  }
  return { status: pending ? "reviewing" : "completed", result };
}
export function mistakes(
  doc: StudyContent,
  responses: Responses,
): StudyContent | null {
  if (doc.kind === "flashcards") {
    const cards = doc.cards.filter(
      (c) => own(responses, c.id)?.rating === "review_again",
    );
    return cards.length ? { ...doc, cards } : null;
  }
  const questions = doc.questions.filter((q) =>
    q.type === "single_choice"
      ? own(responses, q.id)?.selectedOptionId !== q.answer
      : (writtenScore(q, own(responses, q.id)) ?? 0) < maximum(q),
  );
  return questions.length ? { ...doc, questions } : null;
}
