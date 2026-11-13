import { Selector } from "../components/Selector";
import { NotationEditor } from "../components/NotationEditor";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { ArrowLeft, ArrowRight, Flag, List } from "lucide-react";
import { itemsOf, type Question } from "../../shared/content";
import {
  answered,
  MAX_NOTE_CHARACTERS,
  maximum,
  mistakes,
  own,
  retrySnapshot,
  writtenScore,
  type Response,
  type RetryMode,
} from "../../shared/attempts";
import { api, download, type Attempt } from "../lib/api";
import { useResource, useUnsaved } from "../lib/hooks";
import { useAttempt } from "../lib/useAttempt";
import { useAuth } from "../lib/auth";
import {
  planPracticeRecovery,
  readPracticeRecoveryFile,
  type PracticeCheckpoint,
} from "../lib/practiceRecovery";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  LoadingRows,
  Notice,
  SaveStatus,
  Tabs,
} from "../components/ui";
import { StudyContent } from "../components/StudyContent";
import { RubricList } from "../components/RubricList";
import { ScoreSummary } from "../components/ScoreSummary";
import { FlashcardStage } from "../components/FlashcardStage";
import { PracticeTimer } from "../components/PracticeTimer";
import {
  ExamQuestionMap,
  type ExamMapItem,
  type ExamQuestionStatus,
} from "../components/ExamQuestionMap";
import "./exam-practice.css";
export function PracticePage() {
  const { id } = useParams();
  const previous = useLocation().state?.returnTo;
  const returnTo =
    typeof previous === "string" &&
    /^(\/($|\?)|\/history($|\?)|\/review\/[^/?#]+($|\?))/.test(previous)
      ? previous
      : "/";
  const returnLabel = returnTo.startsWith("/history")
    ? "History"
    : returnTo.startsWith("/review/")
      ? "Review queue"
      : "Library";
  const { data, error, loading, refresh } = useResource<Attempt>(
    `/attempts/${id}`,
  );
  if (loading)
    return (
      <div className="focus-loading">
        <LoadingRows label="Loading practice session" />
      </div>
    );
  if (error)
    return (
      <div className="focus-loading">
        <Link to={returnTo}>← {returnLabel}</Link>
        <ErrorNotice error={error} retry={refresh} />
      </div>
    );
  return data ? (
    <Practice
      key={data.id}
      initial={data}
      returnTo={returnTo}
      returnLabel={returnLabel}
    />
  ) : null;
}
function Practice({
  initial,
  returnTo,
  returnLabel,
}: {
  initial: Attempt;
  returnTo: string;
  returnLabel: string;
}) {
  const { user } = useAuth();
  const state = useAttempt(initial, user!.id);
  const { attempt, position, responses, busy, dirty } = state;
  const doc = attempt.snapshot;
  const isExam = doc.kind === "exam";
  const items = itemsOf(doc);
  const item = items[position];
  const r = own(responses, item.id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [retryError, setRetryError] = useState<Error>();
  const [recoveryFileError, setRecoveryFileError] = useState<Error>();
  const [retrying, setRetrying] = useState(false);
  const [navFilter, setNavFilter] = useState("all");
  const [lastRating, setLastRating] = useState<{
    id: string;
    index: number;
    previous?: Response;
  }>();
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const questionHeading = useRef<HTMLHeadingElement>(null);
  const questionStage = useRef<HTMLElement>(null);
  const moving = useRef(false);
  const [focusQuestion, setFocusQuestion] = useState<number>();
  useEffect(() => {
    if (attempt.status === "in_progress" || !state.recoveryReady) return;
    const frame = requestAnimationFrame(() => resultHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [attempt.status, state.recoveryReady]);
  useEffect(() => {
    if (focusQuestion !== position || navOpen || confirm) return;
    const frame = requestAnimationFrame(() => {
      questionHeading.current?.focus({ preventScroll: true });
      const top = questionStage.current?.getBoundingClientRect().top;
      if (top !== undefined && (top < 0 || top > window.innerHeight / 2)) {
        questionStage.current?.scrollIntoView({
          block: "start",
          behavior: "instant",
        });
      }
      setFocusQuestion(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusQuestion, position, navOpen, confirm]);
  useUnsaved(dirty);
  const blocker = useBlocker(dirty);
  function response(
    next: Response | undefined,
    immediate: boolean | "manual" = true,
  ) {
    const { flagged, confidence, note } = r ?? {};
    updateResponse({ flagged, confidence, note, ...next }, immediate);
  }
  function updateResponse(
    next: Response,
    immediate: boolean | "manual" = true,
  ) {
    const values = Object.assign(Object.create(null), responses);
    if (Object.values(next).some((value) => value !== undefined))
      values[item.id] = next;
    else delete values[item.id];
    state.change(values, position, immediate);
  }
  async function go(index: number) {
    if (!isExam) {
      if (await state.moveTo(index)) setNavOpen(false);
      return;
    }
    if (moving.current) return;
    moving.current = true;
    try {
      if (await state.moveTo(index)) {
        setNavOpen(false);
        setConfirm(false);
        setFocusQuestion(index);
      }
    } finally {
      moving.current = false;
    }
  }
  function toggleFlag() {
    updateResponse({ ...r, flagged: r?.flagged ? undefined : true });
  }
  async function rate(rating: "known" | "review_again") {
    if (busy) return;
    setLastRating({ id: item.id, index: position, previous: r });
    const values = {
      ...responses,
      [item.id]: { ...r, revealed: true, rating },
    };
    state.change(values, Math.min(position + 1, items.length - 1));
    await state.flush();
  }
  async function retry(mode: RetryMode = "mistakes") {
    setRetrying(true);
    setRetryError(undefined);
    try {
      if (!(await state.flush())) return;
      const next = await api<Attempt>(`/attempts/${attempt.id}/retry`, "POST", {
        mode,
      });
      navigate(`/practice/${next.id}`, { state: { returnTo } });
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
  const flagged =
    !isExam || !inProgress ? retrySnapshot(doc, responses, "flagged") : null;
  const uncertain =
    !isExam || !inProgress
      ? retrySnapshot(doc, responses, "low_confidence")
      : null;
  const incorrectIds = new Set(
    eligible ? itemsOf(eligible).map((i) => i.id) : [],
  );
  const examMapItems = isExam
    ? doc.questions.map((question): ExamMapItem => {
        const answer = own(responses, question.id);
        return {
          id: question.id,
          status: examQuestionStatus(question, answer, attempt.status),
          flagged: answer?.flagged === true,
          lowConfidence: answer?.confidence === "low",
          mistake: incorrectIds.has(question.id),
        };
      })
    : [];
  const pending = examMapItems.flatMap(({ status }, index) =>
    status === "Needs assessment" ? [index] : [],
  );
  const nextPending = pending.find((i) => i > position) ?? pending[0];
  const writtenAnswered =
    doc.kind === "exam"
      ? doc.questions.filter(
          (q) => q.type === "written" && answered(q, own(responses, q.id)),
        ).length
      : 0;
  const omissions = items.flatMap((it, i) =>
    (
      "type" in it
        ? !answered(it, own(responses, it.id))
        : !own(responses, it.id)?.rating
    )
      ? [i]
      : [],
  );
  const unanswered = omissions.length;
  const flaggedCount = examMapItems.filter(
    (question) => question.flagged,
  ).length;
  const firstMistake = examMapItems.findIndex((question) => question.mistake);
  const confirmedPending =
    attempt.result?.selfAssessed?.pendingCount ?? pending.length;
  function recoveryDownload(checkpoint = state.localCopy()) {
    download(
      JSON.stringify(
        {
          ...checkpoint,
          title: doc.title,
          prompts: Object.fromEntries(
            items
              .filter((it) => Object.hasOwn(checkpoint.changes, it.id))
              .map((it) => [it.id, "prompt" in it ? it.prompt : it.front]),
          ),
        },
        null,
        2,
      ),
      "practice-answer-recovery.json",
    );
  }
  function cardState(it: typeof item) {
    return own(responses, it.id)?.rating ? "Rated" : "Unreviewed";
  }
  const questionMap = isExam ? (
    <ExamQuestionMap
      key={attempt.status}
      questions={examMapItems}
      position={position}
      stage={attempt.status}
      disabled={state.submitting}
      onJump={(index) => void go(index)}
    />
  ) : null;
  if (!state.recoveryReady)
    return (
      <div className="focus-loading">
        <LoadingRows />
      </div>
    );
  return (
    <div className={`practice-frame${isExam ? " exam-frame" : ""}`}>
      <header className="focus-header frosted-navigation">
        <div className="focus-brand">
          <Link className="button secondary" to={returnTo}>
            <ArrowLeft size={18} />
            {returnLabel}
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
      <main className="focus-main">
        {isExam ? (
          <div className="exam-progress">
            <div className="exam-progress-header">
              {inProgress ? (
                <p role="status" className="muted">
                  <strong>
                    {items.length - unanswered} of {items.length} answered
                  </strong>
                </p>
              ) : null}
              {inProgress && attempt.settings?.timerMinutes ? (
                <PracticeTimer
                  startedAt={attempt.startedAt}
                  minutes={attempt.settings.timerMinutes}
                  exam
                />
              ) : null}
              <Button
                className="exam-picker"
                aria-haspopup="dialog"
                onClick={() => setNavOpen(true)}
              >
                <List size={16} aria-hidden="true" />
                Question {position + 1} of {items.length}
              </Button>
            </div>
            {inProgress ? (
              <progress
                max={items.length}
                value={items.length - unanswered}
                aria-label="Questions answered"
              />
            ) : null}
          </div>
        ) : (
          <>
            {inProgress && attempt.settings?.timerMinutes ? (
              <PracticeTimer
                startedAt={attempt.startedAt}
                minutes={attempt.settings.timerMinutes}
              />
            ) : null}
            <div className="practice-progress">
              <progress
                max={items.length}
                value={position + 1}
                aria-label="Study position"
              />
              <Button variant="quiet" onClick={() => setNavOpen(true)}>
                Card {position + 1} of {items.length}
              </Button>
            </div>
            <p role="status" className="muted completion-count">
              {items.length - unanswered} rated · {unanswered} unreviewed
            </p>
            <span className="sr-only" aria-live="polite">
              Card {position + 1} of {items.length}.{" "}
              {attempt.status === "completed"
                ? "Assessment and saving complete."
                : ""}
            </span>
          </>
        )}
        <ErrorNotice error={state.error} />
        {state.error ? (
          <Notice tone="warning">
            <p>
              {state.checkpointStatus === "saved"
                ? "Could not confirm a save. A recovery checkpoint is saved on this device. You can restore it the next time you open this attempt."
                : "Could not confirm a save. Retry, or download a recovery copy before leaving."}
            </p>
            <Button onClick={() => recoveryDownload()}>
              Download my unsaved answers
            </Button>
          </Notice>
        ) : null}
        {state.conflict ? (
          <Notice tone="warning">
            <p>
              A newer save exists. Load it to compare with your local progress.
            </p>
            <div className="actions">
              <Button onClick={() => window.location.reload()}>
                Load confirmed progress
              </Button>
            </div>
          </Notice>
        ) : null}
        {attempt.sourceAttemptId ? (
          <p className="muted">
            Retry from{" "}
            <Link
              to={`/practice/${attempt.sourceAttemptId}`}
              state={{ returnTo }}
            >
              a previous attempt
            </Link>
          </p>
        ) : null}
        {!inProgress ? (
          <section className="results-intro">
            <h1 ref={resultHeading} tabIndex={-1}>
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
            {attempt.status === "completed" ? (
              <p className="muted">
                This attempt uses the original version of the set from when you
                began.
                {attempt.sourceAttemptId
                  ? " This retry score covers only its subset of items."
                  : ""}
              </p>
            ) : null}
            <ScoreSummary result={attempt.result} />
            {attempt.status === "reviewing" ? (
              <div className="assessment-queue">
                <p role="status">
                  {writtenAnswered - confirmedPending} of {writtenAnswered}{" "}
                  written answers assessed. Written score is provisional until
                  all assessments save.
                </p>
              </div>
            ) : null}
            {attempt.status === "completed" && retryCount && !isExam ? (
              <details>
                <summary>{retryCount} cards to review again</summary>
                <div className="question-nav">
                  {items.map((it, i) =>
                    incorrectIds.has(it.id) ? (
                      <Button key={it.id} onClick={() => void go(i)}>
                        Card {i + 1} · {cardState(it)}
                      </Button>
                    ) : null,
                  )}
                </div>
              </details>
            ) : null}
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
                    : doc.kind === "exam"
                      ? "No mistakes to retry"
                      : "No cards rated Review again"}
                </Button>
                {firstMistake >= 0 ? (
                  <Button onClick={() => void go(firstMistake)}>
                    Review first mistake
                  </Button>
                ) : null}
                {doc.kind === "flashcards" && unanswered > 0 ? (
                  <Button
                    busy={retrying}
                    onClick={() => void retry("unreviewed")}
                  >
                    Study unreviewed cards ({unanswered})
                  </Button>
                ) : null}
                {flagged ? (
                  <Button busy={retrying} onClick={() => void retry("flagged")}>
                    Practice flagged items ({itemsOf(flagged).length})
                  </Button>
                ) : null}
                {uncertain ? (
                  <Button
                    busy={retrying}
                    onClick={() => void retry("low_confidence")}
                  >
                    Practice low-confidence items ({itemsOf(uncertain).length})
                  </Button>
                ) : null}
                {attempt.reviewMode && attempt.studySetId ? (
                  <Link
                    className="button secondary"
                    to={`/review/${attempt.studySetId}`}
                  >
                    Return to review queue
                  </Link>
                ) : null}
                <Link className="button secondary" to="/history">
                  View history
                </Link>
              </div>
            ) : null}
            <ErrorNotice error={retryError} />
          </section>
        ) : null}
        {doc.kind === "exam" && "type" in item ? (
          <section className="question-stage" ref={questionStage} key={item.id}>
            <div className="question-heading">
              <div className="exam-question-meta">
                <h2 className="mono" ref={questionHeading} tabIndex={-1}>
                  Question {position + 1} of {items.length}
                </h2>
                <p className="muted">
                  {item.type === "single_choice"
                    ? "Single choice"
                    : "Written answer"}
                </p>
              </div>
              <Button
                variant="quiet"
                className="exam-flag"
                aria-pressed={r?.flagged ?? false}
                disabled={state.submitting}
                onClick={toggleFlag}
              >
                <Flag size={16} aria-hidden="true" />
                Flag for later
              </Button>
              <div className="study-prompt">
                <StudyContent
                  source={item.prompt}
                  label={`question ${position + 1}`}
                />
              </div>
            </div>
            {item.type === "single_choice" ? (
              <fieldset
                className="answer-options"
                disabled={!inProgress || state.submitting}
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
                    <StudyContent source={option.text} />
                    {!inProgress && option.id === item.answer ? (
                      <span className="result-label positive">
                        Correct answer
                      </span>
                    ) : null}
                    {!inProgress && r?.selectedOptionId === option.id ? (
                      <span className="result-label">Your choice</span>
                    ) : null}
                  </label>
                ))}
                {inProgress && r?.selectedOptionId ? (
                  <Button variant="quiet" onClick={() => response(undefined)}>
                    Clear answer
                  </Button>
                ) : null}
              </fieldset>
            ) : inProgress ? (
              <>
                <Field
                  label="Your answer"
                  hint="Write your reasoning. Markdown and LaTeX are supported."
                >
                  <NotationEditor
                    key={item.id}
                    answerType={item.answerType}
                    className="written-answer"
                    readOnly={state.submitting}
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
            ) : null}
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
                <p className="muted">
                  Rating saves and moves to the next card. “Review again”
                  selects it for a later retry.
                </p>
                {lastRating ? (
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      const values = {
                        ...responses,
                        [lastRating.id]: {
                          ...own(responses, lastRating.id),
                          revealed: true,
                          rating: lastRating.previous?.rating,
                        },
                      };
                      state.change(values, lastRating.index);
                      setLastRating(undefined);
                      await state.flush();
                    }}
                  >
                    Undo last rating
                  </Button>
                ) : null}
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
        <details
          className="practice-annotations"
          key={`annotations-${item.id}`}
        >
          <summary>
            {isExam
              ? "Study notes and confidence"
              : `Study notes and flags${r?.flagged ? " · Flagged" : ""}`}
          </summary>
          <div className="stack">
            {!isExam ? (
              <Button
                aria-pressed={r?.flagged ?? false}
                disabled={state.submitting}
                onClick={toggleFlag}
              >
                Flag for later
              </Button>
            ) : null}
            <Field label="Confidence">
              <Selector
                value={r?.confidence ?? ""}
                disabled={state.submitting}
                onValueChange={(value) =>
                  updateResponse({
                    ...r,
                    confidence: (value || undefined) as Response["confidence"],
                  })
                }
                options={[
                  { value: "", label: "Not recorded" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
              />
            </Field>
            <Field
              label="Private study note"
              hint="Saved with this attempt. Study-set exports exclude it."
            >
              <textarea
                rows={3}
                value={r?.note ?? ""}
                disabled={state.submitting}
                onChange={(event) =>
                  updateResponse(
                    {
                      ...r,
                      note:
                        Array.from(event.target.value)
                          .slice(0, MAX_NOTE_CHARACTERS)
                          .join("") || undefined,
                    },
                    false,
                  )
                }
              />
            </Field>
          </div>
        </details>
        <footer className="study-footer">
          <Button
            disabled={position === 0 || state.submitting}
            onClick={() => void go(position - 1)}
          >
            <ArrowLeft size={16} />
            Previous
          </Button>
          {!isExam ? (
            <span className="mono muted footer-count">
              {position + 1} / {items.length}
            </span>
          ) : null}
          <div className="actions">
            {position < items.length - 1 ? (
              <Button
                variant={inProgress && isExam ? "primary" : "secondary"}
                disabled={state.submitting}
                onClick={() => void go(position + 1)}
              >
                Next
                <ArrowRight size={16} />
              </Button>
            ) : null}
            {inProgress ? (
              <Button
                variant={
                  isExam && position === items.length - 1
                    ? "primary"
                    : "secondary"
                }
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                {isExam ? "Review and submit" : "Finish session"}
              </Button>
            ) : null}
            {attempt.status === "reviewing" ? (
              <Button
                variant="primary"
                disabled={state.submitting || nextPending === undefined}
                onClick={() => void go(nextPending)}
              >
                Next unassessed answer
              </Button>
            ) : null}
          </div>
        </footer>
        {inProgress && doc.kind === "flashcards" ? (
          <p className="muted centered">Your ratings are saved as you go.</p>
        ) : null}
        <details>
          <summary>Practice recovery tools</summary>
          <Field
            label="Open a practice recovery copy"
            hint="Choose a recovery file for this attempt and account."
          >
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy || dirty}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setRecoveryFileError(undefined);
                try {
                  state.addRecovery(
                    await readPracticeRecoveryFile(file, user!.id, attempt.id),
                  );
                } catch (error) {
                  setRecoveryFileError(error as Error);
                }
              }}
            />
          </Field>
          <ErrorNotice error={recoveryFileError} />
        </details>
      </main>
      {isExam ? (
        <aside className="exam-map-rail" aria-labelledby="exam-map-heading">
          <h2 id="exam-map-heading">Question navigation</h2>
          {navOpen ? null : questionMap}
        </aside>
      ) : null}
      {confirm ? (
        <Dialog
          title={
            doc.kind === "exam" ? "Submit this exam?" : "Finish this session?"
          }
          onClose={() => {
            if (!state.submitting) setConfirm(false);
          }}
        >
          <div className={isExam ? "exam-submit-summary" : undefined}>
            <p>
              {items.length - unanswered} {isExam ? "answered" : "rated"},{" "}
              {unanswered}{" "}
              {isExam ? `unanswered, ${flaggedCount} flagged` : "unreviewed"}.
            </p>
            {isExam ? (
              <p>
                {unanswered ? "Unanswered questions earn zero points. " : ""}
                Submitting locks your answers.
                {writtenAnswered
                  ? " You’ll assess your written answers next."
                  : ""}
              </p>
            ) : (
              <p>
                {unanswered} unreviewed cards will be included in your summary.
                Only cards rated Review again appear in a retry.
              </p>
            )}
          </div>
          {omissions.length ? (
            <details>
              <summary>
                {doc.kind === "exam"
                  ? "Review unanswered questions"
                  : "Review unreviewed cards"}
              </summary>
              <div
                className={`question-nav${isExam ? " exam-unanswered-list" : ""}`}
              >
                {omissions.map((i) => (
                  <Button
                    key={items[i].id}
                    disabled={state.submitting}
                    onClick={async () => {
                      if (isExam) await go(i);
                      else if (await state.moveTo(i)) setConfirm(false);
                    }}
                  >
                    {doc.kind === "exam" ? "Question" : "Card"} {i + 1}
                  </Button>
                ))}
              </div>
            </details>
          ) : null}
          {doc.kind === "flashcards" && omissions.length ? (
            <Button
              disabled={state.submitting}
              onClick={async () => {
                const next =
                  omissions.find((i) => i > position) ?? omissions[0];
                if (await state.moveTo(next)) setConfirm(false);
              }}
            >
              Go to next unreviewed card
            </Button>
          ) : null}
          <ErrorNotice error={state.error} />
          {state.error ? (
            <Button onClick={() => recoveryDownload()}>
              Download recovery copy
            </Button>
          ) : null}
          <div className={isExam ? "actions dialog-footer" : "actions"}>
            <Button
              disabled={state.submitting}
              onClick={() => setConfirm(false)}
            >
              {isExam ? "Return to exam" : "Keep studying"}
            </Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                if (await state.submit()) setConfirm(false);
              }}
            >
              {isExam ? "Submit exam" : "Finish session"}
            </Button>
          </div>
        </Dialog>
      ) : null}
      {navOpen && isExam ? (
        <Dialog title="Question navigation" onClose={() => setNavOpen(false)}>
          {questionMap}
          <ErrorNotice error={state.error} />
        </Dialog>
      ) : navOpen ? (
        <Dialog title="Card navigation" onClose={() => setNavOpen(false)}>
          <Tabs
            label="Navigation filter"
            value={navFilter}
            onChange={setNavFilter}
            tabs={[
              { value: "all", label: "All" },
              {
                value: "unanswered",
                label: "Unreviewed",
              },
              ...(attempt.status === "completed"
                ? [{ value: "mistakes", label: "Needs review" }]
                : []),
              ...(flagged ? [{ value: "flagged", label: "Flagged" }] : []),
              ...(uncertain
                ? [{ value: "uncertain", label: "Low confidence" }]
                : []),
            ]}
          />
          <div
            className="question-nav"
            role="tabpanel"
            id={`navigation-filter-${navFilter}`}
            aria-label="Filtered items"
          >
            {items.map((it, i) =>
              navFilter === "all" ||
              (navFilter === "unanswered" && omissions.includes(i)) ||
              (navFilter === "mistakes" && incorrectIds.has(it.id)) ||
              (navFilter === "flagged" && own(responses, it.id)?.flagged) ||
              (navFilter === "uncertain" &&
                own(responses, it.id)?.confidence === "low") ? (
                <Button
                  disabled={state.submitting}
                  className={i === position ? "selected" : ""}
                  key={it.id}
                  onClick={() => void go(i)}
                >
                  {i + 1} · {cardState(it)}
                </Button>
              ) : null,
            )}
          </div>
        </Dialog>
      ) : null}
      {blocker.state === "blocked" ? (
        <Dialog
          title="Progress is not saved yet"
          onClose={() => blocker.reset()}
        >
          <p>
            {state.checkpointStatus === "saved"
              ? "A recovery checkpoint is saved on this device if you leave before syncing."
              : "Save your latest progress before leaving, or return to keep working."}
          </p>
          <ErrorNotice error={state.error} />
          <Button onClick={() => recoveryDownload()}>
            Download recovery copy
          </Button>
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
      {state.recovery ? (
        <PracticeRecoveryDialog
          checkpoint={state.recovery}
          attempt={attempt}
          error={state.recoveryError}
          onRestore={state.restoreRecovery}
          onDiscard={state.discardRecovery}
          onClose={state.dismissRecovery}
          onDownload={recoveryDownload}
        />
      ) : null}
    </div>
  );
}
function PracticeRecoveryDialog({
  checkpoint,
  attempt,
  error,
  onRestore,
  onDiscard,
  onClose,
  onDownload,
}: {
  checkpoint: PracticeCheckpoint;
  attempt: Attempt;
  error?: Error;
  onRestore: (checkpoint: PracticeCheckpoint, replace: boolean) => void;
  onDiscard: (checkpoint: PracticeCheckpoint) => void;
  onClose: () => void;
  onDownload: (checkpoint: PracticeCheckpoint) => void;
}) {
  const plan = planPracticeRecovery(checkpoint, attempt);
  const conflicts = plan.conflictCount || plan.positionConflict;
  const hasSafe =
    plan.safeCount > 0 || (plan.hasPosition && !plan.positionConflict);
  return (
    <Dialog title="Restore practice progress?" onClose={onClose}>
      <p>
        There are unsaved changes from{" "}
        {new Date(checkpoint.updatedAt).toLocaleString()}.
      </p>
      {plan.staleStatus ? (
        <Notice tone="warning">
          This attempt moved to a new stage after the checkpoint was saved.
          Download the local copy to keep these changes for reference.
        </Notice>
      ) : conflicts ? (
        <Notice tone="warning">
          {plan.conflictCount
            ? `Another save changed ${plan.conflictCount} of the same items. `
            : ""}
          {plan.positionConflict
            ? "It also recorded a different study position. "
            : ""}
          You can keep the newer saved changes or replace them with your local
          copy.
        </Notice>
      ) : null}
      <ErrorNotice error={error} />
      <div className="actions">
        {!plan.staleStatus && hasSafe ? (
          <Button
            variant="primary"
            onClick={() => onRestore(checkpoint, false)}
          >
            {conflicts
              ? "Restore without replacing newer changes"
              : "Restore progress"}
          </Button>
        ) : null}
        {!plan.staleStatus && conflicts ? (
          <Button onClick={() => onRestore(checkpoint, true)}>
            Restore and replace newer changes
          </Button>
        ) : null}
        <Button onClick={() => onDownload(checkpoint)}>
          Download recovery copy
        </Button>
        <Button variant="quiet" onClick={() => onDiscard(checkpoint)}>
          Discard recovery copy
        </Button>
      </div>
    </Dialog>
  );
}
function examQuestionStatus(
  question: Question,
  response: Response | undefined,
  stage: Attempt["status"],
): ExamQuestionStatus {
  if (!answered(question, response)) return "Unanswered";
  if (stage === "in_progress") return "Answered";
  if (question.type === "single_choice")
    return response?.selectedOptionId === question.answer
      ? "Correct"
      : "Incorrect";
  const score = writtenScore(question, response);
  if (score === null) return "Needs assessment";
  if (stage === "reviewing") return "Assessed";
  if (score === maximum(question)) return "Correct";
  return score > 0 ? "Partial credit" : "Incorrect";
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
