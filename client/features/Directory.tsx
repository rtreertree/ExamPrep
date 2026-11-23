import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Layers } from "lucide-react";
import type { DirectoryPage, DirectorySet } from "../../shared/directory";
import { Button, ErrorNotice, Field, LoadingRows } from "../components/ui";
import { Selector } from "../components/Selector";
import { useResource } from "../lib/hooks";
import "./directory.css";

type Filter = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
};
export const kindFilter: Filter = {
  key: "kind",
  label: "Type",
  options: [
    { value: "", label: "All types" },
    { value: "exam", label: "Exams" },
    { value: "flashcards", label: "Flashcards" },
  ],
};
export const sharingFilter: Filter = {
  key: "sharing",
  label: "Sharing",
  options: [
    { value: "", label: "All sets" },
    { value: "published", label: "Published in Discover" },
    { value: "link", label: "Active link" },
    { value: "invitations", label: "Pending invitations" },
    { value: "coOwners", label: "Co-owned" },
  ],
};
export function useDirectorySearch(query: string) {
  const term = query.trim();
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(term), 200);
    return () => clearTimeout(timer);
  }, [term]);
  return { search, searching: term !== search };
}

export function Directory<T extends { id: string }>({
  path,
  searchLabel,
  filters = [],
  render,
  version = 0,
}: {
  path: string;
  searchLabel: string;
  filters?: Filter[];
  render: (row: T) => ReactNode;
  version?: number;
}) {
  const [query, setQuery] = useState("");
  const { search, searching } = useDirectorySearch(query);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  for (const [key, value] of Object.entries(selected))
    if (value) params.set(key, value);
  const base = path + "?" + params.toString();
  return (
    <section className="stack" aria-label={searchLabel}>
      <div className="directory-filters">
        <Field label={searchLabel}>
          <input
            type="search"
            maxLength={254}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        {filters.map((filter) => (
          <Field key={filter.key} label={filter.label}>
            <Selector
              value={selected[filter.key] || ""}
              options={filter.options}
              onValueChange={(value) =>
                setSelected({ ...selected, [filter.key]: value })
              }
            />
          </Field>
        ))}
      </div>
      {searching ? (
        <LoadingRows />
      ) : (
        <DirectoryResults<T>
          key={base + ":" + version}
          path={base}
          render={render}
        />
      )}
    </section>
  );
}
export function DirectoryResults<T extends { id: string }>({
  path,
  render,
  heading,
  empty = <p className="muted">No matching results.</p>,
}: {
  path: string | null;
  render: (row: T) => ReactNode;
  heading?: string;
  empty?: ReactNode;
}) {
  const [cursors, setCursors] = useState([""]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const cursor = cursors[cursors.length - 1];
  const { data, loading, error, refresh } = useResource<DirectoryPage<T>>(
    path ? path + "&after=" + encodeURIComponent(cursor) : null,
  );
  const pending = !path || loading;
  function changePage(cursors: string[]) {
    headingRef.current?.focus();
    setCursors(cursors);
  }
  return (
    <>
      {heading && (
        <div className="directory-results-heading">
          <h2 ref={headingRef} tabIndex={-1}>
            {heading}
          </h2>
          <span className="mono muted" role="status">
            {!pending && !error && data
              ? `${data.items.length} ${data.items.length === 1 ? "set" : "sets"}${cursor || data.next ? " on this page" : ""}`
              : ""}
          </span>
        </div>
      )}
      <ErrorNotice error={error} retry={refresh} />
      {pending ? (
        <LoadingRows />
      ) : data && !error ? (
        <>
          {data.items.length ? (
            <ul className="directory-list">
              {data.items.map((item) => (
                <li key={item.id}>{render(item)}</li>
              ))}
            </ul>
          ) : (
            empty
          )}
        </>
      ) : null}
      {path && (cursor || data?.next) && (
        <nav className="actions" aria-label="Result pages">
          <Button
            disabled={!cursor}
            onClick={() => changePage(cursors.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            disabled={!data?.next || loading}
            onClick={() => data?.next && changePage([...cursors, data.next])}
          >
            Next
          </Button>
        </nav>
      )}
    </>
  );
}
export function SetRow({
  set,
  to,
  children,
}: {
  set: DirectorySet;
  to: string;
  children?: ReactNode;
}) {
  const Icon = set.kind === "exam" ? BookOpen : Layers;
  return (
    <div className="directory-row">
      <Icon aria-hidden="true" size={22} />
      <div className="directory-text">
        <Link className="directory-title" to={to}>
          {set.title}
        </Link>
        <p>Owned by {set.ownerName}</p>
        <small>
          {set.kind === "exam" ? "Exam" : "Flashcards"} · {set.count}{" "}
          {set.kind === "exam"
            ? set.count === 1
              ? "question"
              : "questions"
            : set.count === 1
              ? "card"
              : "cards"}
          {set.ownershipRole &&
            (set.ownershipRole === "primary"
              ? " · Primary owner"
              : set.ownershipRole === "viewer"
                ? " · View only"
                : " · Co-owned")}
          {set.archived && " · Archived"}
          {set.published && " · Published"}
        </small>
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}
