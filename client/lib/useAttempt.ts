import { useEffect, useRef, useState } from "react";
import {
  responseChanges,
  mergeResponses,
  own,
  writtenScore,
  type Responses,
} from "../../shared/attempts";
import { api, ApiError, type Attempt } from "./api";
export function useAttempt(initial: Attempt) {
  const [attempt, setAttempt] = useState(initial);
  const base = useRef(initial);
  const [responses, setResponses] = useState(initial.responses);
  const firstPending =
    initial.status === "reviewing" && initial.snapshot.kind === "exam"
      ? initial.snapshot.questions.findIndex(
          (q) =>
            q.type === "written" &&
            writtenScore(q, own(initial.responses, q.id)) === null,
        )
      : -1;
  const startPosition = firstPending >= 0 ? firstPending : initial.position;
  const [position, setPosition] = useState(startPosition);
  const desired = useRef({
    responses: initial.responses,
    position: startPosition,
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
  const submittingRef = useRef(false);
  function change(
    nextResponses: Responses,
    nextPosition = desired.current.position,
    immediate: boolean | "manual" = true,
  ) {
    if (submittingRef.current) return;
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
          const entries = Object.entries(
            responseChanges(base.current.responses, captured.responses),
          );
          // A single legal response remains far below the request cap, even when
          // every Unicode character needs JSON escaping. Drain all edits before leaving.
          const changes = Object.fromEntries(entries.slice(0, 1));
          const savedResponses = mergeResponses(
            base.current.responses,
            changes,
          );
          const metadata = await api<Omit<Attempt, "snapshot" | "responses">>(
            `/attempts/${initial.id}/progress`,
            "PATCH",
            {
              revision: base.current.revision,
              changes,
              position: captured.position,
            },
          );
          const updated = {
            ...base.current,
            ...metadata,
            responses: savedResponses,
          };
          base.current = updated;
          setAttempt(updated);
          if (entries.length <= 1) confirmed.current = captured.generation;
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
  async function moveTo(index: number) {
    if (submittingRef.current || !(await flush())) return false;
    // Read desired here, after the wait, never a render-captured response map.
    change(desired.current.responses, index);
    return true;
  }
  async function submit(): Promise<boolean> {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSubmitting(true);
    if (!(await flush())) {
      submittingRef.current = false;
      setSubmitting(false);
      return false;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api<Attempt>(
        `/attempts/${initial.id}/submit?compact=1`,
        "POST",
        { revision: base.current.revision },
      );
      const updated = {
        ...base.current,
        ...saved,
        responses: base.current.responses,
      };
      base.current = updated;
      setAttempt(updated);
      setResponses(updated.responses);
      desired.current.responses = updated.responses;
      if (updated.status === "reviewing" && updated.snapshot.kind === "exam") {
        const pending = updated.snapshot.questions.findIndex(
          (q) =>
            q.type === "written" &&
            writtenScore(q, own(updated.responses, q.id)) === null,
        );
        if (pending >= 0) {
          desired.current.position = pending;
          setPosition(pending);
        }
      }
      setStatus("Saved");
      return true;
    } catch (e) {
      setError(e as Error);
      setStatus("Could not save");
      return false;
    } finally {
      setBusy(false);
      submittingRef.current = false;
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
    moveTo,
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
