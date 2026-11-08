import { useEffect, useRef, useState } from "react";
import type { Responses } from "../../shared/attempts";
import { api, ApiError, type Attempt } from "./api";
export function useAttempt(initial: Attempt) {
  const [attempt, setAttempt] = useState(initial);
  const base = useRef(initial);
  const [responses, setResponses] = useState(initial.responses);
  const [position, setPosition] = useState(initial.position);
  const desired = useRef({
    responses: initial.responses,
    position: initial.position,
    generation: 0,
  });
  const confirmed = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const blocked = useRef(false);
  function change(
    nextResponses: Responses,
    nextPosition = desired.current.position,
    immediate: boolean | "manual" = true,
  ) {
    if (base.current.status === "completed") {
      setPosition(nextPosition);
      desired.current.position = nextPosition;
      return;
    }
    desired.current = {
      responses: nextResponses,
      position: nextPosition,
      generation: desired.current.generation + 1,
    };
    setResponses(nextResponses);
    setPosition(nextPosition);
    setDirty(true);
    setStatus("Unsaved changes");
    clearTimeout(timer.current);
    if (!blocked.current && immediate !== "manual")
      timer.current = setTimeout(
        () => {
          void flush();
        },
        immediate ? 0 : 500,
      );
  }
  async function flush(): Promise<boolean> {
    clearTimeout(timer.current);
    if (running.current) {
      const ok = await running.current;
      if (!ok) return false;
      return confirmed.current < desired.current.generation ? flush() : true;
    }
    if (confirmed.current === desired.current.generation) return true;
    const work = async () => {
      setBusy(true);
      setStatus("Saving…");
      setError(undefined);
      try {
        while (confirmed.current < desired.current.generation) {
          const captured = desired.current;
          const updated = await api<Attempt>(
            `/attempts/${initial.id}/progress`,
            "PATCH",
            {
              revision: base.current.revision,
              responses: captured.responses,
              position: captured.position,
            },
          );
          base.current = updated;
          setAttempt(updated);
          confirmed.current = captured.generation;
        }
        setDirty(false);
        setStatus("Saved");
        blocked.current = false;
        return true;
      } catch (e) {
        blocked.current = true;
        setStatus("Could not save");
        setError(e as Error);
        return false;
      } finally {
        setBusy(false);
        running.current = null;
      }
    };
    running.current = work();
    return running.current;
  }
  async function submit() {
    setSubmitting(true);
    if (!(await flush())) {
      setSubmitting(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api<Attempt>(
        `/attempts/${initial.id}/submit`,
        "POST",
        { revision: base.current.revision },
      );
      base.current = saved;
      setAttempt(saved);
      setResponses(saved.responses);
      desired.current.responses = saved.responses;
      setStatus("Saved");
    } catch (e) {
      setError(e as Error);
      setStatus("Could not save");
    } finally {
      setBusy(false);
      setSubmitting(false);
    }
  }
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  return {
    attempt,
    responses,
    position,
    change,
    flush,
    submit,
    dirty,
    busy,
    submitting,
    status,
    error,
    conflict: error instanceof ApiError && error.status === 409,
  };
}
