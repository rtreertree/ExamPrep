import { describe, expect, it } from "vitest";
import { backupSummary, validateBackup } from "../shared/backup";
import type { StudyContent } from "../shared/content";
import { ValidationError } from "../shared/json";

const now = "2026-11-09T10:00:00.000Z";
const backupId = "ccbb6ee7-6e0f-4316-b83d-8a065f26d78f";
const exam: StudyContent = {
  schemaVersion: 1,
  kind: "exam",
  title: "Calculus",
  questions: [
    {
      type: "single_choice",
      id: "__proto__",
      prompt: "1 + 1",
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
      ],
      answer: "a",
    },
    { type: "written", id: "q2", prompt: "Explain", answer: "Example" },
  ],
};
const fixture = () => ({
  library: {
    schemaVersion: 1,
    backupId,
    kind: "exam-prep-library",
    sets: [
      {
        id: "set",
        content: exam,
        revision: 2,
        course: "Math",
        pinned: true,
        archived: true,
        reviewLimit: 20,
        lastStudiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
  },
  history: {
    schemaVersion: 1,
    backupId,
    kind: "exam-prep-history",
    attempts: [
      {
        id: "attempt",
        studySetId: "set",
        studySetRevision: 1,
        sourceAttemptId: null as string | null,
        snapshot: exam,
        settings: { count: 2, order: "shuffled", timerMinutes: 5 },
        reviewMode: false,
        fullSet: true,
        status: "reviewing",
        position: 1,
        responses: {
          ["__proto__"]: { selectedOptionId: "a", note: "Private" },
          q2: { text: "Proof" },
        },
        result: {
          automatic: { earnedPoints: 40, maxPoints: 40, pendingCount: 0 },
        },
        startedAt: now,
        updatedAt: now,
        completedAt: null,
      },
    ],
    reviews: [],
  },
});

describe("v1 backup validation", () => {
  it("keeps organization, immutable snapshots and private responses and recalculates scores", () => {
    const backup = validateBackup(fixture());
    expect(backupSummary(backup)).toEqual({
      setCount: 1,
      attemptCount: 1,
      reviewCount: 0,
      titles: ["Calculus"],
    });
    expect(backup.sets[0]).toMatchObject({
      course: "Math",
      pinned: true,
      archived: true,
    });
    expect(backup.attempts[0].responses["__proto__"].note).toBe("Private");
    expect(backup.attempts[0].result).toEqual({
      automatic: { earnedPoints: 1, maxPoints: 1, pendingCount: 0 },
      selfAssessed: { earnedPoints: 0, maxPoints: 1, pendingCount: 1 },
    });
  });

  it("supports a library-only restore and rejects mismatched files and invalid retry links", () => {
    const { library, history } = fixture();
    expect(validateBackup({ library }).attempts).toEqual([]);
    expect(() =>
      validateBackup({
        library,
        history: { ...history, backupId: crypto.randomUUID() },
      }),
    ).toThrow(/history file from this library backup/);
    history.attempts[0].sourceAttemptId = "attempt";
    history.attempts[0].fullSet = false;
    expect(() => validateBackup({ library, history })).toThrow(
      /cannot reference itself/,
    );
  });

  it("rejects a response that would never be accepted during practice", () => {
    const backup = fixture();
    backup.history.attempts[0].responses["__proto__"].selectedOptionId =
      "missing";
    expect(() => validateBackup(backup)).toThrow(ValidationError);
  });

  it("puts completed retry sources before their dependent attempts", () => {
    const { library, history } = fixture();
    const attempt = history.attempts[0];
    const source = {
      ...attempt,
      id: "source",
      status: "completed",
      completedAt: now,
      responses: {
        ...attempt.responses,
        q2: { text: "Proof", selfAssessment: "correct" },
      },
    };
    const retry = { ...attempt, fullSet: false, sourceAttemptId: source.id };
    const backup = validateBackup({
      library,
      history: { ...history, attempts: [retry, source] },
    });
    expect(backup.attempts.map((row) => row.id)).toEqual(["source", "attempt"]);
  });
});
