export const LIST_PAGE_SIZE = 30;
export const MAX_LIST_PAGE = 1_000_000;

export const attemptTypes = ["exam", "flashcards", "spaced"] as const;
export type AttemptType = (typeof attemptTypes)[number];

export type CourseSummary = { course: string; count: number };
export type AttemptGroup = {
  setId: string | null;
  title: string | null;
  count: number;
  latestStartedAt: string;
};

export type ListResult<T> = { items: T[]; hasMore: boolean };

export type SetOrganization = {
  course?: string;
  pinned?: boolean;
  archived?: boolean;
};
