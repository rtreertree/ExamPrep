import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Category } from "../../shared/attempts";
import type { ProgressInsights as Insights } from "../../shared/insights";
import { Button, ErrorNotice, LoadingRows } from "../components/ui";
import { api, type Attempt } from "../lib/api";
import { useResource } from "../lib/hooks";
import "./studyProgress.css";

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const score = (category?: Category) =>
  category ? `${category.earnedPoints} / ${category.maxPoints}` : "—";

export function ProgressInsights({
  setId,
  returnTo,
}: {
  setId: string | null;
  returnTo: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="study-progress-panel history-insights"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>Progress insights</strong>{" "}
        <span className="muted">See score trends and what to study next</span>
      </summary>
      {open ? (
        <InsightDetails key={setId} setId={setId} returnTo={returnTo} />
      ) : null}
    </details>
  );
}

function InsightDetails({
  setId,
  returnTo,
}: {
  setId: string | null;
  returnTo: string;
}) {
  const { data, error, loading, refresh } = useResource<Insights>(
    setId ? `/insights?setId=${encodeURIComponent(setId)}` : "/insights",
  );
  const navigate = useNavigate();
  const [retryError, setRetryError] = useState<Error>();
  const [retrying, setRetrying] = useState(false);
  const returnState = { returnTo };

  async function retry(attemptId: string) {
    setRetryError(undefined);
    setRetrying(true);
    try {
      const attempt = await api<Attempt>(
        `/attempts/${attemptId}/retry`,
        "POST",
        { mode: "mistakes" },
      );
      navigate(`/practice/${attempt.id}`, { state: returnState });
    } catch (e) {
      setRetryError(e as Error);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="study-progress stack" aria-busy={loading}>
      <ErrorNotice error={error} retry={refresh} />
      {loading && !data ? <LoadingRows /> : null}
      {data ? (
        <>
          <section className="stack" aria-labelledby="next-study-title">
            <h2 id="next-study-title">Your next study step</h2>
            {data.pending ? (
              <>
                <p>
                  {data.pending.answers} written{" "}
                  {data.pending.answers === 1 ? "answer needs" : "answers need"}{" "}
                  assessment across {data.pending.sessions}{" "}
                  {data.pending.sessions === 1 ? "session" : "sessions"}.
                </p>
                <Link
                  className="button primary"
                  to={`/practice/${data.pending.attemptId}`}
                  state={returnState}
                >
                  Continue self-assessment
                </Link>
              </>
            ) : data.retry ? (
              <>
                <p>
                  {data.retry.title} has {data.retry.count}{" "}
                  {data.retry.count === 1 ? "item" : "items"} to review again.
                </p>
                <Button
                  variant="primary"
                  busy={retrying}
                  onClick={() => void retry(data.retry!.attemptId)}
                >
                  Practice recent mistakes
                </Button>
                <ErrorNotice error={retryError} />
              </>
            ) : (
              <>
                <p className="muted">
                  Start another full session to build a comparable score
                  history.
                </p>
                <Link className="button secondary" to="/">
                  Choose a study set
                </Link>
              </>
            )}
          </section>
          <section className="stack" aria-labelledby="score-trends-title">
            <h2 id="score-trends-title">Full exam score trends</h2>
            <p className="muted">
              Scores are grouped by set version. Each group shows up to six
              completed full sessions.
            </p>
            {data.trends.length ? (
              data.trends.map((trend) => (
                <table
                  className="study-score-table"
                  key={`${trend.setId}-${trend.revision}`}
                >
                  <caption>
                    {trend.title} · Set revision {trend.revision}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Completed</th>
                      <th scope="col">Automatic</th>
                      <th scope="col">Self-assessed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trend.scores.map((session) => (
                      <tr key={session.id}>
                        <th scope="row">
                          <Link
                            to={`/practice/${session.id}`}
                            state={returnState}
                          >
                            <time dateTime={session.completedAt}>
                              {dateTime.format(new Date(session.completedAt))}
                            </time>
                          </Link>
                        </th>
                        <td>{score(session.result.automatic)}</td>
                        <td>{score(session.result.selfAssessed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))
            ) : (
              <p>
                Complete two full sessions of the same exam version to see a
                trend.
              </p>
            )}
          </section>
          <section className="stack" aria-labelledby="recurring-mistakes-title">
            <h2 id="recurring-mistakes-title">Recurring mistakes</h2>
            <p className="muted">
              Items missed more than once in your last 30 completed sessions.
            </p>
            {data.recurring.length ? (
              <ul className="study-progress-list">
                {data.recurring.map((item) => (
                  <li key={`${item.attemptId}-${item.itemId}`}>
                    <div>
                      <Link
                        to={`/practice/${item.attemptId}`}
                        state={returnState}
                      >
                        {item.prompt}
                      </Link>
                      <span className="muted">{item.setTitle}</span>
                    </div>
                    <span className="muted">{item.misses} misses</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No recurring mistakes in your recent sessions.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
