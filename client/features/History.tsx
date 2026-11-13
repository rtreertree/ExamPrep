import { useId, useRef } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import {
  LIST_PAGE_SIZE,
  type AttemptGroup,
  type ListResult,
} from "../../shared/listing";
import { Selector } from "../components/Selector";
import {
  Button,
  EmptyState,
  ErrorNotice,
  Field,
  ListViewSwitcher,
  LoadingRows,
  PageHeader,
  Pagination,
  Tabs,
} from "../components/ui";
import { ScoreSummary } from "../components/ScoreSummary";
import { useResource } from "../lib/hooks";
import { listPage, useListQuery } from "../lib/listQuery";
import { historyDateBounds, historyDateOptions } from "../lib/historyDates";
import type { Attempt } from "../lib/api";
import { ProgressInsights } from "./ProgressInsights";

const statuses = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "in_progress", label: "In progress" },
  { value: "reviewing", label: "Awaiting assessment" },
  { value: "completed", label: "Completed" },
];
const types = [
  { value: "all", label: "All types" },
  { value: "exam", label: "Exams" },
  { value: "flashcards", label: "Flashcard practice" },
  { value: "spaced", label: "Spaced review" },
];
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const groupReset = { page: null, group: null, groupPage: null };
const deletedGroup = "~deleted";

