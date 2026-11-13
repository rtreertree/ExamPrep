import { Selector } from "../components/Selector";
import { useRef } from "react";
import { Link } from "react-router-dom";
import { useResource } from "../lib/hooks";
import { listPage, useListQuery } from "../lib/listQuery";
import type { Attempt } from "../lib/api";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  Tabs,
  LoadingRows,
  PageHeader,
  Pagination,
} from "../components/ui";
import { ScoreSummary } from "../components/ScoreSummary";
import { ProgressInsights } from "./ProgressInsights";
const statuses = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "in_progress", label: "In progress" },
  { value: "reviewing", label: "Awaiting assessment" },
  { value: "completed", label: "Completed" },
];
export function HistoryPage() {
  const { params, update, search, setSearch } = useListQuery([
    "search",
    "page",
    "status",
    "setId",
  ]);
  const page = listPage(params);
  const results = useRef<HTMLElement>(null);
  const status =
    statuses.find((entry) => entry.value === params.get("status"))?.value ??
    "all";
  const appliedSearch = (params.get("search") ?? "").slice(0, 200);
  const setId = params.get("setId");
  const returnTo = params.size ? `/history?${params}` : "/history";
  const returnState = { returnTo };
  const { data, error, loading, refresh } = useResource<{
    items: Attempt[];
    hasMore: boolean;
  }>(
    `/attempts?page=${page}&status=${status}&search=${encodeURIComponent(appliedSearch)}${setId ? `&setId=${encodeURIComponent(setId)}` : ""}`,
  );
  const setStatus = (value: string) =>
    update({ status: value === "all" ? null : value, page: null });
  function goToPage(next: number) {
    update({ page: next > 0 ? String(next) : null });
    results.current?.focus();
    results.current?.scrollIntoView({ block: "start" });
  }
  return (
    <>
      <PageHeader
        title="History"
        description="Resume attempts and review your results."
      />
      <ProgressInsights setId={setId} returnTo={returnTo} />
      {setId ? (
        <Button onClick={() => update({ setId: null, page: null })}>
          Show attempts from all sets
        </Button>
      ) : null}
      <Field label="Search history">
        <input
          type="search"
          maxLength={200}
          value={search}
          placeholder="Find an attempt by set title"
          onChange={(e) => setSearch(e.target.value)}
        />
      </Field>
      <div className="history-status-select">
        <Field label="Attempt status">
          <Selector
            value={status}
            onValueChange={setStatus}
            options={statuses}
          />
        </Field>
      </div>
      <div className="history-status-tabs">
        <Tabs
          label="Attempt status"
          value={status}
          onChange={setStatus}
          tabs={statuses}
        />
      </div>
      <section
        ref={results}
        tabIndex={-1}
        role="tabpanel"
        id={`attempt-status-${status}`}
        aria-label="Filtered attempts"
      >
        <ErrorNotice error={error} retry={refresh} />
        {loading && !data?.items.length ? (
          <LoadingRows label="Loading attempts" />
        ) : data?.items.length ? (
          <div className="history-list" aria-busy={loading}>
            {data.items.map((a, i) => (
              <article className="attempt-row" key={a.id}>
                <span className="ordinal">
                  {String(page * 30 + i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h2>
                    <Link to={`/practice/${a.id}`} state={returnState}>
                      {a.title}
                    </Link>
                  </h2>
                  <p className="muted">
                    {new Date(a.startedAt).toLocaleString()} ·{" "}
                    {a.status === "in_progress"
                      ? "In progress"
                      : a.status === "reviewing"
                        ? "Self-assessment pending"
                        : "Completed"}
                    {a.reviewMode ? " · Spaced review" : null}
                  </p>
                  {a.sourceAttemptId ? (
                    <Link
                      className="muted"
                      to={`/practice/${a.sourceAttemptId}`}
                      state={returnState}
                    >
                      Retry of a previous attempt
                    </Link>
                  ) : null}
                  <ScoreSummary result={a.result} />
                </div>
                <Link
                  className="button secondary"
                  to={`/practice/${a.id}`}
                  state={returnState}
                >
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
        ) : !error &&
          (appliedSearch || status !== "all" || setId || page > 0) ? (
          <EmptyState
            title={
              appliedSearch
                ? "No attempts match this search."
                : "No attempts match these filters."
            }
            actions={
              <>
                {appliedSearch ? (
                  <Button
                    onClick={() => {
                      setSearch("");
                      update({ search: null, page: null });
                    }}
                  >
                    Clear search
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    setSearch("");
                    update({
                      search: null,
                      status: null,
                      setId: null,
                      page: null,
                    });
                  }}
                >
                  Reset filters
                </Button>
              </>
            }
          >
            <p className="muted">
              Try a different title or reset the filters to see your attempts.
            </p>
          </EmptyState>
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
        <Pagination
          label="History pages"
          page={page}
          hasMore={data?.hasMore}
          loading={loading}
          onChange={goToPage}
        />
      </section>
    </>
  );
}
