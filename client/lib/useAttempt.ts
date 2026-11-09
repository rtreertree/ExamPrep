import { useEffect, useRef, useState } from "react";
import {
  responseChanges,
  mergeResponses,
  own,
  validateProgressChanges,
  writtenScore,
  type Responses,
} from "../../shared/attempts";
import { api, ApiError, type Attempt } from "./api";
import {
  listPracticeCheckpoints,
  makePracticeCheckpoint,
  planPracticeRecovery,
  putPracticeCheckpoint,
  removePracticeCheckpoint,
  type PracticeCheckpoint,
} from "./practiceRecovery";

export function useAttempt(initial: Attempt, userId: string) {
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
  const [sessionId] = useState(() => crypto.randomUUID());
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [checkpoints, setCheckpoints] = useState<PracticeCheckpoint[]>([]);
  const [recoveryError, setRecoveryError] = useState<Error>();
  const [checkpointStatus, setCheckpointStatus] = useState<
    "saving" | "saved" | "unavailable"
  >();
  const lastWrite = useRef(0);
  const restoreSources = useRef<PracticeCheckpoint[]>([]);
  const unacknowledged = useRef({ ids: new Set<string>(), position: false });

  function dismissRecovery() {
    setRecoveryError(undefined);
    setCheckpoints((current) => current.slice(1));
  }
  function addRecovery(checkpoint: PracticeCheckpoint) {
    const plan = planPracticeRecovery(checkpoint, base.current);
    if (!plan.safeCount && !plan.conflictCount && !plan.hasPosition)
      throw new Error(
        "This recovery copy has no unsaved changes for this attempt.",
      );
    setCheckpoints((current) => [checkpoint, ...current]);
  }
  function discardRecovery(checkpoint: PracticeCheckpoint) {
    dismissRecovery();
    void removePracticeCheckpoint(
      userId,
      initial.id,
      checkpoint.sessionId,
      checkpoint.token,
    ).catch(() => {
      setCheckpointStatus("unavailable");
    });
  }
  function localCopy() {
    return makePracticeCheckpoint(
      userId,
      sessionId,
      base.current,
      desired.current.responses,
      desired.current.position,
      unacknowledged.current,
    );
  }
  function saveCheckpoint() {
    const copy = localCopy();
    const pending =
      Object.keys(copy.changes).length > 0 ||
      copy.uncertainPosition ||
      (copy.baseStatus !== "completed" && copy.basePosition !== copy.position);
    const write = ++lastWrite.current;
    setCheckpointStatus(pending ? "saving" : undefined);
    const request = pending
      ? putPracticeCheckpoint(copy)
      : removePracticeCheckpoint(userId, initial.id, sessionId);
    void request
      .then(() => {
        if (lastWrite.current === write && pending)
          setCheckpointStatus("saved");
      })
      .catch(() => {
        if (lastWrite.current === write) setCheckpointStatus("unavailable");
      });
  }
  function restoreRecovery(checkpoint: PracticeCheckpoint, replace: boolean) {
    const current = base.current;
    const plan = planPracticeRecovery(checkpoint, current);
    if (plan.staleStatus) return;
    const changes = replace ? { ...plan.safe, ...plan.conflicts } : plan.safe;
    const nextPosition =
      plan.hasPosition && (!plan.positionConflict || replace)
        ? checkpoint.position
        : desired.current.position;
    try {
      const restored = validateProgressChanges(
        current.snapshot,
        current.status,
        current.responses,
        changes,
        nextPosition,
      );
      restoreSources.current.push(checkpoint);
      change(restored, nextPosition);
      dismissRecovery();
    } catch (error) {
      setRecoveryError(error as Error);
    }
  }
  function change(
    nextResponses: Responses,
    nextPosition = desired.current.position,
    immediate: boolean | "manual" = true,
  ) {
    if (submittingRef.current) return;
    if (
      base.current.status === "completed" &&
      nextResponses === desired.current.responses
    ) {
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
    saveCheckpoint();
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
          if (
            !entries.length &&
            (base.current.status === "completed" ||
              base.current.position === captured.position)
          ) {
            if (
              unacknowledged.current.ids.size ||
              unacknowledged.current.position
            )
              throw new ApiError(
                "An earlier save could not be confirmed. Load the latest progress to compare.",
                409,
              );
            confirmed.current = captured.generation;
            continue;
          }
          // A single legal response remains far below the request cap, even when
          // every Unicode character needs JSON escaping. Drain all edits before leaving.
          const changes = Object.fromEntries(entries.slice(0, 1));
          for (const id of Object.keys(changes))
            unacknowledged.current.ids.add(id);
          if (base.current.position !== captured.position)
            unacknowledged.current.position = true;
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
          unacknowledged.current = { ids: new Set(), position: false };
          const updated = {
            ...base.current,
            ...metadata,
            responses: savedResponses,
          };
          base.current = updated;
          setAttempt(updated);
          if (entries.length <= 1) confirmed.current = captured.generation;
          if (confirmed.current < desired.current.generation) saveCheckpoint();
        }
        const restored = restoreSources.current;
        restoreSources.current = [];
        for (const checkpoint of restored)
          void removePracticeCheckpoint(
            userId,
            initial.id,
            checkpoint.sessionId,
            checkpoint.token,
          ).catch(() => {
            setCheckpointStatus("unavailable");
          });
        saveCheckpoint();
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
    running.current = Promise.resolve().then(work);
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
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      setRecoveryReady(true);
      setCheckpointStatus("unavailable");
    }, 2000);
    void listPracticeCheckpoints(userId, initial.id)
      .then((entries) => {
        if (!active) return;
        setCheckpoints(
          entries.filter((checkpoint) => {
            const plan = planPracticeRecovery(checkpoint, initial);
            if (
              plan.safeCount ||
              plan.conflictCount ||
              (plan.hasPosition && initial.status !== "completed")
            )
              return true;
            // A failed request can still commit after the initial GET. Keep a
            // checkpoint at its base revision until a later server revision exists.
            if (
              !checkpoint.uncertain ||
              checkpoint.baseRevision !== initial.revision
            )
              void removePracticeCheckpoint(
                userId,
                initial.id,
                checkpoint.sessionId,
                checkpoint.token,
              ).catch(() => {});
            return false;
          }),
        );
      })
      .catch(() => {
        if (active) setCheckpointStatus("unavailable");
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active) setRecoveryReady(true);
      });
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [initial, userId]);
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
    recoveryReady,
    recovery: !dirty && !busy ? checkpoints[0] : undefined,
    recoveryError,
    checkpointStatus,
    localCopy,
    addRecovery,
    restoreRecovery,
    dismissRecovery,
    discardRecovery,
    conflict: error instanceof ApiError && error.status === 409,
  };
}
