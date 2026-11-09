import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Upload, Plus, ArrowRight, Ellipsis } from "lucide-react";
import { useResource } from "../lib/hooks";
import { api, exportContent, type StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { accountDrafts, type Draft } from "../lib/drafts";
import { listPage, useListQuery } from "../lib/listQuery";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  Field,
  Notice,
  LoadingRows,
  Menu,
  PageHeader,
  Tabs,
} from "../components/ui";
import { AIHandoffPanel, ImportPanel } from "./Authoring";
import { SurfaceLight } from "../components/SurfaceLight";
import { PracticeSetup } from "../components/PracticeSetup";
import "./library-editor.css";

export function LibraryPage() {
  const { params, update, search, setSearch } = useListQuery([
    "search",
    "page",
    "kind",
    "course",
    "archived",
    "sort",
  ]);
  const kind = params.get("kind");
  const filter = kind === "exam" || kind === "flashcards" ? kind : "all";
  const page = listPage(params);
  const course = params.get("course")?.slice(0, 100) ?? null;
  const archived = params.get("archived") === "true";
  const sort = params.get("sort") === "studied" ? "studied" : "updated";
  const appliedSearch = (params.get("search") ?? "").slice(0, 200);
  const returnTo = params.size ? `/?${params}` : "/";
  const [filtersOpen, setFiltersOpen] = useState(
    course !== null || archived || sort !== "updated",
  );
  const [saved, setSaved] = useState<StudySet>();
  const [settingUp, setSettingUp] = useState<StudySet>();
  const [sample, setSample] = useState(false);
  const query = new URLSearchParams({
    page: String(page),
    search: appliedSearch,
  });
  if (filter !== "all") query.set("kind", filter);
  if (course !== null) query.set("course", course);
  if (archived) query.set("archived", "true");
  if (sort !== "updated") query.set("sort", sort);
  const resource = useResource<{
    items: StudySet[];
    hasMore: boolean;
    page: number;
    courses: string[];
  }>(`/sets?${query}`);
  const courses = resource.data?.courses ?? [];
  const [panel, setPanel] = useState<"import" | "ai" | null>(null);
  const [deleting, setDeleting] = useState<StudySet>();
  const [editingCourse, setEditingCourse] = useState<StudySet>();
  const [courseName, setCourseName] = useState("");
  const courseSuggestionsId = useId();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftError, setDraftError] = useState(false);
  useEffect(() => {
    let active = true;
    setDrafts([]);
    setDraftError(false);
    accountDrafts(user!.id)
      .then((d) => {
        if (active) setDrafts(d);
      })
      .catch(() => {
        if (active) setDraftError(true);
      });
    return () => {
      active = false;
    };
  }, [user!.id]);
  function resetFilters() {
    setSearch("");
    update({
      search: null,
      kind: null,
      page: null,
      course: null,
      archived: null,
      sort: null,
    });
  }
  async function organize(
    set: StudySet,
    changes: { course?: string; pinned?: boolean; archived?: boolean },
  ) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/sets/${set.id}/organization`, "PATCH", changes);
      setEditingCourse(undefined);
      resource.refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(set: StudySet) {
    setBusy(true);
    setError(undefined);
    try {
      const copy = await api<StudySet>(`/sets/${set.id}/duplicate`, "POST", {});
      navigate(`/sets/${copy.id}/edit`);
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/sets/${deleting.id}`, "DELETE", {
        revision: deleting.revision,
      });
      setDeleting(undefined);
      resource.refresh();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Your library"
        description="Pick up a set and keep going."
        display
        actions={
          <>
            <Button variant="primary" onClick={() => setPanel("import")}>
              <Upload size={18} />
              Import
            </Button>
            <Menu
              label={
                <>
                  <Plus size={18} />
                  Create
                </>
              }
            >
              <Link to={`/new/exam/${crypto.randomUUID()}`}>Exam</Link>
              <Link to={`/new/flashcards/${crypto.randomUUID()}`}>
                Flashcards
              </Link>
              <button onClick={() => setPanel("ai")}>
                Create with your AI
              </button>
            </Menu>
          </>
        }
      />
      {saved ? (
        <Notice tone="success">
          <p>“{saved.title}” is saved to your account.</p>
          <div className="actions">
            <Button
              variant="primary"
              busy={busy}
              onClick={() => setSettingUp(saved)}
            >
              Start practice
            </Button>
            <Link className="button secondary" to={`/sets/${saved.id}/edit`}>
              Edit set
            </Link>
            <Button variant="quiet" onClick={() => setSaved(undefined)}>
              Dismiss
            </Button>
          </div>
        </Notice>
      ) : null}
      <Field label="Search library">
        <input
          type="search"
          value={search}
          maxLength={200}
          placeholder="Find a study set by title"
          onChange={(e) => setSearch(e.target.value)}
        />
      </Field>
      <details
        className="library-filters"
        open={filtersOpen}
        onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
      >
        <summary>Library filters{archived ? " · Archived" : ""}</summary>
        <div className="library-filter-fields">
          <Field label="Course">
            <select
              value={course === null ? "all" : `course:${course}`}
              onChange={(e) =>
                update({
                  course:
                    e.target.value === "all" ? null : e.target.value.slice(7),
                  page: null,
                })
              }
            >
              <option value="all">All courses</option>
              <option value="course:">No course</option>
              {course && !courses.includes(course) ? (
                <option value={`course:${course}`}>{course}</option>
              ) : null}
              {courses.map((name) => (
                <option key={name} value={`course:${name}`}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Show sets">
            <select
              value={archived ? "archived" : "active"}
              onChange={(e) =>
                update({
                  archived: e.target.value === "archived" ? "true" : null,
                  page: null,
                })
              }
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </Field>
          <Field label="Sort library">
            <select
              value={sort}
              onChange={(e) =>
                update({
                  sort: e.target.value === "studied" ? "studied" : null,
                  page: null,
                })
              }
            >
              <option value="updated">Recently updated</option>
              <option value="studied">Last studied</option>
            </select>
          </Field>
        </div>
      </details>
      <Tabs
        label="Study set type"
        value={filter}
        onChange={(v) => update({ kind: v === "all" ? null : v, page: null })}
        tabs={[
          { value: "all", label: "All" },
          { value: "exam", label: "Exams" },
          { value: "flashcards", label: "Flashcards" },
        ]}
      />
      <section
        role="tabpanel"
        id={`study-set-type-${filter}`}
        aria-label={
          filter === "all"
            ? "All study sets"
            : filter === "exam"
              ? "Exams"
              : "Flashcards"
        }
      >
        <ErrorNotice
          error={error || resource.error}
          retry={resource.error ? resource.refresh : undefined}
        />
        {draftError ? (
          <Notice tone="warning">
            Drafts on this device could not be checked. Device storage may be
            unavailable. Saved sets and attempts remain in your account.
          </Notice>
        ) : null}
        {drafts.length ? (
          <aside className="draft-list">
            <h2>Local drafts</h2>
            {drafts.map((d) => (
              <Link
                key={d.key}
                to={
                  d.key.startsWith("new:")
                    ? `/new/${d.content.kind}/${d.key.slice(4)}`
                    : `/sets/${d.key}/edit`
                }
              >
                Continue {d.content.title || "untitled draft"}{" "}
                <span className="muted">· this device</span>
              </Link>
            ))}
          </aside>
        ) : null}
        {resource.loading && !resource.data ? (
          <LoadingRows />
        ) : resource.data?.items.length ? (
          <div className="set-list" aria-busy={resource.loading}>
            {resource.data.items.map((set, i) => (
              <SurfaceLight className="set-row" key={set.id}>
                <span className="ordinal">
                  {String((resource.data?.page ?? page) * 30 + i + 1).padStart(
                    2,
                    "0",
                  )}
                </span>
                <Link
                  className="set-title"
                  aria-description="Edit this study set"
                  to={`/sets/${set.id}/edit`}
                >
                  {set.title}
                  <span className="set-edit-cue" aria-hidden="true">
                    Edit
                  </span>
                </Link>
                <span className="set-meta">
                  {set.kind === "exam"
                    ? `Exam · ${set.count} question${set.count === 1 ? "" : "s"}`
                    : `Flashcards · ${set.count} card${set.count === 1 ? "" : "s"}`}
                  {set.course ? (
                    <span className="library-course">{set.course}</span>
                  ) : null}
                  {set.pinned ? (
                    <span className="library-course">Pinned</span>
                  ) : null}
                  {set.continuation?.isOlderVersion ? (
                    <span className="library-course">
                      Attempt uses an earlier set version
                    </span>
                  ) : null}
                </span>
                <div className="row-actions">
                  {set.continuation ? (
                    <Link
                      className="button primary"
                      to={`/practice/${set.continuation.id}`}
                      state={{ returnTo }}
                    >
                      {set.continuation.status === "reviewing"
                        ? `Finish assessment — ${set.continuation.result?.selfAssessed?.pendingCount ?? "some"} remaining`
                        : `Resume — ${set.continuation.kind === "exam" ? "question" : "card"} ${set.continuation.position + 1} of ${set.continuation.total}`}
                    </Link>
                  ) : (
                    <Button disabled={busy} onClick={() => setSettingUp(set)}>
                      Practice <ArrowRight size={17} />
                    </Button>
                  )}
                  <Menu
                    label={
                      <>
                        <Ellipsis size={20} />
                        <span className="sr-only">Actions for {set.title}</span>
                      </>
                    }
                  >
                    {set.continuation ? (
                      <button disabled={busy} onClick={() => setSettingUp(set)}>
                        Start new attempt
                      </button>
                    ) : null}
                    {set.kind === "flashcards" && !set.archived ? (
                      <Link to={`/review/${set.id}`}>Spaced review</Link>
                    ) : null}
                    <Link to={`/history?setId=${set.id}`}>
                      All attempts for this set
                    </Link>
                    <Link to={`/sets/${set.id}/edit`}>Edit set</Link>
                    <button disabled={busy} onClick={() => void duplicate(set)}>
                      Duplicate set
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setError(undefined);
                        setCourseName(set.course ?? "");
                        setEditingCourse(set);
                      }}
                    >
                      Set course
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void organize(set, { pinned: !set.pinned })
                      }
                    >
                      {set.pinned ? "Unpin set" : "Pin set"}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void organize(set, { archived: !set.archived })
                      }
                    >
                      {set.archived ? "Unarchive set" : "Archive set"}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const full = await api<StudySet>(`/sets/${set.id}`);
                          exportContent(full.content);
                        } catch (e) {
                          setError(e as Error);
                        }
                      }}
                    >
                      Export
                    </button>
                    <button
                      className="negative"
                      onClick={() => setDeleting(set)}
                    >
                      Delete
                    </button>
                  </Menu>
                </div>
              </SurfaceLight>
            ))}
          </div>
        ) : resource.loading ? null : !resource.error &&
          (appliedSearch ||
            filter !== "all" ||
            page > 0 ||
            course !== null ||
            archived) ? (
          <EmptyState
            title={
              appliedSearch
                ? "No study sets match this search."
                : archived && course === null && filter === "all" && page === 0
                  ? "No archived study sets."
                  : "No study sets match this filter."
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
                <Button onClick={resetFilters}>Reset filters</Button>
              </>
            }
          >
            <p className="muted">
              Try a different title or reset the filters to see your study sets.
            </p>
          </EmptyState>
        ) : !resource.error ? (
          <EmptyState
            title="Your first set starts here."
            actions={
              <>
                <Button onClick={() => setPanel("import")}>
                  Import a study set
                </Button>
                <Link
                  className="button secondary"
                  to={`/new/exam/${crypto.randomUUID()}`}
                >
                  Create one manually
                </Link>
                <Button variant="quiet" onClick={() => setPanel("ai")}>
                  Prepare one with my AI tool
                </Button>
                <Button variant="quiet" onClick={() => setSample(true)}>
                  Preview a sample
                </Button>
              </>
            }
          >
            <p className="muted">
              Import a study set from a file. Create one manually in the editor.
              Or prepare a file in your own external AI tool and return to
              import it.
            </p>
          </EmptyState>
        ) : null}
        <div className="pagination">
          <Button
            disabled={!page || resource.loading}
            onClick={() => update({ page: page > 1 ? String(page - 1) : null })}
          >
            Previous page
          </Button>
          {page || resource.data?.hasMore ? (
            <span className="mono">Page {page + 1}</span>
          ) : null}
          <Button
            disabled={
              !resource.data?.hasMore || resource.loading || page >= 1_000_000
            }
            onClick={() => update({ page: String(page + 1) })}
          >
            Next page
          </Button>
        </div>
      </section>
      {panel === "import" ? (
        <ImportPanel
          onClose={() => setPanel(null)}
          onSaved={(set) => {
            setSaved(set);
            resetFilters();
            setPanel(null);
            resource.refresh();
          }}
        />
      ) : panel === "ai" ? (
        <AIHandoffPanel
          onClose={() => setPanel(null)}
          onImport={() => setPanel("import")}
        />
      ) : null}
      {settingUp ? (
        <PracticeSetup
          set={settingUp}
          returnTo={returnTo}
          onClose={() => setSettingUp(undefined)}
        />
      ) : null}
      {editingCourse ? (
        <Dialog title="Set course" onClose={() => setEditingCourse(undefined)}>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void organize(editingCourse, { course: courseName });
            }}
          >
            <p>
              Choose a course for “{editingCourse.title}”. Leave it blank to
              remove the course.
            </p>
            <Field label="Course name">
              <input
                list={courseSuggestionsId}
                maxLength={100}
                value={courseName}
                onChange={(e) => setCourseName(e.target.value)}
              />
            </Field>
            <datalist id={courseSuggestionsId}>
              {courses.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <ErrorNotice error={error} />
            <div className="actions">
              <Button onClick={() => setEditingCourse(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} type="submit">
                Save course
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {sample ? (
        <Dialog title="A sample study set" onClose={() => setSample(false)}>
          <p>This preview does not add content to your account.</p>
          <h3>Quick science check</h3>
          <p>Question 1: What is the chemical formula for water?</p>
          <p>A. CO₂ · B. H₂O</p>
          <details>
            <summary>Show answer</summary>
            <p>B. H₂O — two hydrogen atoms and one oxygen atom.</p>
          </details>
        </Dialog>
      ) : null}
      {deleting ? (
        <Dialog
          title="Delete this study set?"
          onClose={() => setDeleting(undefined)}
        >
          <p>
            “{deleting.title}” will be removed from your library. Past attempts
            and their original content remain in History.
          </p>
          <ErrorNotice error={error} />
          <div className="actions">
            <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button variant="danger" busy={busy} onClick={remove}>
              Delete set
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
