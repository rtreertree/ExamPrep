import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseContent } from "../shared/content";
import {
  grade,
  mistakes,
  unreviewedCards,
  validateProgress,
  type Responses,
} from "../shared/attempts";
const exam = parseContent(
  readFileSync("public/downloads/example-exam.examprep.json", "utf8"),
);
const deck = parseContent(
  readFileSync("public/downloads/example-flashcards.examprep.json", "utf8"),
);
const responses: Responses = {
  q1: { selectedOptionId: "b" },
  q2: { text: "Power rule working", criterionPoints: { rule: 1, result: 2 } },
  q3: { text: "0", selfAssessment: "correct" },
};
describe("grading and state rules", () => {
  it("studies only unrated cards, including revealed cards, preserving their content and order", () => {
    if (deck.kind !== "flashcards") throw new Error("Expected deck");
    expect(unreviewedCards(deck, { c1: { revealed: true } })).toEqual(deck);
    const responses: Responses = { c1: { revealed: true, rating: "known" } };
    expect(unreviewedCards(deck, responses)).toEqual({
      ...deck,
      cards: [deck.cards[1]],
    });
    responses.c1.rating = "review_again";
    expect(unreviewedCards(deck, responses)).toEqual({
      ...deck,
      cards: [deck.cards[1]],
    });
    responses.c2 = { revealed: true, rating: "known" };
    expect(unreviewedCards(deck, responses)).toBeNull();
    expect(unreviewedCards(exam, {})).toBeNull();
  });
  it("keeps automatic 1/1 separate from self-assessed 4/6", () => {
    expect(grade(exam, responses)).toEqual({
      status: "completed",
      result: {
        automatic: { earnedPoints: 1, maxPoints: 1, pendingCount: 0 },
        selfAssessed: { earnedPoints: 4, maxPoints: 6, pendingCount: 0 },
      },
    });
  });
  it("selects only the 3/5 rubric question, preserving IDs/rubric/order", () => {
    const subset = mistakes(exam, responses);
    expect(subset?.kind).toBe("exam");
    if (subset?.kind === "exam" && exam.kind === "exam")
      expect(subset.questions).toEqual([exam.questions[1]]);
  });
  it("unanswered written questions receive zero without pending review", () => {
    expect(grade(exam, {}).status).toBe("completed");
    expect(grade(exam, {}).result.selfAssessed).toEqual({
      earnedPoints: 0,
      maxPoints: 6,
      pendingCount: 0,
    });
  });
  it("missing is pending, explicit all-zero assessment is completed", () => {
    expect(
      grade(exam, { q2: { text: "x", criterionPoints: { rule: 0 } } }).status,
    ).toBe("reviewing");
    expect(
      grade(exam, {
        q2: { text: "x", criterionPoints: { rule: 0, result: 0 } },
      }).status,
    ).toBe("completed");
  });
  it("keeps partial assessment pending and its full denominator", () => {
    expect(
      grade(exam, { q2: { text: "x", criterionPoints: { rule: 2 } } }).result
        .selfAssessed,
    ).toEqual({ earnedPoints: 0, maxPoints: 6, pendingCount: 1 });
  });
  it("returns no mistakes after a fully correct exam", () => {
    expect(
      mistakes(exam, {
        ...responses,
        q2: { text: "x", criterionPoints: { rule: 2, result: 3 } },
      }),
    ).toBeNull();
  });
  it("deck counts total its cards and excludes Known/Unreviewed from retries", () => {
    const r: Responses = {
      c1: { revealed: true, rating: "review_again" },
      c2: { revealed: true, rating: "known" },
    };
    expect(grade(deck, r).result).toEqual({
      known: 1,
      reviewAgain: 1,
      unreviewed: 0,
    });
    const retry = mistakes(deck, r);
    expect(
      retry?.kind === "flashcards" && retry.cards.map((c) => c.id),
    ).toEqual(["c1"]);
    expect(mistakes(deck, {})).toBeNull();
  });
  it.each([
    { nope: { text: "x" } },
    { q1: { selectedOptionId: "missing" } },
    { q1: { selectedOptionId: "b", points: 4 } },
    { q2: { text: "x", selfAssessment: "correct" } },
  ])("rejects invalid in-progress responses %j", (r) =>
    expect(() => validateProgress(exam, "in_progress", {}, r, 0)).toThrow(),
  );
  it.each([{ rule: 3 }, { result: -1 }, { result: 1.5 }, { unknown: 0 }])(
    "rejects invalid rubric awards %j",
    (criterionPoints) =>
      expect(() =>
        validateProgress(
          exam,
          "reviewing",
          { q2: { text: "x" } },
          { q2: { text: "x", criterionPoints } },
          0,
        ),
      ).toThrow(),
  );
  it("rejects both grading forms and rubric awards for binary questions", () => {
    expect(() =>
      validateProgress(
        exam,
        "reviewing",
        { q2: { text: "x" } },
        { q2: { text: "x", selfAssessment: "correct", criterionPoints: {} } },
        0,
      ),
    ).toThrow();
    expect(() =>
      validateProgress(
        exam,
        "reviewing",
        { q3: { text: "x" } },
        { q3: { text: "x", criterionPoints: {} } },
        0,
      ),
    ).toThrow();
  });
  it("freezes submitted answers and rejects no-op updates after completion", () => {
    expect(() =>
      validateProgress(
        exam,
        "reviewing",
        { q2: { text: "frozen" } },
        { q2: { text: "changed" } },
        0,
      ),
    ).toThrow("frozen");
    expect(() =>
      validateProgress(
        exam,
        "reviewing",
        { q1: { selectedOptionId: "a" } },
        {},
        0,
      ),
    ).toThrow("frozen");
    expect(() => validateProgress(exam, "completed", {}, {}, 0)).toThrow(
      "read-only",
    );
  });
  it("validates position, response length, and reveal-before-rating", () => {
    for (const p of [-1, 0.5, 3])
      expect(() => validateProgress(exam, "in_progress", {}, {}, p)).toThrow();
    expect(() =>
      validateProgress(
        exam,
        "in_progress",
        {},
        { q2: { text: "🦊".repeat(20001) } },
        0,
      ),
    ).toThrow();
    expect(() =>
      validateProgress(
        deck,
        "in_progress",
        {},
        { c1: { revealed: false, rating: "known" } },
        0,
      ),
    ).toThrow();
  });
  it("preserves revealed state and supports prototype-like IDs safely", () => {
    expect(() =>
      validateProgress(deck, "in_progress", { c1: { revealed: true } }, {}, 0),
    ).toThrow();
    const doc = {
      schemaVersion: 1 as const,
      kind: "flashcards" as const,
      title: "x",
      cards: [{ id: "__proto__", front: "x", back: "y" }],
    };
    const r = JSON.parse('{"__proto__":{"revealed":true,"rating":"known"}}');
    expect(
      grade(doc, validateProgress(doc, "in_progress", {}, r, 0)).result.known,
    ).toBe(1);
  });
});
