import { Selector } from "./Selector";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { itemsOf } from "../../shared/content";
import type { PracticeSettings } from "../../shared/attempts";
import { api, type StudySet } from "../lib/api";
import { Button, Dialog, ErrorNotice, Field } from "./ui";
import "./practice-setup.css";

export function PracticeSetup({
  set,
  onClose,
  returnTo,
}: {
  set: StudySet;
  onClose: () => void;
  returnTo?: string;
}) {
  const count = set.content ? itemsOf(set.content).length : set.count;
  return count ? (
    <PracticeSetupForm
      set={set}
      total={count}
      onClose={onClose}
      returnTo={returnTo}
    />
  ) : (
    <Dialog
      title={set.kind === "exam" ? "Set up exam" : "Set up practice"}
      onClose={onClose}
    >
      <ErrorNotice error={new Error("This set has no items to practice.")} />
    </Dialog>
  );
}

function PracticeSetupForm({
  set,
  total,
  onClose,
  returnTo,
}: {
  set: StudySet;
  total: number;
  onClose: () => void;
  returnTo?: string;
}) {
  const [count, setCount] = useState(String(total));
  const [order, setOrder] = useState<PracticeSettings["order"]>("original");
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const navigate = useNavigate();
  const presetId = useId();
  const isExam = set.kind === "exam";
  const kind = isExam ? "questions" : "cards";
  const quickCount = Math.min(total, 10);
  const quickSelected =
    Number(count) === quickCount && order === "shuffled" && minutes === "";
  const simulationSelected =
    Number(count) === total && order === "original" && Number(minutes) === 30;

  function selectQuickPractice() {
    setCount(String(quickCount));
    setOrder("shuffled");
    setMinutes("");
  }

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const attempt = await api<{ id: string }>(
        `/sets/${set.id}/attempts`,
        "POST",
        {
          count: Number(count),
          order,
          timerMinutes: minutes ? Number(minutes) : null,
        } satisfies PracticeSettings,
      );
      navigate(`/practice/${attempt.id}`, { state: { returnTo } });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={isExam ? "Set up exam" : "Set up practice"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {set.title} · {total} {kind} available
      </p>
      {isExam ? (
        <div className="exam-presets" role="group" aria-label="Exam presets">
          <Button
            aria-labelledby={`${presetId}-quick`}
            aria-describedby={`${presetId}-quick-description`}
            aria-pressed={quickSelected}
            className={quickSelected ? "selected" : ""}
            disabled={busy}
            onClick={selectQuickPractice}
          >
            <strong id={`${presetId}-quick`}>Quick practice</strong>
            <span id={`${presetId}-quick-description`} className="muted">
              {quickCount} shuffled{" "}
              {quickCount === 1 ? "question" : "questions"} · No timer
            </span>
          </Button>
          <Button
            aria-labelledby={`${presetId}-simulation`}
            aria-describedby={`${presetId}-simulation-description`}
            aria-pressed={simulationSelected}
            className={simulationSelected ? "selected" : ""}
            disabled={busy}
            onClick={() => {
              setCount(String(total));
              setOrder("original");
              setMinutes("30");
            }}
          >
            <strong id={`${presetId}-simulation`}>Exam simulation</strong>
            <span id={`${presetId}-simulation-description`} className="muted">
              Full set in original order · 30 minutes
            </span>
          </Button>
        </div>
      ) : (
        <div className="actions" aria-label="Practice presets">
          <Button disabled={busy} onClick={selectQuickPractice}>
            Quick practice
          </Button>
        </div>
      )}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <Field label={`Number of ${kind}`}>
          <input
            type="number"
            min={1}
            max={total}
            step={1}
            required
            disabled={busy}
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </Field>
        <Field label="Item order">
          <Selector
            value={order}
            disabled={busy}
            onValueChange={(value) =>
              setOrder(value === "shuffled" ? "shuffled" : "original")
            }
            options={[
              { value: "original", label: "Original order" },
              { value: "shuffled", label: "Shuffled order" },
            ]}
          />
        </Field>
        <Field
          label="Timer in minutes"
          hint="Leave blank for no timer. The countdown keeps running while you’re away. You choose when to submit."
        >
          <input
            type="number"
            min={1}
            max={600}
            step={1}
            disabled={busy}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </Field>
        <ErrorNotice error={error} />
        <div className="actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {isExam ? "Start exam" : "Start practice"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
