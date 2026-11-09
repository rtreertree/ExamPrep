import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { itemsOf } from "../../shared/content";
import type { PracticeSettings } from "../../shared/attempts";
import { api, type StudySet } from "../lib/api";
import { Button, Dialog, ErrorNotice, Field } from "./ui";

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
    <Dialog title="Set up practice" onClose={onClose}>
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
  const kind = set.kind === "exam" ? "questions" : "cards";

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
      title="Set up practice"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {set.title} · {total} {kind} available
      </p>
      <div className="actions" aria-label="Practice presets">
        <Button
          disabled={busy}
          onClick={() => {
            setCount(String(Math.min(total, 10)));
            setOrder("shuffled");
            setMinutes("");
          }}
        >
          Quick practice
        </Button>
        {set.kind === "exam" ? (
          <Button
            disabled={busy}
            onClick={() => {
              setCount(String(total));
              setOrder("original");
              setMinutes("30");
            }}
          >
            Exam simulation
          </Button>
        ) : null}
      </div>
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
          <select
            value={order}
            disabled={busy}
            onChange={(event) =>
              setOrder(
                event.target.value === "shuffled" ? "shuffled" : "original",
              )
            }
          >
            <option value="original">Original order</option>
            <option value="shuffled">Shuffled order</option>
          </select>
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
            Start practice
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
