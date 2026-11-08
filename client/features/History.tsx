import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useResource } from "../lib/hooks";
import type { Attempt } from "../lib/api";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  Tabs,
  LoadingRows,
  PageHeader,
} from "../components/ui";
import { ScoreSummary } from "../components/ScoreSummary";
export function HistoryPage() {
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [params, setParams] = useSearchParams();
  const setId = params.get("setId");
  const { data, error, loading, refresh } = useResource<{
    items: Attempt[];
    hasMore: boolean;
  }>(
    `/attempts?page=${page}&status=${status}&search=${encodeURIComponent(search)}${setId ? `&setId=${encodeURIComponent(setId)}` : ""}`,
  );
  return (
    <>
      <PageHeader
        title="History"
        description="Your progress, one session at a time."
      />
      <p className="muted">
        Each attempt keeps the version of the set used when it began. Retry
        scores cover only their subset of items.
      </p>
      {setId ? (
        <Button
          onClick={() => {
            setParams({});
            setPage(0);
          }}
        >
          Show attempts from all sets
        </Button>
      ) : null}
      <Field label="Search history">
        <input
          type="search"
          maxLength={200}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </Field>
      <Tabs
        label="Attempt status"
        value={status}
        onChange={(v) => {
          setStatus(v);
          setPage(0);
        }}
        tabs={[
          { value: "all", label: "All" },
          { value: "attention", label: "Needs attention" },
          { value: "in_progress", label: "In progress" },
          { value: "reviewing", label: "Awaiting assessment" },
          { value: "completed", label: "Completed" },
        ]}
      />
      <section
        role="tabpanel"
        id={`attempt-status-${status}`}
        aria-label="Filtered attempts"
      >
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
                    <Link
                      className="muted"
                      to={`/practice/${a.sourceAttemptId}`}
                    >
                      Retry of a previous attempt
                    </Link>
                  ) : null}
                  <ScoreSummary result={a.result} />
                </div>
                <Link className="button secondary" to={`/practice/${a.id}`}>
                  {a.status === "completed"
                    ? "Review results"
                    : a.status === "reviewing"
                      ? "Finish assessment"
                      : "Resume practice"}{" "}
                  →
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
          <Button
            disabled={!data?.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Next page
          </Button>
        </div>
      </section>
    </>
  );
}
