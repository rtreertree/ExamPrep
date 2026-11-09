export type AISettings = {
  topic: string;
  level: string;
  language: string;
  count: number;
  kind: "exam" | "flashcards";
};
export const defaultAISettings: AISettings = {
  topic: "",
  level: "University",
  language: "English",
  count: 10,
  kind: "exam",
};
export const aiSettingsKey = (userId: string) => `exam-prep:ai:v1:${userId}`;
export function readAISettings(userId: string): AISettings | undefined {
  const raw = localStorage.getItem(aiSettingsKey(userId));
  if (!raw) return;
  const value = JSON.parse(raw);
  if (
    typeof value.topic !== "string" ||
    typeof value.level !== "string" ||
    typeof value.language !== "string" ||
    !Number.isInteger(value.count) ||
    value.count < 1 ||
    value.count > 500 ||
    !["exam", "flashcards"].includes(value.kind)
  )
    return;
  return value;
}
export function clearAISettings(userId: string) {
  localStorage.removeItem(aiSettingsKey(userId));
}
