import type { Result } from "./attempts";

export type ProgressInsights = {
  trends: {
    setId: string;
    title: string;
    revision: number;
    scores: { id: string; completedAt: string; result: Result }[];
  }[];
  recurring: {
    attemptId: string;
    itemId: string;
    setTitle: string;
    prompt: string;
    misses: number;
  }[];
  pending: { attemptId: string; sessions: number; answers: number } | null;
  retry: { attemptId: string; title: string; count: number } | null;
};
