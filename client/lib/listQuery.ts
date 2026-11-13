import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { MAX_LIST_PAGE } from "../../shared/listing";
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

export function useListQuery(keys: string[], resetOnSearch: string[] = []) {
  const { user } = useAuth();
  const location = useLocation();
  const [, setParams] = useSearchParams();
  const storageKey = storagePrefix(user!.id) + location.pathname;
  const keyList = keys.join(",");
  const searchResetKeys = resetOnSearch.join(",");
  const query = location.search || savedQuery(storageKey);
  const params = new URLSearchParams(query);
  const pending = useRef<{ query: string; locationKey: string } | null>(null);
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
    if (
      pending.current?.locationKey === location.key &&
      pending.current.query !== committed
    )
      return;
    pending.current = null;
    if (location.search) saveQuery(storageKey, location.search, keyList);
  }, [storageKey, location.key, location.search, keyList]);

  const update = useCallback(
    (values: Record<string, string | null>) => {
      // Consecutive controls can update before the router commits a transition.
      const next = new URLSearchParams(
        pending.current?.locationKey === location.key
          ? pending.current.query
          : query,
      );
      for (const [name, value] of Object.entries(values)) {
        if (value === null) next.delete(name);
        else next.set(name, value);
      }
      pending.current = { query: next.toString(), locationKey: location.key };
      saveQuery(storageKey, pending.current.query, keyList);
      setParams(next, { replace: true, preventScrollReset: true });
    },
    [query, storageKey, keyList, location.key, setParams],
  );
  const search = input.applied === appliedSearch ? input.value : appliedSearch;
  useEffect(() => {
    if (search === appliedSearch) return;
    const timeout = setTimeout(() => {
      const changes: Record<string, string | null> = {
        search: search || null,
        page: null,
      };
      if (searchResetKeys)
        for (const key of searchResetKeys.split(",")) changes[key] = null;
      update(changes);
    }, 250);
    return () => clearTimeout(timeout);
  }, [search, appliedSearch, searchResetKeys, update]);
  function setSearch(value: string) {
    setInput({ applied: appliedSearch, value });
  }
  function updateSearch(
    value: string,
    changes: Record<string, string | null> = {},
  ) {
    setSearch(value);
    update({ search: value || null, ...changes });
  }
  return { params, update, search, setSearch, updateSearch };
}

export function listPage(params: URLSearchParams, key = "page") {
  const page = Number(params.get(key));
  return Number.isSafeInteger(page) && page > 0 && page <= MAX_LIST_PAGE
    ? page
    : 0;
}
