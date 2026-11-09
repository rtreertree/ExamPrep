import { useEffect, useState } from "react";

export function PracticeTimer({
  startedAt,
  minutes,
}: {
  startedAt: string;
  minutes: number;
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
  return remaining > 0 ? (
    <p className="muted centered" role="timer">
      Time remaining ·{" "}
      <span className="mono">
        {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
      </span>
    </p>
  ) : (
    <p className="centered" role="status">
      Time is up. Submit when you’re ready.
    </p>
  );
}
