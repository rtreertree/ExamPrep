import { itemsOf, type StudyContent } from "../../shared/content";
import type { Issue } from "../../shared/json";
import {
  activeQuestionMix,
  aiItemTotal,
  validAIItemTotal,
  type AISettings,
} from "./aiSettings";

export function hasCompleteAISetup(settings: AISettings) {
  return (
    Boolean(settings.topic.trim()) && validAIItemTotal(aiItemTotal(settings))
  );
}

const questionFormats = [
  ["choice", "multiple-choice"],
  ["trueFalse", "true/false"],
  ["written", "written"],
] as const;

// Preserve case and interior whitespace, which can be significant in formulas and code.
function duplicateOf(seen: Map<string, number>, text: string, index: number) {
  const key = text.trim().normalize("NFC");
  const first = seen.get(key);
  if (first === undefined) seen.set(key, index);
  return first;
}

export function checkAIImport(content: StudyContent, settings: AISettings) {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const items = itemsOf(content);
  const exam = content.kind === "exam";
  const collection = exam ? "/questions" : "/cards";
  const itemLabel = exam ? "Question" : "Card";
  const hasSetup = hasCompleteAISetup(settings);
  const expectedExam = hasSetup && settings.kind === "exam";
  const mix = expectedExam && activeQuestionMix(settings);
  const seen = new Map<string, number>();
  const counts = { choice: 0, trueFalse: 0, written: 0 };

  if (hasSetup) {
    if (content.kind !== settings.kind) {
      errors.push({
        path: "/kind",
        message: `Expected ${settings.kind}; found ${content.kind}.`,
      });
    }
    const expected = aiItemTotal(settings);
    if (items.length !== expected) {
      errors.push({
        path: collection,
        message: `Expected ${expected} items; found ${items.length}.`,
      });
    }
  }

  items.forEach((item, index) => {
    const path = `${collection}/${index}`;
    const question = "prompt" in item;
    const duplicate = duplicateOf(
      seen,
      question ? item.prompt : item.front,
      index,
    );
    if (duplicate !== undefined) {
      warnings.push({
        path: `${path}/${question ? "prompt" : "front"}`,
        message: `Repeats ${itemLabel.toLowerCase()} ${duplicate + 1} (${items[duplicate].id}). Check whether the repetition is intentional.`,
      });
    }
    if (!question) return;

    if (expectedExam) {
      if (settings.explanations === "none" && item.explanation !== undefined) {
        errors.push({
          path: `${path}/explanation`,
          message: "Expected no explanation; found an explanation field.",
        });
      } else if (
        settings.explanations !== "none" &&
        !item.explanation?.trim()
      ) {
        errors.push({
          path: `${path}/explanation`,
          message: "Expected a nonblank explanation; found none.",
        });
      }
    }

    if (item.type === "written") {
      counts.written++;
      if (expectedExam && settings.rubrics === "always" && !item.rubric) {
        errors.push({
          path: `${path}/rubric`,
          message: "Expected a marking rubric; found none.",
        });
      } else if (expectedExam && settings.rubrics === "never" && item.rubric) {
        errors.push({
          path: `${path}/rubric`,
          message: "Expected no marking rubric; found a rubric.",
        });
      }
      return;
    }

    const trueFalse =
      item.options.length === 2 &&
      item.options.some(({ id }) => id === "true") &&
      item.options.some(({ id }) => id === "false");
    counts[trueFalse ? "trueFalse" : "choice"]++;
    const optionTexts = new Map<string, number>();
    item.options.forEach(({ text }, optionIndex) => {
      const first = duplicateOf(optionTexts, text, optionIndex);
      if (first !== undefined) {
        errors.push({
          path: `${path}/options/${optionIndex}/text`,
          message: `Identical to option ${String.fromCharCode(65 + first)}. Give each option distinct text.`,
        });
      }
    });
  });

  if (exam && mix) {
    const mismatches = questionFormats
      .filter(([format]) => counts[format] !== mix[format])
      .map(
        ([format, label]) =>
          `Expected ${mix[format]} ${label} questions; found ${counts[format]}.`,
      );
    if (mismatches.length) {
      errors.push({
        path: "/questions",
        message: `${mismatches.join(" ")} True/false questions must have exactly two options with IDs "true" and "false".`,
      });
    }
  }

  return { errors, warnings };
}
