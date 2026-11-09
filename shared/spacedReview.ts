export const MAX_DAILY_REVIEWS = 500;

export type ReviewQueue = {
  title: string;
  limit: number;
  reviewedToday: number;
  due: number;
  available: number;
  resetsAt: string;
  activeAttemptId: string | null;
  archived: boolean;
  cards: {
    id: string;
    front: string;
    nextReviewAt: string | null;
    due: boolean;
  }[];
};
