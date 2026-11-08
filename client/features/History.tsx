import { useState } from "react";
import { Link } from "react-router-dom";
import { useResource } from "../lib/hooks";
import type { Attempt } from "../lib/api";
import {
  Button,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  PageHeader,
} from "../components/ui";
import { ScoreSummary } from "../components/ScoreSummary";
export function HistoryPage() {
  const [page, setPage] = useState(0);
  const { data, error, loading, refresh } = useResource<{
    items: Attempt[];
    hasMore: boolean;
  }>(`/attempts?page=${page}`);
  return (
    <>
      <PageHeader
        title="History"
        description="Your progress, one session at a time."
      />
      <ErrorNotice error={error} retry={refresh} />
      {loading ? (
        <LoadingRows />
      ) : data?.items.length ? (
        <div className="history-list">
          {data.items.map((a, i) => (
            <article className="attempt-row" key={a.id}>
              <span className="ordinal">
                {String(page * 30 + i + 1).padStart(2, "0")}
              </span>
              <div>
                <h2>
                  <Link to={`/practice/${a.id}`}>{a.title}</Link>
                </h2>
                <p className="muted">
                  {new Date(a.startedAt).toLocaleString()} ·{" "}
                  {a.status === "in_progress"
                    ? "In progress"
                    : a.status === "reviewing"
                      ? "Self-assessment pending"
                      : "Completed"}
                </p>
                {a.sourceAttemptId ? (
                  <Link className="muted" to={`/practice/${a.sourceAttemptId}`}>
                    Retry of a previous attempt
                  </Link>
                ) : null}
                <ScoreSummary result={a.result} />
              </div>
              <Link className="button secondary" to={`/practice/${a.id}`}>
                {a.status === "completed" ? "Review" : "Resume"} →
              </Link>
            </article>
          ))}
        </div>
      ) : !error ? (
        <EmptyState
          title="A little practice goes a long way."
          actions={
            <Link className="button secondary" to="/">
              Open library
            </Link>
          }
        >
          <p className="muted">
            Your attempts will appear here when you start studying.
          </p>
        </EmptyState>
      ) : null}
      <div className="pagination">
        <Button disabled={!page} onClick={() => setPage((p) => p - 1)}>
          Previous page
        </Button>
        {page || data?.hasMore ? (
          <span className="mono">Page {page + 1}</span>
        ) : null}
        <Button disabled={!data?.hasMore} onClick={() => setPage((p) => p + 1)}>
          Next page
        </Button>
      </div>
    </>
  );
}
