import type { StudyContent } from "../../shared/content";
import { ApiError, api, type StudySet } from "./api";

const pending = new Map<string, string>();

async function withRequest<T>(
  userId: string,
  action: string,
  input: unknown,
  send: (requestId: string) => Promise<T>,
) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  const signature = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = JSON.stringify(["set-save", userId, action, signature]);
  let requestId = pending.get(key);
  try {
    requestId ??= sessionStorage.getItem(key) ?? undefined;
  } catch {
    // An open page can still retry when device storage is unavailable.
  }
  requestId ??= crypto.randomUUID();
  pending.set(key, requestId);
  try {
    sessionStorage.setItem(key, requestId);
  } catch {}
  function clear() {
    if (pending.get(key) === requestId) pending.delete(key);
    try {
      if (sessionStorage.getItem(key) === requestId)
        sessionStorage.removeItem(key);
    } catch {}
  }
  try {
    const result = await send(requestId);
    clear();
    return result;
  } catch (error) {
    if (
      error instanceof ApiError &&
      [400, 404, 409, 413, 422].includes(error.status)
    )
      clear();
    throw error;
  }
}

export function saveStudySet(
  userId: string,
  content: StudyContent,
  independent = false,
) {
  return withRequest(
    userId,
    independent ? "copy-document" : "save-document",
    content,
    async (id) => {
      let reused = false;
      const set = await api<StudySet>(
        `/sets?requestId=${id}${independent ? "&copy=1" : ""}`,
        "POST",
        content,
        (response) => {
          reused = response.headers.get("X-Study-Set-Reused") === "1";
        },
      );
      return { set, reused };
    },
  );
}

export function updateStudySet(
  userId: string,
  setId: string,
  revision: number | null,
  content: StudyContent,
) {
  const input = { revision, content };
  return withRequest(userId, "edit:" + setId, input, (requestId) =>
    api<StudySet>(`/sets/${setId}?requestId=${requestId}`, "PUT", input),
  );
}

export function copyLibrarySet(userId: string, setId: string) {
  return withRequest(userId, "copy-library-set", setId, (requestId) =>
    api<StudySet>(`/sets/${setId}/duplicate`, "POST", { requestId }),
  );
}

export function copyDirectorySet(userId: string, path: string, setId: string) {
  return withRequest(userId, path, setId, (requestId) => {
    // A copy requested before the update may still be awaiting its response.
    const legacyKey = JSON.stringify(["clone", userId, path, setId]);
    let legacy: string | null = null;
    try {
      legacy = sessionStorage.getItem(legacyKey);
    } catch {}
    return api<{ id: string }>(path, "POST", {
      ...(path.startsWith("/admin/") ? { setId } : {}),
      requestId: legacy ?? requestId,
    })
      .then((result) => {
        try {
          sessionStorage.removeItem(legacyKey);
        } catch {}
        return result;
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && [404, 409].includes(error.status))
          try {
            sessionStorage.removeItem(legacyKey);
          } catch {}
        throw error;
      });
  });
}
