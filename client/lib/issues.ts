import { ValidationError, type Issue } from "../../shared/json";
import { ApiError } from "./api";
export const issuesOf = (error?: Error): Issue[] =>
  error instanceof ValidationError || error instanceof ApiError
    ? (error.issues ?? [])
    : [];
export function issueLabel(issue: Issue) {
  const p = issue.path
    .split("/")
    .slice(1)
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  const names: Record<string, string> = {
    prompt: "question",
    text: "text",
    answer: "answer",
    title: "title",
    description: "description",
    front: "front",
    back: "back",
    explanation: "explanation",
    points: "maximum points",
    id: "item ID",
  };
  let location = "Study set";
  if (p[0] === "library" || p[0] === "history") {
    const group = p[0] === "library" ? "Library backup" : "Practice history";
    const entry =
      p[1] === "sets"
        ? "study set"
        : p[1] === "attempts"
          ? "attempt"
          : "review";
    const row = /^\d+$/.test(p[2] ?? "")
      ? `, ${entry} ${Number(p[2]) + 1}`
      : "";
    return `${group}${row}: ${issue.message}`;
  }
  if (["questions", "cards"].includes(p[0]) && /^\d+$/.test(p[1] ?? "")) {
    location = `${p[0] === "questions" ? "Question" : "Card"} ${Number(p[1]) + 1}`;
    if (p[2] === "options" && /^\d+$/.test(p[3] ?? ""))
      location += `, option ${String.fromCharCode(65 + Number(p[3]))}`;
    else if (p[2] === "rubric" && /^\d+$/.test(p[3] ?? ""))
      location += `, criterion ${Number(p[3]) + 1}`;
    else if (names[p[2]]) location += `, ${names[p[2]]}`;
  } else if (p[0] === "responses") location = `Answer ${p[1] ?? ""}`;
  else if (names[p[0]])
    location = names[p[0]][0].toUpperCase() + names[p[0]].slice(1);
  return `${location}: ${issue.message === "Must contain text." ? "Enter some text." : issue.message}`;
}
export const repairInstructions = (issues: Issue[]) =>
  "Repair my attached Exam Prep v1 file without removing or changing unrelated study content. Keep schemaVersion 1. Fix these validation issues and return the complete corrected file:\n" +
  issues.map((i) => `${issueLabel(i)} (${i.path})`).join("\n");
