import { describe, expect, it } from "vitest";
import {
  grade,
  validateProgressChanges,
  responseChanges,
  type Responses,
} from "../shared/attempts";
import { validateContent, type StudyContent } from "../shared/content";
import { encodeStorage, decodeStorage } from "../server/storage";
import { progressContent, readProgressContent } from "../server/snapshots";
import { safeDiagnostic } from "../server/diagnostics";

const doc: StudyContent = validateContent({
  schemaVersion: 1,
  kind: "exam",
  title: "Boundary",
  questions: Array.from({ length: 500 }, (_, i) => ({
    id: `q${i}`,
    type: "written",
    prompt: "Explain.",
    answer: "Reference",
  })),
});
describe("bounded v1 progress", () => {
  it("saves all 500 maximum-length answers via bounded deltas, preserving Unicode and JSON escapes", () => {
    const values = ["a", "🦊", "\0", '"\\\n'];
    let responses: Responses = {};
    for (let i = 0; i < 500; i++) {
      const unit = values[i % values.length];
      const text = [...unit.repeat(20_000)].slice(0, 20_000).join("");
      const changes = { [`q${i}`]: { text } };
      expect(
        new TextEncoder().encode(
          JSON.stringify({ revision: i + 1, position: i, changes }),
        ).length,
      ).toBeLessThan(128_000);
      responses = validateProgressChanges(
        progressContent(doc),
        "in_progress",
        responses,
        changes,
        i,
      );
    }
    expect(Object.keys(responses)).toHaveLength(500);
    expect(
      new TextEncoder().encode(JSON.stringify(responses)).length,
    ).toBeGreaterThan(8 * 1024 * 1024);
    expect(decodeStorage(encodeStorage(responses))).toEqual(responses);
    expect(
      grade(readProgressContent(progressContent(doc)), responses).result
        .selfAssessed?.pendingCount,
    ).toBe(500);
    expect(grade(doc, responses)).toEqual(
      grade(progressContent(doc), responses),
    );
  });
  it("merges deletions safely and validates frozen answers and reveal rules", () => {
    const old = { q0: { text: "frozen" }, q1: { text: "other" } };
    expect(() =>
      validateProgressChanges(
        progressContent(doc),
        "reviewing",
        old,
        { q0: null },
        0,
      ),
    ).toThrow("frozen");
    expect(() =>
      validateProgressChanges(
        progressContent(doc),
        "reviewing",
        old,
        { q0: { text: "changed" } },
        0,
      ),
    ).toThrow("frozen");
    expect(
      validateProgressChanges(
        progressContent(doc),
        "reviewing",
        old,
        { q0: { text: "frozen", selfAssessment: "correct" } },
        0,
      ),
    ).toEqual({ ...old, q0: { text: "frozen", selfAssessment: "correct" } });
    expect(() =>
      validateProgressChanges(
        progressContent(doc),
        "in_progress",
        old,
        { missing: null },
        0,
      ),
    ).toThrow("does not exist");
    expect(() =>
      validateProgressChanges(progressContent(doc), "completed", old, {}, 0),
    ).toThrow("read-only");
    const deck: StudyContent = {
      schemaVersion: 1,
      kind: "flashcards",
      title: "Cards",
      cards: [{ id: "__proto__", front: "x", back: "y" }],
    };
    const revealed = JSON.parse(
      '{"__proto__":{"revealed":true,"rating":"known"}}',
    );
    expect(() =>
      validateProgressChanges(
        deck,
        "in_progress",
        revealed,
        JSON.parse('{"__proto__":null}'),
        0,
      ),
    ).toThrow("Revealed");
    const next = validateProgressChanges(
      deck,
      "in_progress",
      revealed,
      JSON.parse('{"__proto__":{"revealed":true}}'),
      0,
    );
    expect(Object.hasOwn(next, "__proto__")).toBe(true);
    expect(grade(deck, next).result.unreviewed).toBe(1);
    expect(responseChanges(revealed, next)).toEqual(next);
  });
  it("keeps scoring metadata small even for maximum content", () => {
    const large = structuredClone(doc);
    if (large.kind !== "exam") throw new Error("Expected exam");
    for (const q of large.questions)
      q.prompt = "Detailed study material. ".repeat(150);
    const valid = validateContent(large);
    const rules = readProgressContent(progressContent(valid));
    expect(JSON.stringify(rules).length).toBeLessThan(50_000);
    expect(grade(rules, { q0: { text: "Response" } })).toEqual(
      grade(valid, { q0: { text: "Response" } }),
    );
  });
});
it("logs only allowlisted diagnostic fields, never raw exception data", () => {
  const secret = "postgres://password@host/private?answers=private";
  const event = safeDiagnostic(
    { message: secret, stack: secret, code: "P1001", query: secret },
    {
      requestId: "reference",
      route: "/api/attempts/:id/progress",
      runtime: "worker",
      durationMs: 9,
    },
  );
  expect(event).toMatchObject({
    category: "database",
    code: "P1001",
    requestId: "reference",
    status: 500,
  });
  expect(JSON.stringify(event)).not.toContain(secret);
  expect(
    safeDiagnostic(
      { code: secret },
      { requestId: "r", route: "/api/*", runtime: "node", durationMs: 0 },
    ),
  ).not.toHaveProperty("code");
});