export function HistoryPage() {
  const { params, update, search, setSearch, updateSearch } = useListQuery(
    [
      "search",
      "page",
      "status",
      "setId",
      "type",
      "date",
      "from",
      "through",
      "view",
      "group",
      "groupPage",
    ],
    ["group", "groupPage"],
  );
  const page = listPage(params);
  const groupPage = listPage(params, "groupPage");
  const grouped = params.get("view") === "sets";
  const openGroup = params.get("group");
  const results = useRef<HTMLElement>(null);
  const dateErrorId = useId();
  const status =
    statuses.find(({ value }) => value === params.get("status"))?.value ??
    "all";
  const type =
    types.find(({ value }) => value === params.get("type"))?.value ?? "all";
  const date =
    historyDateOptions.find(({ value }) => value === params.get("date"))
      ?.value ?? "any";
  const from = params.get("from") ?? "";
  const through = params.get("through") ?? "";
  const bounds = historyDateBounds(date, from, through);
  const appliedSearch = (params.get("search") ?? "").slice(0, 200);
  const setId = params.get("setId");
  const returnTo = params.size ? `/history?${params}` : "/history";
  const query = new URLSearchParams({
    page: String(page),
    status,
    search: appliedSearch,
  });
  if (setId) query.set("setId", setId);
  if (type !== "all") query.set("type", type);
  if (bounds.startedFrom) query.set("startedFrom", bounds.startedFrom);
  if (bounds.startedBefore) query.set("startedBefore", bounds.startedBefore);
  const attempts = useResource<ListResult<Attempt>>(
    !grouped && !bounds.error ? `/attempts?${query}` : null,
  );
  const groups = useResource<ListResult<AttemptGroup>>(
    grouped && !bounds.error ? `/attempts/groups?${query}` : null,
  );
  const { data, error, loading, refresh } = grouped ? groups : attempts;
  const filtersApplied =
    appliedSearch ||
    status !== "all" ||
    setId ||
    type !== "all" ||
    date !== "any" ||
    page > 0;

  function changeFilters(changes: Record<string, string | null>) {
    update({ ...groupReset, ...changes });
  }
  function goToPage(next: number) {
    changeFilters({ page: next > 0 ? String(next) : null });
    results.current?.focus();
    results.current?.scrollIntoView({ block: "start" });
  }
  function setStatus(value: string) {
    changeFilters({ status: value === "all" ? null : value });
  }
  return (
    <>
      <PageHeader
        title="History"
        description="Resume attempts and review your results."
      />
      <ProgressInsights setId={setId} returnTo={returnTo} />
      <ListViewSwitcher
        label="History view"
        listLabel="All attempts"
        groupedLabel="By study set"
        grouped={grouped}
        onChange={(next) => {
          if (next !== grouped) changeFilters({ view: next ? "sets" : null });
        }}
      />
      {setId ? (
        <div className="history-set-scope">
          <Button onClick={() => changeFilters({ setId: null })}>
            Show attempts from all sets
          </Button>
        </div>
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
      <div className="list-filter-fields">
        <Field label="Attempt type">
          <Selector
            value={type}
            onValueChange={(value) =>
              changeFilters({ type: value === "all" ? null : value })
            }
            options={types}
          />
        </Field>
        <Field label="Attempt date">
          <Selector
            value={date}
            onValueChange={(value) =>
              changeFilters({ date: value === "any" ? null : value })
            }
            options={historyDateOptions}
          />
        </Field>
        {date === "custom" ? (
          <>
            <Field label="Start date">
              <input
                type="date"
                value={from}
                aria-invalid={!!bounds.error}
                aria-describedby={bounds.error ? dateErrorId : undefined}
                onChange={(event) =>
                  changeFilters({ from: event.target.value || null })
                }
              />
            </Field>
            <Field label="End date">
              <input
                type="date"
                value={through}
                aria-invalid={!!bounds.error}
                aria-describedby={bounds.error ? dateErrorId : undefined}
                onChange={(event) =>
                  changeFilters({ through: event.target.value || null })
                }
              />
            </Field>
          </>
        ) : null}
      </div>
      {bounds.error ? (
        <p id={dateErrorId} className="negative" role="alert">
          {bounds.error}
        </p>
      ) : null}
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
        aria-label={grouped ? "Attempts by study set" : "Filtered attempts"}
      >
        <ErrorNotice error={error} retry={refresh} />
        {loading && !data?.items.length ? (
          <LoadingRows
            label={grouped ? "Loading study-set groups" : "Loading attempts"}
          />
        ) : groups.data?.items.length && grouped ? (
          <ul className="organization-list" aria-busy={loading}>
            {groups.data.items.map((group) => {
              const key = group.setId ?? deletedGroup;
              const expanded = key === openGroup;
              return (
                <HistoryGroup
                  key={key}
                  group={group}
                  expanded={expanded}
                  query={query}
                  page={groupPage}
                  returnTo={returnTo}
                  onToggle={() =>
                    update({ group: expanded ? null : key, groupPage: null })
                  }
                  onPageChange={(next) =>
                    update({ groupPage: next > 0 ? String(next) : null })
                  }
                />
              );
            })}
          </ul>
        ) : attempts.data?.items.length && !grouped ? (
          <AttemptRows
            items={attempts.data.items}
            page={page}
            loading={loading}
            returnTo={returnTo}
          />
        ) : !error && !bounds.error && filtersApplied ? (
          <EmptyState
            title={
              appliedSearch
                ? "No attempts match this search."
                : "No attempts match these filters."
            }
            actions={
              <>
                {appliedSearch ? (
                  <Button onClick={() => updateSearch("", groupReset)}>
                    Clear search
                  </Button>
                ) : null}
                <Button
                  onClick={() => {
                    updateSearch("", {
                      ...groupReset,
                      status: null,
                      setId: null,
                      type: null,
                      date: null,
                      from: null,
                      through: null,
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
        ) : !error && !bounds.error ? (
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
        {!bounds.error ? (
          <Pagination
            label={grouped ? "Study-set group pages" : "History pages"}
            page={page}
            hasMore={data?.hasMore}
            loading={loading}
            onChange={goToPage}
          />
        ) : null}
      </section>
    </>
  );
}

function HistoryGroup({
  group,
  expanded,
  query,
  page,
  returnTo,
  onToggle,
  onPageChange,
}: {
  group: AttemptGroup;
  expanded: boolean;
  query: URLSearchParams;
  page: number;
  returnTo: string;
  onToggle: () => void;
  onPageChange: (page: number) => void;
}) {
  const id = useId();
  const title = group.title ?? (group.setId ? "Study set" : "Deleted sets");
  return (
    <li className="history-group">
      <h2>
        <button
          className="organization-row"
          type="button"
          id={`${id}-toggle`}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={onToggle}
        >
          <strong>{title}</strong>
          <span className="muted">
            {group.count} {group.count === 1 ? "attempt" : "attempts"}
          </span>
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      </h2>
      <div
        id={id}
        role="region"
        aria-labelledby={`${id}-toggle`}
        hidden={!expanded}
      >
        {expanded ? (
          <GroupAttempts
            setId={group.setId}
            filters={query}
            page={page}
            returnTo={returnTo}
            onPageChange={onPageChange}
          />
        ) : null}
      </div>
    </li>
  );
}

function GroupAttempts({
  setId,
  filters,
  page,
  returnTo,
  onPageChange,
}: {
  setId: string | null;
  filters: URLSearchParams;
  page: number;
  returnTo: string;
  onPageChange: (page: number) => void;
}) {
  const results = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams(filters);
  query.set("page", String(page));
  if (setId) query.set("setId", setId);
  else {
    query.delete("setId");
    query.set("unlinked", "true");
  }
  const { data, error, loading, refresh } = useResource<ListResult<Attempt>>(
    `/attempts?${query}`,
  );
  return (
    <div className="group-attempts list-results" ref={results} tabIndex={-1}>
      <ErrorNotice error={error} retry={refresh} />
      {data?.items.length ? (
        <AttemptRows
          items={data.items}
          page={page}
          loading={loading}
          returnTo={returnTo}
          nested
        />
      ) : loading ? (
        <LoadingRows label="Loading attempts for this group" />
      ) : !error ? (
        <p className="muted">No attempts on this page.</p>
      ) : null}
      <Pagination
        label="Attempt pages for this group"
        page={page}
        hasMore={data?.hasMore}
        loading={loading}
        onChange={(next) => {
          onPageChange(next);
          results.current?.focus();
          results.current?.scrollIntoView({ block: "start" });
        }}
      />
    </div>
  );
}

function AttemptRows({
  items,
  page,
  loading,
  returnTo,
  nested = false,
}: {
  items: Attempt[];
  page: number;
  loading: boolean;
  returnTo: string;
  nested?: boolean;
}) {
  const returnState = { returnTo };
  const Heading = nested ? "h3" : "h2";
  return (
    <div className="history-list" aria-busy={loading}>
      {items.map((attempt, index) => (
        <article className="attempt-row" key={attempt.id}>
          <span className="ordinal" aria-hidden="true">
            {String(page * LIST_PAGE_SIZE + index + 1).padStart(2, "0")}
          </span>
          <div>
            <Heading>
              <Link to={`/practice/${attempt.id}`} state={returnState}>
                {attempt.title}
              </Link>
            </Heading>
            <p className="muted">
              <time dateTime={attempt.startedAt}>
                {dateTime.format(new Date(attempt.startedAt))}
              </time>
              {" · "}
              {attempt.status === "in_progress"
                ? "In progress"
                : attempt.status === "reviewing"
                  ? "Self-assessment pending"
                  : "Completed"}
              {attempt.reviewMode
                ? " · Spaced review"
                : attempt.kind === "exam"
                  ? " · Exam"
                  : attempt.kind === "flashcards"
                    ? " · Flashcard practice"
                    : null}
            </p>
            {attempt.sourceAttemptId ? (
              <Link
                className="muted"
                to={`/practice/${attempt.sourceAttemptId}`}
                state={returnState}
              >
                Retry of a previous attempt
              </Link>
            ) : null}
            <ScoreSummary result={attempt.result} />
          </div>
          <Link
            className="button secondary"
            to={`/practice/${attempt.id}`}
            state={returnState}
          >
            {attempt.status === "completed"
              ? "Review results"
              : attempt.status === "reviewing"
                ? "Finish assessment"
                : "Resume practice"}
            {" →"}
          </Link>
        </article>
      ))}
    </div>
  );
}
