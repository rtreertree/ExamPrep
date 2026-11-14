export const LIST_PAGE_SIZE = 30;
export const MAX_LIST_PAGE = 1_000_000;

export const setSorts = ["updated", "studied", "title", "manual"] as const;
export const folderSorts = ["name", "manual"] as const;
export const historySorts = ["date", "title"] as const;
export const sortOrders = ["asc", "desc"] as const;
export type SortOrder = (typeof sortOrders)[number];

export type LibraryFolder = { id: string; name: string };
export type FolderSummary = LibraryFolder & { count: number };
export type ManualOrder = { count: number; version: string };
export type FolderList = ListResult<FolderSummary> & {
  unfiledCount: number | null;
  manual?: ManualOrder;
};

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
  folderId?: string | null;
  pinned?: boolean;
  archived?: boolean;
};
