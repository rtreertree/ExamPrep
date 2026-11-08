import { useEffect, useState } from "react";
import type { Card } from "../../shared/content";
import { Button } from "./ui";
import { StudyContent } from "./StudyContent";
import { SurfaceLight } from "./SurfaceLight";
export function FlashcardStage({
  card,
  position,
  revealed,
  busy,
  onReveal,
  onRate,
}: {
  card: Card;
  position: number;
  revealed: boolean;
  busy: boolean;
  onReveal: () => void;
  onRate: (rating: "known" | "review_again") => void;
}) {
  const [back, setBack] = useState(revealed);
  const [flipping, setFlipping] = useState(false);
  useEffect(() => {
    if (!revealed || back) return;
    const media = matchMedia(
      "(prefers-reduced-motion: reduce), (max-height: 600px)",
    );
    if (media.matches) {
      setBack(true);
      return;
    }
    setFlipping(true);
    const swap = setTimeout(() => setBack(true), 240);
    const settle = setTimeout(() => setFlipping(false), 480);
    const reduce = () => {
      if (media.matches) {
        clearTimeout(swap);
        clearTimeout(settle);
        setBack(true);
        setFlipping(false);
      }
    };
    media.addEventListener("change", reduce);
    return () => {
      clearTimeout(swap);
      clearTimeout(settle);
      media.removeEventListener("change", reduce);
    };
    // `back` is the accessible face swapped by the timer, not a new reveal request.
  }, [revealed]);
  return (
    <>
      <SurfaceLight
        className={`flashcard-stage ${flipping ? "flipping" : ""}`}
        aria-live="polite"
      >
        <p className="card-face-label">{back ? "Answer" : "Question"}</p>
        <div className="study-prompt">
          <StudyContent
            source={back ? card.back : card.front}
            label={`card ${position + 1} ${back ? "back" : "front"}`}
          />
        </div>
      </SurfaceLight>
      {back ? (
        <details>
          <summary>Show question</summary>
          <StudyContent source={card.front} label="revealed card question" />
        </details>
      ) : null}
      {flipping ? (
        <p className="muted" role="status">
          Revealing answer…
        </p>
      ) : back ? (
        <div className="rating-actions">
          <Button disabled={busy} onClick={() => onRate("review_again")}>
            Review again
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => onRate("known")}
          >
            Known
          </Button>
        </div>
      ) : (
        <Button variant="primary" disabled={busy} onClick={onReveal}>
          Reveal answer
        </Button>
      )}
    </>
  );
}
