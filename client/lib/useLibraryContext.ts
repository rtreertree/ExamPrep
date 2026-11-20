import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryFolder } from "../../shared/listing";
import type { OwnershipInvitation } from "../../shared/sharing";
import type { StudySuggestion } from "../../shared/studySuggestion";
import { api } from "./api";

type LibraryContext = {
  folders: LibraryFolder[];
  invitations: OwnershipInvitation[];
  suggestion: StudySuggestion | null;
};
type Part = keyof LibraryContext;

export function useLibraryContext(showSuggestion: boolean) {
  const [data, setData] = useState<Partial<LibraryContext>>({});
  const [errors, setErrors] = useState<Partial<Record<Part, Error>>>({});
  const versions = useRef(new Map<Part, number>());
  const load = useCallback(async (parts: Part[]) => {
    if (!parts.length) return;
    const requests = parts.map((part) => {
      const version = (versions.current.get(part) ?? 0) + 1;
      versions.current.set(part, version);
      return { part, version };
    });
    const current = () =>
      requests.filter(
        ({ part, version }) => versions.current.get(part) === version,
      );
    try {
      const result = await api<Partial<LibraryContext>>(
        `/library/context?include=${parts.join(",")}`,
      );
      const fresh = current();
      setData((previous) => ({
        ...previous,
        ...Object.fromEntries(fresh.map(({ part }) => [part, result[part]])),
      }));
      setErrors((previous) => {
        const next = { ...previous };
        for (const { part } of fresh) delete next[part];
        return next;
      });
    } catch (error) {
      const failed = current();
      setErrors((previous) => ({
        ...previous,
        ...Object.fromEntries(failed.map(({ part }) => [part, error])),
      }));
    }
  }, []);
  useEffect(() => {
    const parts: Part[] = ["folders", "invitations"];
    if (showSuggestion) parts.push("suggestion");
    void load(parts.filter((part) => !versions.current.has(part)));
  }, [load, showSuggestion]);
  function removeInvitation(id: string) {
    versions.current.set(
      "invitations",
      (versions.current.get("invitations") ?? 0) + 1,
    );
    setData((previous) => ({
      ...previous,
      invitations: previous.invitations?.filter((inv) => inv.id !== id),
    }));
  }
  return {
    data,
    error: Object.values(errors)[0],
    retry: () => void load(Object.keys(errors) as Part[]),
    refresh: (...parts: Part[]) =>
      void load(parts.filter((part) => versions.current.has(part))),
    removeInvitation,
  };
}
