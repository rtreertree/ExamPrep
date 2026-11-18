import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudySuggestion } from "../../shared/studySuggestion";
import { Button } from "../components/ui";

export function NextStudyAction({
  suggestion,
  returnTo,
  busy,
  onPractice,
}: {
  suggestion: StudySuggestion;
  returnTo: string;
  busy: boolean;
  onPractice: (
    set: Extract<StudySuggestion, { type: "practice" }>["set"],
  ) => void;
}) {
  const resuming = suggestion.type === "resume";
  const assessing = resuming && suggestion.status === "reviewing";
  const kind = resuming ? suggestion.kind : suggestion.set.kind;
  const title = resuming ? suggestion.title : suggestion.set.title;
  const item = kind === "exam" ? "question" : "card";
  const detail = resuming
    ? assessing
      ? suggestion.pendingCount === null
        ? "Written answers to assess"
        : `${suggestion.pendingCount} written ${suggestion.pendingCount === 1 ? "answer" : "answers"} to assess`
      : `${kind === "exam" ? "Question" : "Card"} ${suggestion.position + 1} of ${suggestion.total}`
    : `${suggestion.set.count} ${item}${suggestion.set.count === 1 ? "" : "s"}`;

  return (
    <section className="next-study-action" aria-label="Next study action">
      <div>
        <p className="next-study-label">
          {assessing
            ? "Assessment pending"
            : resuming
              ? suggestion.reviewMode
                ? "Spaced review in progress"
                : "Practice in progress"
              : "Suggested study set"}
        </p>
        <h2 title={title}>{title}</h2>
        <p className="muted">{detail}</p>
      </div>
      {resuming ? (
        <Link
          className="button primary"
          to={`/practice/${suggestion.id}`}
          state={{ returnTo }}
        >
          {assessing ? "Finish assessment" : "Resume"}
          <ArrowRight size={17} aria-hidden="true" />
        </Link>
      ) : (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => onPractice(suggestion.set)}
        >
          Set up practice <ArrowRight size={17} aria-hidden="true" />
        </Button>
      )}
    </section>
  );
}
