import type { StudyContent } from "./content";

export const codePoints = (s: string) => [...s].length;
export const itemsOf = (doc: StudyContent) =>
  doc.kind === "exam" ? doc.questions : doc.cards;
export const freshId = () => crypto.randomUUID();
