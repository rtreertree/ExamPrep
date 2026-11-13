import { z } from "zod";

export const difficultyOptions = [
  ["level", "Match the level"],
  ["easy", "Easy"],
  ["moderate", "Moderate"],
  ["challenging", "Challenging"],
  ["mixed", "Mixed difficulty"],
] as const;

export const explanationOptions = [
  ["brief", "Brief explanations"],
  ["detailed", "Detailed explanations"],
  ["none", "No explanations"],
] as const;

export const rubricOptions = [
  ["when-useful", "When useful"],
  ["always", "For every written question"],
  ["never", "No rubrics"],
] as const;

const defaultCount = 10;
const draftCount = z.number().nullable();
const mixSchema = z.object({
  choice: draftCount,
  trueFalse: draftCount,
  written: draftCount,
});
const settingsSchema = z.object({
  topic: z.string().catch(""),
  level: z.string().catch("University"),
  language: z.string().catch("English"),
  count: draftCount.catch(defaultCount),
  kind: z.enum(["exam", "flashcards"]).catch("exam"),
  difficulty: z.enum(difficultyOptions.map(([value]) => value)).catch("level"),
  instructions: z.string().catch(""),
  explanations: z
    .enum(explanationOptions.map(([value]) => value))
    .catch("brief"),
  rubrics: z.enum(rubricOptions.map(([value]) => value)).catch("when-useful"),
  exactMix: z.boolean().catch(false),
  mix: mixSchema.optional().catch(undefined),
});

export type AISettings = z.infer<typeof settingsSchema>;
export const defaultAISettings = settingsSchema.parse({});
export const MAX_AI_ITEMS = 500;

function validCount(count: number | null, minimum: number): count is number {
  return (
    count !== null &&
    Number.isInteger(count) &&
    count >= minimum &&
    count <= MAX_AI_ITEMS
  );
}

export function defaultQuestionMix(count: AISettings["count"]) {
  const total = validCount(count, 1) ? count : defaultCount;
  const choice = Math.ceil(total / 2);
  return { choice, trueFalse: 0, written: total - choice };
}

export function activeQuestionMix(settings: AISettings) {
  return settings.kind === "exam" && settings.exactMix
    ? settings.mix
    : undefined;
}

export function aiItemTotal(settings: AISettings) {
  const mix = activeQuestionMix(settings);
  if (!mix) return settings.count;
  const counts = Object.values(mix);
  return counts.every((count) => validCount(count, 0))
    ? counts.reduce((total, count) => total + count, 0)
    : null;
}

export function validAIItemTotal(total: number | null): total is number {
  return validCount(total, 1);
}

export const aiSettingsKey = (userId: string) => `exam-prep:ai:v1:${userId}`;

export function readAISettings(userId: string): AISettings | undefined {
  const raw = localStorage.getItem(aiSettingsKey(userId));
  if (!raw) return;
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const settings = parsed.data;
    return settings.exactMix && !settings.mix
      ? { ...settings, mix: defaultQuestionMix(settings.count) }
      : settings;
  } catch {
    return;
  }
}

export function clearAISettings(userId: string) {
  localStorage.removeItem(aiSettingsKey(userId));
}
