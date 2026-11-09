import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";

const storagePrefix = (userId: string) => `examprep:list-v1:${userId}:`;

function savedQuery(key: string) {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveQuery(key: string, query: string, keys: string) {
  try {
    const params = new URLSearchParams(query);
    const allowed = new Set(keys.split(","));
    for (const name of [...params.keys()])
      if (!allowed.has(name)) params.delete(name);
    sessionStorage.setItem(key, params.toString());
  } catch {
    // URL filters remain usable when browser storage is unavailable.
  }
}

export function clearListQueries(userId: string) {
  for (const pathname of ["/", "/history"])
    sessionStorage.removeItem(storagePrefix(userId) + pathname);
}

export function useListQuery(keys: string[]) {
  const { user } = useAuth();
  const location = useLocation();
  const [, setParams] = useSearchParams();
  const storageKey = storagePrefix(user!.id) + location.pathname;
  const keyList = keys.join(",");
  const query = location.search || savedQuery(storageKey);
  const params = new URLSearchParams(query);
  const pending = useRef<string | null>(null);
  const appliedSearch = params.get("search") ?? "";
  const [input, setInput] = useState({
    applied: appliedSearch,
    value: appliedSearch,
  });
  if (input.applied !== appliedSearch) {
    setInput({ applied: appliedSearch, value: appliedSearch });
  }
  useEffect(() => {
    const committed = location.search.slice(1);
    if (pending.current !== null && pending.current !== committed) return;
    pending.current = null;
    if (location.search) saveQuery(storageKey, location.search, keyList);
  }, [storageKey, location.search, keyList]);

  const update = useCallback(
    (values: Record<string, string | null>) => {
      // Consecutive controls can update before the router commits a transition.
      const next = new URLSearchParams(pending.current ?? query);
      for (const [name, value] of Object.entries(values)) {
        if (value === null) next.delete(name);
        else next.set(name, value);
      }
      pending.current = next.toString();
      saveQuery(storageKey, pending.current, keyList);
      setParams(next, { replace: true, preventScrollReset: true });
    },
    [query, storageKey, keyList, setParams],
  );
  const search = input.applied === appliedSearch ? input.value : appliedSearch;
  useEffect(() => {
    if (search === appliedSearch) return;
    const timeout = setTimeout(
      () => update({ search: search || null, page: null }),
      250,
    );
    return () => clearTimeout(timeout);
  }, [search, appliedSearch, update]);
  function setSearch(value: string) {
    setInput({ applied: appliedSearch, value });
  }
  return { params, update, search, setSearch };
}

export function listPage(params: URLSearchParams) {
  const page = Number(params.get("page"));
  return Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 0;
}
