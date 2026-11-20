import { useEffect, useState, type ReactNode } from "react";
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
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
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
      {query.trim() === search ? (
        <PageRows<T> key={base + ":" + version} path={base} render={render} />
      ) : (
        <LoadingRows />
      )}
    </section>
  );
}
function PageRows<T extends { id: string }>({
  path,
  render,
}: {
  path: string;
  render: (row: T) => ReactNode;
}) {
  const [cursors, setCursors] = useState([""]);
  const cursor = cursors[cursors.length - 1];
  const { data, loading, error, refresh } = useResource<DirectoryPage<T>>(
    path + "&after=" + encodeURIComponent(cursor),
  );
  return (
    <>
      <ErrorNotice error={error} retry={refresh} />
      {loading ? (
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
            <p className="muted">No matching results.</p>
          )}
        </>
      ) : null}
      {(cursor || data?.next) && (
        <nav className="actions" aria-label="Result pages">
          <Button
            disabled={!cursor}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            disabled={!data?.next || loading}
            onClick={() => data?.next && setCursors([...cursors, data.next])}
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
              : " · Co-owned")}
          {set.archived && " · Archived"}
          {set.published && " · Published"}
        </small>
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}
