import { serializeContent, type StudyContent } from "../../shared/content";
import type { OwnershipRole } from "../../shared/sharing";
import type {
  PracticeSettings,
  Responses,
  Result,
  Status,
} from "../../shared/attempts";
export type StudySet = {
  id: string;
  title: string;
  kind: StudyContent["kind"];
  content: StudyContent;
  revision: number;
  ownershipRole: OwnershipRole;
  updatedAt: string;
  course: string;
  pinned: boolean;
  archived: boolean;
  lastStudiedAt: string | null;
  reviewLimit?: number;
  count?: number;
  continuation?:
    | (Pick<Attempt, "id" | "status" | "position" | "result"> & {
        total: number;
        kind: StudyContent["kind"];
        isOlderVersion: boolean;
      })
    | null;
};
export type Attempt = {
  id: string;
  snapshot: StudyContent;
  responses: Responses;
  result: Result | null;
  status: Status;
  position: number;
  revision: number;
  startedAt: string;
  studySetId: string | null;
  sourceAttemptId: string | null;
  studySetRevision?: number | null;
  settings?: PracticeSettings;
  reviewMode?: boolean;
  fullSet?: boolean;
  title?: string;
  kind?: StudyContent["kind"];
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public issues?: { path: string; message: string }[],
    public reference?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: globalThis.Response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      "Could not reach the server. Your changes are still here. Try again.",
      0,
    );
  }
  const value = (await response.json().catch(() => ({}))) as T & {
    error?: string | { message?: string };
    message?: string;
    issues?: { path: string; message: string }[];
    reference?: string;
  };
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/"))
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(
      (typeof value.error === "object" ? value.error.message : value.error) ||
        value.message ||
        "Request failed. Try again.",
      response.status,
      value.issues,
      value.reference,
    );
  }
  return value;
}
export function download(
  content: string,
  filename: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function exportContent(content: StudyContent) {
  download(
    serializeContent(content),
    (content.title.replace(/[^\p{L}\p{N}_-]/gu, "-").slice(0, 80) ||
      "study-set") + ".examprep.json",
  );
}
