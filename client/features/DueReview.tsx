import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MAX_DAILY_REVIEWS, type ReviewQueue } from "../../shared/spacedReview";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  LoadingRows,
  PageHeader,
} from "../components/ui";
import { api } from "../lib/api";
import { useResource } from "../lib/hooks";
import "./studyProgress.css";

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function DueReviewPage() {
  const { id } = useParams();
  const path = `/sets/${id}/review`;
  const { data, setData, error, loading, refresh } =
    useResource<ReviewQueue>(path);
  const navigate = useNavigate();
  const [startError, setStartError] = useState<Error>();
  const [starting, setStarting] = useState(false);
  const returnState = { returnTo: `/review/${id}` };

  async function start() {
    setStarting(true);
    setStartError(undefined);
    try {
      const attempt = await api<{ id: string }>(path, "POST", {});
      navigate(`/practice/${attempt.id}`, { state: returnState });
    } catch (e) {
      setStartError(e as Error);
      refresh();
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Spaced review"
        description={data?.title ?? "Review cards as they become due."}
        actions={
          <Link className="button secondary" to="/">
            ← Library
          </Link>
        }
      />
      <ErrorNotice error={error} retry={refresh} />
      {loading && !data ? <LoadingRows /> : null}
      {data ? (
        <div className="study-progress stack" aria-busy={loading}>
          <section
            className="study-progress-panel stack"
            aria-labelledby="review-queue-title"
          >
            <h2 id="review-queue-title">Due queue</h2>
            <p>
              <strong>{data.due} due</strong> · {data.reviewedToday} of{" "}
              {data.limit} reviewed today
            </p>
            <p className="muted">
              This deck's daily limit resets{" "}
              <time dateTime={data.resetsAt}>
                {dateTime.format(new Date(data.resetsAt))}
              </time>
              . Ratings count toward the limit when you finish a spaced review
              session.
            </p>
            {data.archived ? (
              <p className="muted">
                Restore this deck from the archive to start another spaced
                review.
              </p>
            ) : null}
            <div className="actions">
              {data.activeAttemptId ? (
                <Link
                  className="button primary"
                  to={`/practice/${data.activeAttemptId}`}
                  state={returnState}
                >
                  Resume spaced review
                </Link>
              ) : (
                <Button
                  variant="primary"
                  disabled={!data.available || loading}
                  busy={starting}
                  onClick={() => void start()}
                >
                  {data.available
                    ? `Review ${data.available} ${data.available === 1 ? "card" : "cards"}`
                    : "No cards available"}
                </Button>
              )}
              <Button disabled={loading || starting} onClick={refresh}>
                Refresh queue
              </Button>
            </div>
            <ErrorNotice error={startError} />
            {!data.due && !data.activeAttemptId ? (
              <EmptyState title="You're caught up.">
                <p className="muted">
                  Come back when the next card is due or start an ordinary
                  session from your library.
                </p>
              </EmptyState>
            ) : null}
            <ReviewLimitForm
              key={data.limit}
              path={path}
              initialLimit={data.limit}
              disabled={!!data.activeAttemptId || starting || loading}
              onSaved={setData}
            />
          </section>
          <section aria-labelledby="review-schedule-title">
            <h2 id="review-schedule-title">Card schedule</h2>
            <p className="muted">
              A card keeps its schedule when reordered. It becomes due again if
              either side differs from its last reviewed version. Choose Known
              to increase the interval or Review again to see it in one day.
            </p>
            <ul className="study-progress-list">
              {data.cards.map((card) => (
                <li key={card.id}>
                  <span>{card.front}</span>
                  <span className="muted">
                    {card.due ? <strong>Due now</strong> : null}
                    {card.nextReviewAt ? (
                      <time dateTime={card.nextReviewAt}>
                        {dateTime.format(new Date(card.nextReviewAt))}
                      </time>
                    ) : (
                      <span>New or edited</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ReviewLimitForm({
  path,
  initialLimit,
  disabled,
  onSaved,
}: {
  path: string;
  initialLimit: number;
  disabled: boolean;
  onSaved: (data: ReviewQueue) => void;
}) {
  const [limit, setLimit] = useState(String(initialLimit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await api<ReviewQueue>(path, "PATCH", { limit: Number(limit) }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="review-limit" onSubmit={(event) => void save(event)}>
      <div className="actions">
        <Field label="Daily review limit">
          <input
            type="number"
            min={1}
            max={MAX_DAILY_REVIEWS}
            required
            value={limit}
            disabled={disabled || busy}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          disabled={disabled || Number(limit) === initialLimit}
          busy={busy}
        >
          Save limit
        </Button>
      </div>
      {disabled && !busy ? (
        <p className="muted">The limit is editable between sessions.</p>
      ) : null}
      <ErrorNotice error={error} />
    </form>
  );
}
