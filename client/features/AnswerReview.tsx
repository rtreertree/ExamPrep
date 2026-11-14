import {
  answered,
  maximum,
  writtenScore,
  type Response,
} from "../../shared/attempts";
import type { Question } from "../../shared/content";
import { Button } from "../components/ui";
import { StudyContent } from "../components/StudyContent";
import { RubricList } from "../components/RubricList";

export function AnswerReview({
  question: q,
  response: r,
  reviewing,
  busy,
  onChange,
}: {
  question: Question;
  response?: Response;
  reviewing: boolean;
  busy: boolean;
  onChange: (r: Response, immediate?: boolean | "manual") => void;
}) {
  const score =
    q.type === "single_choice"
      ? Number(r?.selectedOptionId === q.answer)
      : writtenScore(q, r);
  return (
    <section className="answer-review">
      {q.type === "written" ? (
        <div className="exam-answer-comparison">
          <section aria-label="Your submitted answer">
            <h3>Your answer</h3>
            {answered(q, r) ? (
              <StudyContent source={r?.text} label="your submitted answer" />
            ) : (
              <p className="muted">Unanswered</p>
            )}
          </section>
          <section aria-label="Reference answer">
            <h3>Reference answer</h3>
            <StudyContent source={q.answer} />
          </section>
        </div>
      ) : null}
      <h2>
        {score === null
          ? "Self-assessment needed"
          : `${score} / ${maximum(q)} points${q.type === "written" && answered(q, r) ? " · self-assessed" : ""}`}
      </h2>
      {q.type === "written" ? (
        answered(q, r) ? (
          q.rubric ? (
            <RubricList
              criteria={q.rubric}
              mode={reviewing ? "assess" : "review"}
              disabled={busy}
              awards={r?.criterionPoints}
              onAward={(id, points, commit) => {
                const criterionPoints = Object.assign(
                  Object.create(null),
                  r?.criterionPoints,
                );
                if (points === undefined) delete criterionPoints[id];
                else criterionPoints[id] = points;
                onChange(
                  { text: r!.text!, criterionPoints },
                  commit ? true : "manual",
                );
              }}
            />
          ) : reviewing ? (
            <div className="actions">
              <Button
                disabled={busy}
                aria-pressed={r?.selfAssessment === "incorrect"}
                onClick={() =>
                  onChange({ text: r!.text!, selfAssessment: "incorrect" })
                }
              >
                Incorrect · 0 points
              </Button>
              <Button
                disabled={busy}
                aria-pressed={r?.selfAssessment === "correct"}
                onClick={() =>
                  onChange({ text: r!.text!, selfAssessment: "correct" })
                }
              >
                Correct · 1 point
              </Button>
            </div>
          ) : (
            <p>
              {r?.selfAssessment === "correct"
                ? "Marked correct"
                : "Marked incorrect"}
            </p>
          )
        ) : null
      ) : (
        <p>
          {!r?.selectedOptionId
            ? "Unanswered"
            : r.selectedOptionId === q.answer
              ? "Correct"
              : "Incorrect"}
        </p>
      )}
      {q.explanation ? (
        <>
          <h3>Explanation</h3>
          <StudyContent source={q.explanation} label="explanation" />
        </>
      ) : null}
    </section>
  );
}
