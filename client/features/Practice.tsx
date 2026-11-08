import { NotationEditor } from "../components/NotationEditor";
import { useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { itemsOf, type Question } from "../../shared/content";
import {
  answered,
  maximum,
  mistakes,
  own,
  writtenScore,
  type Response,
} from "../../shared/attempts";
import { api, download, type Attempt } from "../lib/api";
import { useResource, useUnsaved } from "../lib/hooks";
import { useAttempt } from "../lib/useAttempt";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  LoadingRows,
  Notice,
  SaveStatus,
} from "../components/ui";
import { StudyContent } from "../components/StudyContent";
import { RubricList } from "../components/RubricList";
import { ScoreSummary } from "../components/ScoreSummary";
import { FlashcardStage } from "../components/FlashcardStage";
export function PracticePage() {
  const { id } = useParams();
  const { data, error, loading, refresh } = useResource<Attempt>(
    `/attempts/${id}`,
  );
  if (loading)
    return (
      <div className="focus-loading">
        <LoadingRows />
      </div>
    );
  if (error)
    return (
      <div className="focus-loading">
        <Link to="/">← Library</Link>
        <ErrorNotice error={error} retry={refresh} />
      </div>
    );
  return data ? <Practice key={data.id} initial={data} /> : null;
}
function Practice({ initial }: { initial: Attempt }) {
  const state = useAttempt(initial);
  const { attempt, position, responses, busy, dirty } = state;
  const doc = attempt.snapshot;
  const items = itemsOf(doc);
  const item = items[position];
  const r = own(responses, item.id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [retryError, setRetryError] = useState<Error>();
  const [retrying, setRetrying] = useState(false);
  useUnsaved(dirty);
  const blocker = useBlocker(dirty);
  function response(
    next: Response | undefined,
    immediate: boolean | "manual" = true,
  ) {
    const values = Object.assign(Object.create(null), responses);
    if (next) values[item.id] = next;
    else delete values[item.id];
    state.change(values, position, immediate);
  }
  async function go(index: number) {
    if (busy || !(await state.flush())) return;
    state.change(responses, index);
    setNavOpen(false);
  }
  async function rate(rating: "known" | "review_again") {
    if (busy) return;
    const values = { ...responses, [item.id]: { revealed: true, rating } };
    state.change(values, Math.min(position + 1, items.length - 1));
    await state.flush();
  }
  async function retry() {
    setRetrying(true);
    setRetryError(undefined);
    try {
      const next = await api<Attempt>(
        `/attempts/${attempt.id}/retry`,
        "POST",
        {},
      );
      navigate(`/practice/${next.id}`);
    } catch (e) {
      setRetryError(e as Error);
    } finally {
      setRetrying(false);
    }
  }
  const inProgress = attempt.status === "in_progress";
  const eligible =
    attempt.status === "completed" ? mistakes(doc, responses) : null;
  const retryCount = eligible ? itemsOf(eligible).length : 0;
  const unanswered =
    doc.kind === "exam"
      ? doc.questions.filter((q) => !answered(q, own(responses, q.id))).length
      : doc.cards.filter((c) => !own(responses, c.id)?.rating).length;
  return (
    <div className="practice-frame">
      <header className="focus-header frosted-navigation">
        <div className="focus-brand">
          <Link className="button secondary" to="/">
            <ArrowLeft size={18} />
            Library
          </Link>
          <span className="wordmark">Exam Prep</span>
        </div>
        <strong>{doc.title}</strong>
        <SaveStatus
          state={state.status}
          retry={
            state.error && !state.conflict
              ? () => void state.flush()
              : undefined
          }
        />
      </header>
      <div className="focus-main">
        <div className="practice-progress">
          <progress
            max={items.length}
            value={position + 1}
            aria-label="Study position"
          />
          <Button variant="quiet" onClick={() => setNavOpen(true)}>
            {doc.kind === "exam" ? "Question" : "Card"} {position + 1} of{" "}
            {items.length}
          </Button>
        </div>
        <ErrorNotice error={state.error} />
        {state.conflict ? (
          <Notice tone="warning">
            <p>
              A newer save exists. Your current answers remain here. Download
              them before loading the confirmed progress.
            </p>
            <div className="actions">
              <Button
                onClick={() =>
                  download(
                    JSON.stringify({ position, responses }, null, 2),
                    "unsaved-practice.json",
                  )
                }
              >
                Download my unsaved answers
              </Button>
              <Button onClick={() => window.location.reload()}>
                Load confirmed progress
              </Button>
            </div>
          </Notice>
        ) : null}
        {attempt.sourceAttemptId ? (
          <p className="muted">
            Retry from{" "}
            <Link to={`/practice/${attempt.sourceAttemptId}`}>
              a previous attempt
            </Link>
          </p>
        ) : null}
        {!inProgress ? (
          <section className="results-intro">
            <h1>
              {attempt.status === "reviewing"
                ? "Finish self-assessment"
                : doc.kind === "exam"
                  ? "Exam results"
                  : "Session complete"}
            </h1>
            <p className="muted">
              {attempt.status === "reviewing"
                ? "Your submitted answers are frozen. Compare your written work with the reference answers."
                : "Your results are saved to your account."}
            </p>
            <ScoreSummary result={attempt.result} />
            {attempt.status === "completed" ? (
              <div className="actions">
                <Button
                  variant="primary"
                  disabled={!retryCount}
                  busy={retrying}
                  onClick={() => void retry()}
                >
                  {retryCount
                    ? `${doc.kind === "exam" ? "Retry mistakes" : "Review again"} (${retryCount})`
                    : "No mistakes to retry"}
                </Button>
                <Link className="button secondary" to="/history">
                  View history
                </Link>
              </div>
            ) : null}
            <ErrorNotice error={retryError} />
          </section>
        ) : null}
        {doc.kind === "exam" && "type" in item ? (
          <section className="question-stage" key={item.id}>
            <div className="question-heading">
              <span className="question-number mono">
                {String(position + 1).padStart(2, "0")}
              </span>
              <div>
                <p className="muted">
                  {item.type === "single_choice"
                    ? "Single choice"
                    : "Written answer"}
                </p>
                <div className="study-prompt">
                  <StudyContent
                    source={item.prompt}
                    label={`question ${position + 1}`}
                  />
                </div>
              </div>
            </div>
            {item.type === "single_choice" ? (
              <fieldset
                className="answer-options"
                disabled={!inProgress || busy}
              >
                <legend className="sr-only">Choose one answer</legend>
                {item.options.map((option, i) => (
                  <label
                    className={`answer-option ${r?.selectedOptionId === option.id ? "selected" : ""} ${!inProgress && option.id === item.answer ? "correct" : ""} ${!inProgress && r?.selectedOptionId === option.id && option.id !== item.answer ? "incorrect" : ""}`}
                    key={option.id}
                  >
                    <input
                      type="radio"
                      name={item.id}
                      value={option.id}
                      checked={r?.selectedOptionId === option.id}
                      onChange={() => response({ selectedOptionId: option.id })}
                    />
                    <span className="mono">{String.fromCharCode(65 + i)}.</span>
                    <StudyContent
                      source={option.text}
                      label={`option ${i + 1}`}
                    />
                    {!inProgress && option.id === item.answer ? (
                      <span className="result-label positive">
                        Correct answer
                      </span>
                    ) : null}
                  </label>
                ))}
                {inProgress && r ? (
                  <Button variant="quiet" onClick={() => response(undefined)}>
                    Clear answer
                  </Button>
                ) : null}
              </fieldset>
            ) : (
              <>
                <Field
                  label="Your answer"
                  hint={
                    inProgress
                      ? "Write your reasoning. Markdown and LaTeX are supported."
                      : undefined
                  }
                >
                  <NotationEditor
                    key={item.id}
                    answerType={item.answerType}
                    className="written-answer"
                    readOnly={!inProgress || state.submitting}
                    value={r?.text ?? ""}
                    onChange={(value) => response({ text: value }, false)}
                  />
                </Field>
                {r?.text ? (
                  <details className="answer-preview">
                    <summary>Preview your answer</summary>
                    <StudyContent source={r.text} label="your answer" />
                  </details>
                ) : null}
              </>
            )}
            {!inProgress ? (
              <AnswerReview
                question={item}
                response={r}
                reviewing={attempt.status === "reviewing"}
                busy={busy}
                onChange={response}
              />
            ) : null}
          </section>
        ) : doc.kind === "flashcards" && "front" in item ? (
          <>
            {inProgress ? (
              <>
                <FlashcardStage
                  key={item.id}
                  card={item}
                  position={position}
                  revealed={!!r?.revealed}
                  busy={busy}
                  onReveal={() => response({ revealed: true })}
                  onRate={(rating) => void rate(rating)}
                />
                {r?.rating ? (
                  <p className="muted">
                    Saved rating:{" "}
                    {r.rating === "known" ? "Known" : "Review again"}
                  </p>
                ) : null}
              </>
            ) : (
              <div className="flashcard-review">
                <h2>Card {position + 1}</h2>
                <StudyContent source={item.front} label="card front" />
                <h3>Answer</h3>
                <StudyContent source={item.back} label="card back" />
                <p className="muted">
                  Rating:{" "}
                  {r?.rating === "known"
                    ? "Known"
                    : r?.rating === "review_again"
                      ? "Review again"
                      : "Unreviewed"}
                </p>
              </div>
            )}
          </>
        ) : null}
        <footer className="study-footer">
          <Button
            disabled={position === 0 || busy}
            onClick={() => void go(position - 1)}
          >
            <ArrowLeft size={16} />
            Previous
          </Button>
          <span className="mono muted footer-count">
            {position + 1} / {items.length}
          </span>
          <div className="actions">
            {position < items.length - 1 ? (
              <Button
                variant={
                  inProgress && doc.kind === "exam" ? "primary" : "secondary"
                }
                disabled={busy}
                onClick={() => void go(position + 1)}
              >
                Next
                <ArrowRight size={16} />
              </Button>
            ) : null}
            {inProgress ? (
              <Button
                variant={
                  doc.kind === "exam" && position === items.length - 1
                    ? "primary"
                    : "secondary"
                }
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                {doc.kind === "exam" ? "Submit exam" : "Finish session"}
              </Button>
            ) : null}
          </div>
        </footer>
        {inProgress && doc.kind === "flashcards" ? (
          <p className="muted centered">Your ratings are saved as you go.</p>
        ) : null}
      </div>
      {confirm ? (
        <Dialog
          title={
            doc.kind === "exam" ? "Submit this exam?" : "Finish this session?"
          }
          onClose={() => setConfirm(false)}
        >
          <p>
            {unanswered}{" "}
            {doc.kind === "exam"
              ? "unanswered questions will receive zero. Submitted answers cannot be changed."
              : "unreviewed cards will be included in your summary. Only cards rated Review again appear in a retry."}
          </p>
          <div className="actions">
            <Button onClick={() => setConfirm(false)}>Keep studying</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                await state.submit();
                setConfirm(false);
              }}
            >
              {doc.kind === "exam" ? "Submit exam" : "Finish session"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {navOpen ? (
        <Dialog
          title={
            doc.kind === "exam" ? "Question navigation" : "Card navigation"
          }
          onClose={() => setNavOpen(false)}
        >
          <div className="question-nav">
            {items.map((it, i) => (
              <Button
                disabled={busy}
                className={i === position ? "selected" : ""}
                key={it.id}
                onClick={() => void go(i)}
              >
                {i + 1} ·{" "}
                {doc.kind === "exam" && "type" in it
                  ? answered(it, own(responses, it.id))
                    ? "Answered"
                    : "Unanswered"
                  : own(responses, it.id)?.rating
                    ? "Rated"
                    : "Unreviewed"}
              </Button>
            ))}
          </div>
        </Dialog>
      ) : null}
      {blocker.state === "blocked" ? (
        <Dialog
          title="Progress is not saved yet"
          onClose={() => blocker.reset()}
        >
          <p>
            Save your latest progress before leaving, or return to keep working.
          </p>
          <div className="actions">
            <Button onClick={() => blocker.reset()}>Return to practice</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                if (await state.flush()) blocker.proceed();
              }}
            >
              Save and leave
            </Button>
            <Button variant="quiet" onClick={() => blocker.proceed()}>
              Leave without saving
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
function AnswerReview({
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
      <h2>
        {score === null
          ? "Self-assessment needed"
          : `${score} / ${maximum(q)} points${q.type === "written" ? " · self-assessed" : ""}`}
      </h2>
      {q.type === "written" ? (
        <>
          <h3>Reference answer</h3>
          <StudyContent source={q.answer} label="reference answer" />
          {!answered(q, r) ? (
            <Notice>Unanswered · zero points</Notice>
          ) : q.rubric ? (
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
                onClick={() =>
                  onChange({ text: r!.text!, selfAssessment: "incorrect" })
                }
              >
                Incorrect · 0 points
              </Button>
              <Button
                disabled={busy}
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
          )}
        </>
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
