import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
export function useResource<T>(path: string | null) {
  const [response, setResponse] = useState<{ path: string; data: T }>();
  const [settled, setSettled] = useState<{
    path: string;
    version: number;
    error?: Error;
  }>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setSettled(undefined);
    if (path === null) return;
    api<T>(path)
      .then((d) => {
        if (!live) return;
        setResponse({ path, data: d });
        setSettled({ path, version });
      })
      .catch((error) => {
        if (live) setSettled({ path, version, error });
      });
    return () => {
      live = false;
    };
  }, [path, version]);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const setData = useCallback(
    (data: T) => {
      if (path !== null) setResponse({ path, data });
    },
    [path],
  );
  const current = settled?.path === path && settled.version === version;
  return {
    data: response?.path === path ? response.data : undefined,
    lastData: response?.data,
    setData,
    error: current ? settled.error : undefined,
    loading: path !== null && !current,
    refresh,
  };
}
export function useUnsaved(dirty: boolean) {
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
}
