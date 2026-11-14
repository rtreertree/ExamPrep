import type {
  Card,
  Criterion,
  Question,
  StudyContent,
} from "../../shared/content";

export type Removal =
  | { kind: "item"; item: Question | Card; index: number }
  | {
      kind: "option";
      itemId: string;
      option: { id: string; text: string };
      index: number;
      wasAnswer: boolean;
    }
  | { kind: "criterion"; itemId: string; criterion: Criterion; index: number };

export function matchesItem(item: Question | Card, search: string) {
  const matches = (text: string) => text.toLowerCase().includes(search);
  if ("front" in item) return matches(item.front) || matches(item.back);
  if (matches(item.prompt) || matches(item.explanation ?? "")) return true;
  return item.type === "single_choice"
    ? item.options.some(({ text }) => matches(text))
    : matches(item.answer) ||
        item.rubric?.some(({ description }) => matches(description));
}

export function withItems(
  content: StudyContent,
  items: (Question | Card)[],
): StudyContent {
  return content.kind === "exam"
    ? { ...content, questions: items as Question[] }
    : { ...content, cards: items as Card[] };
}

export function moveItem<T>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
