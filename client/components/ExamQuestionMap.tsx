import { useEffect, useId, useRef, useState } from "react";
import { Flag } from "lucide-react";
import { Button } from "./ui";

export type ExamQuestionStatus =
  | "Answered"
  | "Unanswered"
  | "Needs assessment"
  | "Assessed"
  | "Correct"
  | "Incorrect"
  | "Partial credit";

export type ExamMapItem = {
  id: string;
  status: ExamQuestionStatus;
  flagged: boolean;
  lowConfidence: boolean;
  mistake: boolean;
};

export function ExamQuestionMap({
  questions,
  position,
  stage,
  disabled,
  onJump,
}: {
  questions: ExamMapItem[];
  position: number;
  stage: "in_progress" | "reviewing" | "completed";
  disabled: boolean;
  onJump: (index: number) => void;
}) {
  const filterId = useId();
  const list = useRef<HTMLOListElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState("All questions");
  const filters = [
    { label: "All questions", matches: () => true },
    {
      label: "Unanswered",
      matches: (question: ExamMapItem) => question.status === "Unanswered",
    },
    { label: "Flagged", matches: (question: ExamMapItem) => question.flagged },
    ...(stage === "reviewing"
      ? [
          {
            label: "Needs assessment",
            matches: (question: ExamMapItem) =>
              question.status === "Needs assessment",
          },
        ]
      : []),
    ...(stage === "completed"
      ? [
          {
            label: "Needs review",
            matches: (question: ExamMapItem) => question.mistake,
          },
        ]
      : []),
    ...(stage !== "in_progress"
      ? [
          {
            label: "Low confidence",
            matches: (question: ExamMapItem) => question.lowConfidence,
          },
        ]
      : []),
  ];
  const selected = filters.find(({ label }) => label === filter) ?? filters[0];
  const visible = questions.flatMap((question, index) =>
    selected.matches(question) ? [{ question, index }] : [],
  );
  const currentVisible = visible.some(({ index }) => index === position);

  useEffect(() => {
    const container = list.current;
    const button = current.current;
    if (!container || !button) return;
    function revealCurrent(list: HTMLOListElement, row: HTMLButtonElement) {
      if (!list.clientHeight) return;
      const bounds = list.getBoundingClientRect();
      const { top, bottom } = row.getBoundingClientRect();
      if (top < bounds.top) list.scrollTop += top - bounds.top - 4;
      if (bottom > bounds.bottom) list.scrollTop += bottom - bounds.bottom + 4;
    }
    revealCurrent(container, button);
    const observer = new ResizeObserver(() => revealCurrent(container, button));
    observer.observe(container);
    return () => observer.disconnect();
  }, [position, selected.label, currentVisible]);

  return (
    <div className="exam-map">
      <label htmlFor={filterId}>Filter questions</label>
      <select
        id={filterId}
        value={selected.label}
        onChange={(event) => setFilter(event.target.value)}
      >
        {filters.map(({ label }) => (
          <option key={label}>{label}</option>
        ))}
      </select>
      {visible.length ? (
        <ol ref={list} className="exam-map-list" aria-label="Questions">
          {visible.map(({ question, index }) => {
            const active = index === position;
            return (
              <li key={question.id}>
                <Button
                  ref={active ? current : undefined}
                  className={active ? "selected" : ""}
                  aria-current={active ? "step" : undefined}
                  aria-label={`Question ${index + 1}, ${question.status}${question.flagged ? ", flagged" : ""}`}
                  disabled={disabled}
                  onClick={() => onJump(index)}
                >
                  <span className="mono">{index + 1}</span>
                  <span>{question.status}</span>
                  {question.flagged ? (
                    <Flag size={14} aria-hidden="true" />
                  ) : null}
                </Button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted" role="status">
          No questions match this filter.
        </p>
      )}
    </div>
  );
}
