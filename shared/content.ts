import { z } from "zod";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import {
  parseJSON,
  pointer,
  ValidationError,
  MAX_BYTES,
  type Issue,
} from "./json";
export { ValidationError, MAX_BYTES } from "./json";
export const codePoints = (s: string) => [...s].length;
const text = (max: number, nonblank = true) =>
  z
    .string()
    .superRefine((s, c) => {
      if (codePoints(s) > max)
        c.addIssue({
          code: "custom",
          message: `Must contain at most ${max} Unicode characters.`,
        });
      if (nonblank && !s.trim())
        c.addIssue({ code: "custom", message: "Must contain text." });
    })
    .meta({ maxLength: max, ...(nonblank ? { minLength: 1 } : {}) });
export const contentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const answerTypeSchema = z.enum(["simple", "math", "chem"]).meta({
  description:
    "Preferred written-answer keyboard. Omission behaves as simple. Answers remain Markdown/LaTeX strings; grading is unchanged.",
});
export type AnswerType = z.infer<typeof answerTypeSchema>;
const option = z.strictObject({ id: contentId, text: text(20000) });
export const criterionSchema = z.strictObject({
  id: contentId,
  description: text(20000),
  points: z.number().int().min(1).max(100),
});
const choice = z.strictObject({
  id: contentId,
  type: z.literal("single_choice"),
  prompt: text(20000),
  options: z.array(option).min(2).max(6),
  answer: contentId,
  explanation: text(20000, false).optional(),
});
const written = z.strictObject({
  id: contentId,
  type: z.literal("written"),
  prompt: text(20000),
  answer: text(20000),
  answerType: answerTypeSchema.optional(),
  explanation: text(20000, false).optional(),
  rubric: z.array(criterionSchema).min(1).max(20).optional(),
});
export const questionSchema = z.discriminatedUnion("type", [choice, written]);
export const cardSchema = z.strictObject({
  id: contentId,
  front: text(20000),
  back: text(20000),
});
const envelope = {
  schemaVersion: z.literal(1),
  title: text(200),
  description: text(2000, false).optional(),
};
export const contentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...envelope,
    kind: z.literal("exam"),
    questions: z.array(questionSchema).min(1).max(500),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("flashcards"),
    cards: z.array(cardSchema).min(1).max(500),
  }),
]);
export type StudyContent = z.infer<typeof contentSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Card = z.infer<typeof cardSchema>;
export type Criterion = z.infer<typeof criterionSchema>;
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkGfm);
export function markupIssues(source: string): string[] {
  const errors = new Set<string>();
  const tree = markdownParser.parse(source);
  visit(tree, (node) => {
    if (["html", "image", "imageReference"].includes(node.type))
      errors.add(
        "Raw HTML and embedded images/media are not allowed. Use text or a code block.",
      );
    if (
      (node.type === "link" || node.type === "definition") &&
      "url" in node &&
      (typeof node.url !== "string" || !/^https?:\/\//i.test(node.url))
    )
      errors.add("Links must use http:// or https://.");
    if (
      (node.type === "math" || node.type === "inlineMath") &&
      "value" in node &&
      typeof node.value === "string" &&
      /\\(?:def|gdef|edef|xdef|let|futurelet|global|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|includegraphics|html\w*|href|url|input|include|require|csname)\b/i.test(
        node.value,
      )
    )
      errors.add(
        "Resource-loading LaTeX and custom macro definitions are not allowed.",
      );
  });
  return [...errors];
}
export function validateContent(input: unknown): StudyContent {
  const parsed = contentSchema.safeParse(input);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.flatMap((i) =>
        i.code === "unrecognized_keys"
          ? i.keys.map((k) => ({
              path: pointer([...i.path, k]),
              message: "Unknown field is not allowed.",
            }))
          : [{ path: pointer(i.path), message: i.message }],
      ),
    );
  const doc = parsed.data;
  const issues: Issue[] = [];
  const unique = (items: { id: string }[], path: (string | number)[]) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id))
        issues.push({
          path: pointer([...path, i, "id"]),
          message: "IDs must be unique in this collection.",
        });
      seen.add(item.id);
    });
  };
  const markup = (s: string | undefined, path: (string | number)[]) => {
    if (s !== undefined)
      markupIssues(s).forEach((message) =>
        issues.push({ path: pointer(path), message }),
      );
  };
  markup(doc.description, ["description"]);
  if (doc.kind === "exam") {
    unique(doc.questions, ["questions"]);
    doc.questions.forEach((q, i) => {
      const p = ["questions", i];
      markup(q.prompt, [...p, "prompt"]);
      markup(q.explanation, [...p, "explanation"]);
      if (q.type === "single_choice") {
        unique(q.options, [...p, "options"]);
        q.options.forEach((o, j) =>
          markup(o.text, [...p, "options", j, "text"]),
        );
        if (!q.options.some((o) => o.id === q.answer))
          issues.push({
            path: pointer([...p, "answer"]),
            message: "Answer must match an option ID in this question.",
          });
      } else {
        markup(q.answer, [...p, "answer"]);
        if (q.rubric) {
          unique(q.rubric, [...p, "rubric"]);
          q.rubric.forEach((r, j) =>
            markup(r.description, [...p, "rubric", j, "description"]),
          );
        }
      }
    });
  } else {
    unique(doc.cards, ["cards"]);
    doc.cards.forEach((card, i) => {
      markup(card.front, ["cards", i, "front"]);
      markup(card.back, ["cards", i, "back"]);
    });
  }
  if (new TextEncoder().encode(JSON.stringify(doc)).length > MAX_BYTES)
    issues.push({ path: "/", message: "Serialized content exceeds 2 MiB." });
  if (issues.length) throw new ValidationError(issues);
  return doc;
}
export const parseContent = (source: string) =>
  validateContent(parseJSON(source));
export const itemsOf = (doc: StudyContent) =>
  doc.kind === "exam" ? doc.questions : doc.cards;
export const freshId = () => crypto.randomUUID();
export function emptyContent(kind: StudyContent["kind"]): StudyContent {
  return kind === "exam"
    ? {
        schemaVersion: 1,
        kind,
        title: "",
        questions: [
          {
            id: freshId(),
            type: "single_choice",
            prompt: "",
            options: [
              { id: "a", text: "" },
              { id: "b", text: "" },
            ],
            answer: "a",
          },
        ],
      }
    : {
        schemaVersion: 1,
        kind,
        title: "",
        cards: [{ id: freshId(), front: "", back: "" }],
      };
}

export function serializeContent(content: StudyContent): string {
  const doc = validateContent(content);
  const pretty = JSON.stringify(doc, null, 2) + "\n";
  return new TextEncoder().encode(pretty).length <= MAX_BYTES
    ? pretty
    : JSON.stringify(doc);
}
