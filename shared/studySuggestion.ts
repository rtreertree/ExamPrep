import type { StudyContent } from "./content";

export type StudySuggestion =
  | {
      type: "practice";
      set: {
        id: string;
        title: string;
        kind: StudyContent["kind"];
        count: number;
      };
    }
  | {
      type: "resume";
      id: string;
      title: string;
      kind: StudyContent["kind"];
      status: "in_progress" | "reviewing";
      position: number;
      total: number;
      pendingCount: number | null;
      reviewMode: boolean;
    };
