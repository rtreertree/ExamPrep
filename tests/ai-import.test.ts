import { describe, expect, it } from "vitest";
import type { StudyContent } from "../shared/content";
import { checkAIImport } from "../client/lib/aiImport";
import {
  buildAIAnswerReviewPrompt,
  buildAIRepairPrompt,
} from "../client/lib/aiPrompt";
import { defaultAISettings } from "../client/lib/aiSettings";

const exam: Extract<StudyContent, { kind: "exam" }> = {
  schemaVersion: 1,
  kind: "exam",
  title: "ชีววิทยา",
  questions: [
    {
      id: "q1",
      type: "single_choice",
      prompt: "พืชสร้างอาหารเองได้",
      options: [
        { id: "false", text: "ผิด" },
        { id: "true", text: "ถูก" },
      ],
      answer: "true",
      explanation: "พืชสังเคราะห์แสง",
    },
    {
      id: "q2",
      type: "single_choice",
      prompt: "พืชใช้แก๊สอะไร",
      options: [
        { id: "a", text: "ออกซิเจน" },
        { id: "b", text: "คาร์บอนไดออกไซด์" },
      ],
      answer: "b",
      explanation: "ใช้คาร์บอนไดออกไซด์",
    },
    {
      id: "q3",
      type: "written",
      prompt: "อธิบายการสังเคราะห์แสง",
      answer: "พืชใช้แสงสร้างน้ำตาล",
      explanation: "แสงเป็นแหล่งพลังงาน",
      rubric: [{ id: "r", description: "ระบุบทบาทของแสง", points: 1 }],
    },
  ],
};
const cards: Extract<StudyContent, { kind: "flashcards" }> = {
  schemaVersion: 1,
  kind: "flashcards",
  title: "Study cards",
  cards: [
    { id: "a", front: "Cue", back: "Answer" },
    { id: "b", front: "Cue", back: "Other answer" },
  ],
};
const setup = {
  ...defaultAISettings,
  topic: "Photosynthesis",
  language: "Thai",
  exactMix: true,
  mix: { choice: 1, trueFalse: 1, written: 1 },
  rubrics: "always" as const,
};

describe("AI import checks", () => {
  it("identifies true/false by IDs and accepts two ordinary choices in the same non-English exam", () => {
    expect(checkAIImport(exam, setup)).toEqual({ errors: [], warnings: [] });
    const wrongMix = { ...setup, mix: { choice: 2, trueFalse: 0, written: 1 } };
    expect(checkAIImport(exam, wrongMix).errors).toEqual([
      {
        path: "/questions",
        message: expect.stringContaining(
          "Expected 0 true/false questions; found 1.",
        ),
      },
    ]);
  });

  it("reports expected and actual type and item count", () => {
    const { errors } = checkAIImport(cards, setup);
    expect(errors).toEqual([
      { path: "/kind", message: "Expected exam; found flashcards." },
      { path: "/cards", message: "Expected 3 items; found 2." },
    ]);
  });

  it("blocks missing or unexpected explanations and rubrics", () => {
    const missing = structuredClone(exam);
    missing.questions.forEach((q) => {
      q.explanation = " ";
      if (q.type === "written") delete q.rubric;
    });
    const paths = [
      "/questions/0/explanation",
      "/questions/1/explanation",
      "/questions/2/explanation",
      "/questions/2/rubric",
    ];
    expect(
      checkAIImport(missing, setup).errors.map(({ path }) => path),
    ).toEqual(paths);
    expect(
      checkAIImport(exam, {
        ...setup,
        explanations: "none",
        rubrics: "never",
      }).errors.map(({ path }) => path),
    ).toEqual(paths);
    expect(
      checkAIImport(missing, { ...setup, rubrics: "when-useful" }).errors.map(
        ({ path }) => path,
      ),
    ).not.toContain(paths[3]);
  });

  it("checks content without a complete setup and preserves case-sensitive choices", () => {
    const duplicate = structuredClone(exam);
    const choice = duplicate.questions[0];
    if (choice.type !== "single_choice")
      throw new Error("Missing choice question");
    choice.options[0].text = "x";
    choice.options[1].text = "X";
    expect(checkAIImport(duplicate, defaultAISettings).errors).toEqual([]);
    choice.options[1].text = " x ";
    duplicate.questions[1].prompt = choice.prompt;
    const { errors, warnings } = checkAIImport(duplicate, defaultAISettings);
    expect(errors).toEqual([
      {
        path: "/questions/0/options/1/text",
        message: expect.stringContaining("Identical to option A"),
      },
    ]);
    expect(warnings).toEqual([
      {
        path: "/questions/1/prompt",
        message: expect.stringContaining("question 1 (q1)"),
      },
    ]);
    expect(checkAIImport(cards, defaultAISettings)).toEqual({
      errors: [],
      warnings: [
        {
          path: "/cards/1/front",
          message: expect.stringContaining("card 1 (a)"),
        },
      ],
    });
  });

  it("makes findings actionable in the generation chat and offers a separate answer audit", () => {
    const { errors, warnings } = checkAIImport(cards, setup);
    const feedback = buildAIRepairPrompt(errors, warnings, setup);
    expect(feedback).toContain(
      "Fix [/kind]: Study set: Expected exam; found flashcards.",
    );
    expect(feedback).toContain("Review [/cards/1/front]: Card 2, front:");
    expect(feedback).toContain("Language: Thai");
    expect(feedback).toContain(
      "Preserve unaffected items, their IDs, and their order",
    );
    expect(buildAIAnswerReviewPrompt("flashcards")).toContain(
      "before consulting the back",
    );
    expect(buildAIAnswerReviewPrompt("exam")).toContain(
      "what you are uncertain about",
    );
  });
});
