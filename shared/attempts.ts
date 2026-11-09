import { z } from "zod";
import {
  type StudyContent,
  type Question,
  codePoints,
  itemsOf,
} from "./content";
import { ValidationError } from "./json";
export type Status = "in_progress" | "reviewing" | "completed";
export type Response = {
  selectedOptionId?: string;
  text?: string;
  selfAssessment?: "correct" | "incorrect";
  criterionPoints?: Record<string, number>;
  revealed?: boolean;
  rating?: "known" | "review_again";
  flagged?: boolean;
  confidence?: "low" | "medium" | "high";
  note?: string;
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
export const MAX_ANSWER_CHARACTERS = 20_000;
export const MAX_NOTE_CHARACTERS = 4_000;
export const revisionSchema = z.number().int().positive();
export const practiceSettingsSchema = z.strictObject({
  count: z.number().int().min(1).max(500),
  order: z.enum(["original", "shuffled"]),
  timerMinutes: z.number().int().min(1).max(600).nullable(),
});
export type PracticeSettings = z.infer<typeof practiceSettingsSchema>;
export const retryModeSchema = z.enum([
  "mistakes",
  "unreviewed",
  "flagged",
  "low_confidence",
]);
export type RetryMode = z.infer<typeof retryModeSchema>;

export function practiceSnapshot(
  doc: StudyContent,
  preferences: Partial<PracticeSettings>,
  random = Math.random,
) {
  const originalCount = itemsOf(doc).length;
  const settings: PracticeSettings = {
    count: preferences.count ?? originalCount,
    order: preferences.order ?? "original",
    timerMinutes: preferences.timerMinutes ?? null,
  };
  if (settings.count > originalCount)
    invalid("/count", `This set has only ${originalCount} items.`);
  function select<T>(items: T[]) {
    if (settings.order === "original") return items.slice(0, settings.count);
    const ordered = [...items];
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    return ordered.slice(0, settings.count);
  }
  const snapshot =
    doc.kind === "exam"
      ? { ...doc, questions: select(doc.questions) }
      : { ...doc, cards: select(doc.cards) };
  return { settings, snapshot, fullSet: settings.count === originalCount };
}
const objectInput = z
  .unknown()
  .refine(
    (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    "Must be an object.",
  );
export const progressSchema = z.union([
  z.strictObject({
    revision: revisionSchema,
    position: z.number().int().nonnegative(),
    changes: objectInput,
  }),
  // Keep existing v1 API clients working; new clients send bounded deltas.
  z.strictObject({
    revision: revisionSchema,
    position: z.number().int().nonnegative(),
    responses: objectInput,
  }),
]);
export type ResponseChanges = Record<string, Response | null>;
export function responseChanges(
  old: Responses,
  next: Responses,
): ResponseChanges {
  return Object.fromEntries(
    [...new Set([...Object.keys(old), ...Object.keys(next)])]
      .filter((id) => !sameResponse(own(old, id), own(next, id)))
      .map((id) => [id, own(next, id) ?? null]),
  );
}
export function mergeResponses(old: Responses, changes: unknown): Responses {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes))
    invalid("/changes", "Changed answers must be an object.");
  const next = Object.assign(Object.create(null), old);
  for (const [id, value] of Object.entries(changes)) {
    if (value === null) delete next[id];
    else next[id] = value;
  }
  return next;
}
const annotationFields = {
  flagged: z.boolean().optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  note: z
    .string()
    .refine(
      (text) => codePoints(text) <= MAX_NOTE_CHARACTERS,
      "Note exceeds 4,000 characters.",
    )
    .optional(),
};
const choiceResponse = z.strictObject({
  selectedOptionId: z.string().optional(),
  ...annotationFields,
});
const writtenResponse = z.strictObject({
  text: z.string().optional(),
  selfAssessment: z.enum(["correct", "incorrect"]).optional(),
  criterionPoints: objectInput.optional(),
  ...annotationFields,
});
const cardResponse = z.strictObject({
  revealed: z.boolean().optional(),
  rating: z.enum(["known", "review_again"]).optional(),
  ...annotationFields,
});
export const own = <T>(o: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(o, key) ? o[key] : undefined;
function sameAnswer(a?: Response, b?: Response) {
  if (a === b) return true;
  if (
    a?.selectedOptionId !== b?.selectedOptionId ||
    a?.text !== b?.text ||
    a?.selfAssessment !== b?.selfAssessment ||
    a?.revealed !== b?.revealed ||
    a?.rating !== b?.rating
  )
    return false;
  const x = a?.criterionPoints;
  const y = b?.criterionPoints;
  return (
    x === y ||
    (!!x &&
      !!y &&
      Object.keys(x).length === Object.keys(y).length &&
      Object.entries(x).every(([id, points]) => own(y, id) === points))
  );
}
export function sameResponse(a?: Response, b?: Response) {
  return (
    sameAnswer(a, b) &&
    a?.flagged === b?.flagged &&
    a?.confidence === b?.confidence &&
    a?.note === b?.note
  );
}
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
  const items = doc.kind === "exam" ? doc.questions : doc.cards;
  if (!Number.isInteger(position) || position < 0 || position >= items.length)
    invalid("/position", "Position is outside this attempt.");
  if (typeof input !== "object" || input === null || Array.isArray(input))
    invalid("/responses", "Responses must be an object.");
  const result: Responses = Object.create(null);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const [id, value] of Object.entries(input)) {
    const item = byId.get(id);
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
      invalid(
        `/responses/${id}`,
        parsed.error.issues.some((issue) => issue.path[0] === "note")
          ? "A private note must be text of at most 4,000 characters."
          : "Response has invalid or forbidden fields.",
      );
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
        if (
          r.selectedOptionId !== undefined &&
          !item.options.some((o) => o.id === r.selectedOptionId)
        )
          invalid(
            `/responses/${id}`,
            "Option does not belong to this question.",
          );
      } else {
        if (codePoints(r.text ?? "") > MAX_ANSWER_CHARACTERS)
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
          "Submitted answers are frozen. You can change assessments and study notes.",
        );
    }
  }
  if (status === "completed") {
    const changed = Object.keys(responseChanges(old, result));
    if (
      !changed.length ||
      changed.some((id) => !sameAnswer(own(old, id), own(result, id)))
    )
      invalid("/", "Completed answers and scores are read-only.");
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

export function unreviewedCards(
  doc: StudyContent,
  responses: Responses,
): StudyContent | null {
  if (doc.kind !== "flashcards") return null;
  const cards = doc.cards.filter((card) => !own(responses, card.id)?.rating);
  return cards.length ? { ...doc, cards } : null;
}

export function retrySnapshot(
  doc: StudyContent,
  responses: Responses,
  mode: RetryMode,
): StudyContent | null {
  if (mode === "mistakes") return mistakes(doc, responses);
  if (mode === "unreviewed") return unreviewedCards(doc, responses);
  const matches = ({ id }: { id: string }) =>
    mode === "flagged"
      ? own(responses, id)?.flagged === true
      : own(responses, id)?.confidence === "low";
  if (doc.kind === "exam") {
    const questions = doc.questions.filter(matches);
    return questions.length ? { ...doc, questions } : null;
  }
  const cards = doc.cards.filter(matches);
  return cards.length ? { ...doc, cards } : null;
}

/** Validate only changed records; unchanged answers already crossed this boundary. */
export function validateProgressChanges(
  doc: StudyContent,
  status: Status,
  old: Responses,
  changes: unknown,
  position: number,
): Responses {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes))
    invalid("/changes", "Changed answers must be an object.");
  const ids = new Set(
    (doc.kind === "exam" ? doc.questions : doc.cards).map((i) => i.id),
  );
  const before: Responses = Object.create(null),
    after: Responses = Object.create(null);
  for (const [id, value] of Object.entries(changes)) {
    if (!ids.has(id))
      invalid(`/changes/${id}`, "Item does not exist in this snapshot.");
    const previous = own(old, id);
    if (previous) before[id] = previous;
    if (value !== null) after[id] = value as Response;
  }
  const validated = validateProgress(doc, status, before, after, position);
  return mergeResponses(
    old,
    Object.fromEntries(
      Object.keys(changes).map((id) => [id, own(validated, id) ?? null]),
    ),
  );
}
