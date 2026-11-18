import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { itemsOf } from "../../shared/contentItems";
import type { PracticeSettings } from "../../shared/attempts";
import { api, type StudySet, type StudySetMetadata } from "../lib/api";
import { Selector } from "./Selector";
import { Button, Dialog, ErrorNotice, Field } from "./ui";
import "./practice-setup.css";

export type PracticeSet = Pick<
  StudySetMetadata,
  "id" | "title" | "kind" | "count"
> &
  Partial<Pick<StudySet, "content">>;

type Preset = "full" | "quick" | "simulation" | "custom";

export function PracticeSetup({
  set,
  onClose,
  returnTo,
}: {
  set: PracticeSet;
  onClose: () => void;
  returnTo?: string;
}) {
  const count = set.content ? itemsOf(set.content).length : set.count;
  const title = set.kind === "exam" ? "Set up exam" : "Set up practice";
  return count ? (
    <PracticeSetupForm
      title={title}
      set={set}
      total={count}
      onClose={onClose}
      returnTo={returnTo}
    />
  ) : (
    <Dialog title={title} onClose={onClose}>
      <ErrorNotice error={new Error("This set has no items to practice.")} />
    </Dialog>
  );
}

function PracticeSetupForm({
  title,
  set,
  total,
  onClose,
  returnTo,
}: {
  title: string;
  set: PracticeSet;
  total: number;
  onClose: () => void;
  returnTo?: string;
}) {
  const [preset, setPreset] = useState<Preset>("full");
  const [count, setCount] = useState(String(total));
  const [order, setOrder] = useState<PracticeSettings["order"]>("original");
  const [minutes, setMinutes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const navigate = useNavigate();
  const presetId = useId();
  const isExam = set.kind === "exam";
  const item = isExam ? "question" : "card";
  const presets = {
    full: { count: total, order: "original", timerMinutes: null },
    quick: {
      count: Math.min(total, 10),
      order: "shuffled",
      timerMinutes: null,
    },
    simulation: { count: total, order: "original", timerMinutes: 30 },
  } satisfies Record<Exclude<Preset, "custom">, PracticeSettings>;
  const options = [
    { value: "full", label: "Full set" },
    { value: "quick", label: "Quick practice" },
    ...(isExam
      ? ([{ value: "simulation", label: "Exam simulation" }] as const)
      : []),
    { value: "custom", label: "Customize" },
  ] as const;

  function choose(next: Preset) {
    if (next === "custom" && preset !== "custom") {
      const settings = presets[preset];
      setCount(String(settings.count));
      setOrder(settings.order);
      setMinutes(
        settings.timerMinutes === null ? "" : String(settings.timerMinutes),
      );
    }
    setPreset(next);
  }

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const settings: PracticeSettings =
      preset === "custom"
        ? {
            count: Number(count),
            order,
            timerMinutes: minutes ? Number(minutes) : null,
          }
        : presets[preset];
    try {
      const attempt = await api<{ id: string }>(
        `/sets/${set.id}/attempts`,
        "POST",
        settings,
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
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="practice-set-title">{set.title}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <fieldset className="practice-presets" disabled={busy}>
          <legend className="sr-only">Session preset</legend>
          {options.map(({ value, label }) => {
            const settings = value === "custom" ? null : presets[value];
            const descriptionId = `${presetId}-${value}-description`;
            return (
              <label className="practice-preset" key={value}>
                <input
                  type="radio"
                  name={presetId}
                  value={value}
                  checked={preset === value}
                  onChange={() => choose(value)}
                  aria-describedby={settings ? descriptionId : undefined}
                  aria-label={label}
                />
                <span>
                  <strong>{label}</strong>
                  {settings ? (
                    <span id={descriptionId} className="muted">
                      {settings.count} {item}
                      {settings.count === 1 ? "" : "s"} ·{" "}
                      {settings.order === "original"
                        ? "Original order"
                        : "Shuffled"}{" "}
                      ·{" "}
                      {settings.timerMinutes
                        ? `${settings.timerMinutes} minutes`
                        : "No timer"}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
        {preset === "custom" ? (
          <div className="practice-custom">
            <Field label={`Number of ${item}s`}>
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
          </div>
        ) : null}
        <ErrorNotice error={error} />
        <div className="dialog-footer actions practice-setup-actions">
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
