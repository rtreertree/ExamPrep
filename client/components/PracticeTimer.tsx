import { useEffect, useState } from "react";

export function PracticeTimer({
  startedAt,
  minutes,
  exam = false,
}: {
  startedAt: string;
  minutes: number;
  exam?: boolean;
}) {
  const deadline = Date.parse(startedAt) + minutes * 60_000;
  const secondsLeft = () =>
    Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const [remaining, setRemaining] = useState(secondsLeft);
  useEffect(() => {
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [deadline]);
  if (!Number.isFinite(remaining)) return null;
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  if (exam) {
    const low = remaining > 0 && remaining <= 60;
    return (
      <div className={`exam-timer ${remaining <= 60 ? "warning" : "muted"}`}>
        {remaining > 0 ? (
          <p role="timer" aria-label="Time remaining">
            Time remaining <span className="mono">{countdown}</span>
          </p>
        ) : null}
        <p role="status">
          {remaining === 0 ? (
            "Time is up. Submit when you’re ready."
          ) : (
            <span className="sr-only">
              {low ? "One minute or less remaining." : ""}
            </span>
          )}
        </p>
      </div>
    );
  }
  return remaining > 0 ? (
    <p className="muted centered" role="timer">
      Time remaining · <span className="mono">{countdown}</span>
    </p>
  ) : (
    <p className="centered" role="status">
      Time is up. Submit when you’re ready.
    </p>
  );
}
