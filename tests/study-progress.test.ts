import { describe, expect, it, vi } from "vitest";
import { readInsights } from "../server/insights";
import type { Database } from "../server/db";
import { progressContent } from "../server/snapshots";
import { cardFingerprint, nextCardReview } from "../server/spacedReview";
import type { StudyContent } from "../shared/content";

describe("spaced review intervals", () => {
  it("extends known cards, caps the interval and resets cards marked for review", () => {
    const at = new Date("2026-11-09T12:00:00.000Z");
    expect(nextCardReview(0, "known", at)).toEqual({
      streak: 1,
      dueAt: new Date("2026-11-10T12:00:00Z"),
    });
    expect(nextCardReview(1, "known", at)).toEqual({
      streak: 2,
      dueAt: new Date("2026-11-12T12:00:00Z"),
    });
    expect(nextCardReview(5, "known", at)).toEqual({
      streak: 5,
      dueAt: new Date("2026-12-09T12:00:00Z"),
    });
    expect(nextCardReview(4, "review_again", at)).toEqual({
      streak: 0,
      dueAt: new Date("2026-11-10T12:00:00Z"),
    });
  });
  it("fingerprints exact card sides, including isolated Unicode surrogates", async () => {
    const card = { id: "one", front: "\ud800", back: "Answer" };
    const signature = await cardFingerprint(card);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(await cardFingerprint({ ...card })).toBe(signature);
    expect(await cardFingerprint({ ...card, front: "\ufffd" })).not.toBe(
      signature,
    );
    expect(
      await cardFingerprint({ ...card, back: "Corrected answer" }),
    ).not.toBe(signature);
  });
});

it("clears the next retry suggestion after success without hiding recurring mistakes", async () => {
  const doc: StudyContent = {
    schemaVersion: 1,
    kind: "flashcards",
    title: "Spanish verbs",
    cards: [{ id: "verb", front: "hablar", back: "to speak" }],
  };
  const rows = ["latest", "second", "first"].map((id, index) => ({
    id,
    setId: "deck",
    setRevision: 1,
    title: doc.title,
    rules: progressContent(doc),
    responses: { verb: { rating: index === 0 ? "known" : "review_again" } },
  }));
  const db = {
    $queryRaw: vi.fn((query: TemplateStringsArray) => {
      const sql = query.join("?");
      if (sql.includes("WITH recent")) return Promise.resolve(rows);
      if (sql.includes("jsonb_to_recordset"))
        return Promise.resolve([
          { attemptId: "second", itemId: "verb", prompt: "hablar" },
        ]);
      return Promise.resolve([]);
    }),
  } as unknown as Pick<Database, "$queryRaw">;
  expect(await readInsights(db, "owner", "deck")).toMatchObject({
    retry: null,
    recurring: [
      { attemptId: "second", itemId: "verb", prompt: "hablar", misses: 2 },
    ],
  });
});
