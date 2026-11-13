import { Selector } from "../components/Selector";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Upload, Plus, ArrowRight, Ellipsis } from "lucide-react";
import { useResource } from "../lib/hooks";
import { api, exportContent, type StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { accountDrafts, type Draft } from "../lib/drafts";
import type { AISettings } from "../lib/aiSettings";
import { listPage, useListQuery } from "../lib/listQuery";
import { LIST_PAGE_SIZE, type SetOrganization } from "../../shared/listing";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  Field,
  ListViewSwitcher,
  Notice,
  LoadingRows,
  Menu,
  PageHeader,
  Pagination,
  Tabs,
} from "../components/ui";
import { AIHandoffPanel, ImportPanel } from "./Authoring";
import { SurfaceLight } from "../components/SurfaceLight";
import { PracticeSetup } from "../components/PracticeSetup";
import { OwnershipInvitations, SetSharing } from "./SetSharing";
import {
  ArchiveScope,
  BulkOrganizationDialog,
  LibraryCourses,
} from "./LibraryOrganization";
import "./library-editor.css";

export function LibraryPage() {
  const { params, update, search, setSearch, updateSearch } = useListQuery([
    "search",
    "page",
    "kind",
    "course",
    "archived",
    "sort",
    "view",
  ]);
  const byCourse = params.get("view") === "courses";
  const kind = params.get("kind");
  const filter = kind === "exam" || kind === "flashcards" ? kind : "all";
  const page = listPage(params);
  const course = params.get("course")?.slice(0, 100) ?? null;
  const archived = params.get("archived") === "true";
  const sort = params.get("sort") === "studied" ? "studied" : "updated";
  const appliedSearch = (params.get("search") ?? "").slice(0, 200);
  const returnTo = params.size ? `/?${params}` : "/";
  const results = useRef<HTMLElement>(null);
  const viewFocus = useRef(false);
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
  const listQuery = query.toString();
  const resource = useResource<{
    items: StudySet[];
    hasMore: boolean;
    page: number;
    courses: string[];
  }>(byCourse ? null : `/sets?${listQuery}`);
  const courses = resource.lastData?.courses ?? [];
  const [panel, setPanel] = useState<
    "import" | "ai" | { aiSettings: AISettings } | null
  >(null);
  const [deleting, setDeleting] = useState<StudySet>();
  const [sharing, setSharing] = useState<StudySet>();
  const [courseVersion, setCourseVersion] = useState(0);
  const [editingCourse, setEditingCourse] = useState<StudySet>();
  const [courseName, setCourseName] = useState("");
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<Error>();
  const [bulkNotice, setBulkNotice] = useState("");
  const [bulkRecovery, setBulkRecovery] = useState<{
    scope: string;
    page: number;
  }>();
  const listScope = JSON.stringify([
    byCourse,
    filter,
    course,
    archived,
    sort,
    search,
    appliedSearch,
  ]);
  const selectionKey = JSON.stringify([listScope, page]);
  const [selection, setSelection] = useState<{
    key: string;
    ids: string[];
    editing: boolean;
  }>();
  const currentSelection =
    selection?.key === selectionKey ? selection : undefined;
  if (selection && !currentSelection) setSelection(undefined);
  const selectPage = useRef<HTMLInputElement>(null);
  const selectFocus = useRef(false);
  const visibleIds = resource.data?.items.map(({ id }) => id) ?? [];
  const selectedIds =
    currentSelection?.ids.filter((id) => visibleIds.includes(id)) ?? [];
  const allSelected =
    visibleIds.length > 0 && selectedIds.length === visibleIds.length;
  const partialSelection = selectedIds.length > 0 && !allSelected;
  useLayoutEffect(() => {
    if (selectPage.current) selectPage.current.indeterminate = partialSelection;
  }, [currentSelection, partialSelection]);
  useLayoutEffect(() => {
    if (!byCourse && viewFocus.current) {
      viewFocus.current = false;
      results.current?.focus({ preventScroll: true });
      results.current?.scrollIntoView({ block: "nearest" });
    }
  }, [byCourse]);
  useLayoutEffect(() => {
    if (!busy && !currentSelection && selectFocus.current) {
      selectFocus.current = false;
      results.current?.focus({ preventScroll: true });
    }
  }, [busy, currentSelection]);
  const emptyAfterBulk =
    bulkRecovery?.scope === listScope &&
    bulkRecovery.page === page &&
    !resource.loading &&
    !resource.error &&
    resource.data?.items.length === 0 &&
    page > 0;
  useEffect(() => {
    if (!bulkRecovery) return;
    if (bulkRecovery.scope !== listScope || bulkRecovery.page !== page) {
      setBulkRecovery(undefined);
    } else if (emptyAfterBulk) {
      setBulkRecovery({ scope: listScope, page: page - 1 });
      update({ page: page > 1 ? String(page - 1) : null });
      results.current?.focus({ preventScroll: true });
    } else if (!resource.loading && !resource.error) {
      setBulkRecovery(undefined);
    }
  }, [
    bulkRecovery,
    listScope,
    emptyAfterBulk,
    resource.loading,
    resource.error,
    page,
    update,
  ]);
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
    updateSearch("", {
      kind: null,
      page: null,
      course: null,
      archived: null,
      sort: null,
      view: null,
    });
  }
  function changeScope(next: boolean) {
    update({ archived: next ? "true" : null, page: null });
  }
  function chooseCourse(next: string) {
    viewFocus.current = true;
    setFiltersOpen(false);
    updateSearch("", { view: null, course: next, kind: null, page: null });
  }
  function changeSelection(ids: string[], editing = false) {
    setSelection({ key: selectionKey, ids, editing });
  }
  async function organizeSelected(changes: SetOrganization) {
    setBusy(true);
    setBulkError(undefined);
    setBulkNotice("");
    try {
      const { updated } = await api<{ updated: number }>(
        "/sets/organization",
        "PATCH",
        { ids: selectedIds, ...changes },
      );
      setBulkNotice(
        updated === 0
          ? "The selected sets already match this action."
          : `${updated} ${updated === 1 ? "set" : "sets"} updated.`,
      );
      selectFocus.current = true;
      setSelection(undefined);
      setBulkRecovery({ scope: listScope, page });
      resource.refresh();
    } catch (e) {
      setBulkError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  function goToPage(next: number) {
    update({ page: next > 0 ? String(next) : null });
    results.current?.focus();
    results.current?.scrollIntoView({ block: "start" });
  }
  async function organize(set: StudySet, changes: SetOrganization) {
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
      <OwnershipInvitations
        onAccept={() => {
          resource.refresh();
          if (byCourse) setCourseVersion((version) => version + 1);
        }}
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
      <ListViewSwitcher
        label="Library view"
        listLabel="All sets"
        groupedLabel="By course"
        grouped={byCourse}
        onChange={(grouped) => {
          if (grouped === byCourse) return;
          updateSearch(search, {
            view: grouped ? "courses" : null,
            page: null,
          });
        }}
      />
      <div className="list-announcement" role="status">
        {bulkNotice ? <p>{bulkNotice}</p> : null}
      </div>
      {byCourse ? (
        <LibraryCourses
          key={courseVersion}
          archived={archived}
          page={page}
          onPageChange={(next) =>
            update({ page: next > 0 ? String(next) : null })
          }
          onScopeChange={changeScope}
          onChoose={chooseCourse}
        />
      ) : (
        <>
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
            <summary>
              Library filters
              <span className="library-filter-summary muted">
                {archived ? " · Archived" : ""}
                {course !== null ? ` · ${course || "No course"}` : ""}
                {sort === "studied" ? " · Last studied" : ""}
              </span>
            </summary>
            <div className="library-filter-fields">
              <Field label="Course">
                <Selector
                  value={course === null ? "all" : `course:${course}`}
                  onValueChange={(value) =>
                    update({
                      course: value === "all" ? null : value.slice(7),
                      page: null,
                    })
                  }
                  options={[
                    { value: "all", label: "All courses" },
                    { value: "course:", label: "No course" },
                    ...(course && !courses.includes(course)
                      ? [{ value: `course:${course}`, label: course }]
                      : []),
                    ...courses.map((name) => ({
                      value: `course:${name}`,
                      label: name,
                    })),
                  ]}
                />
              </Field>
              <ArchiveScope archived={archived} onChange={changeScope} />
              <Field label="Sort library">
                <Selector
                  value={sort}
                  onValueChange={(value) =>
                    update({
                      sort: value === "studied" ? "studied" : null,
                      page: null,
                    })
                  }
                  options={[
                    { value: "updated", label: "Recently updated" },
                    { value: "studied", label: "Last studied" },
                  ]}
                />
              </Field>
            </div>
          </details>
          <Tabs
            label="Study set type"
            value={filter}
            onChange={(v) =>
              update({ kind: v === "all" ? null : v, page: null })
            }
            tabs={[
              { value: "all", label: "All" },
              { value: "exam", label: "Exams" },
              { value: "flashcards", label: "Flashcards" },
            ]}
          />
          <section
            ref={results}
            tabIndex={-1}
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
                Drafts on this device could not be checked. Device storage may
                be unavailable. Saved sets and attempts remain in your account.
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
            {visibleIds.length ? (
              <div className="selection-toolbar">
                <Button
                  aria-pressed={!!currentSelection}
                  disabled={busy || resource.loading}
                  onClick={() => {
                    setBulkNotice("");
                    if (currentSelection) setSelection(undefined);
                    else changeSelection([]);
                  }}
                >
                  {currentSelection ? "Done selecting" : "Select sets"}
                </Button>
                {currentSelection ? (
                  <>
                    <label className="checkbox-row selection-page">
                      <input
                        type="checkbox"
                        ref={selectPage}
                        checked={allSelected}
                        onChange={(event) =>
                          changeSelection(
                            event.target.checked ? visibleIds : [],
                          )
                        }
                      />
                      Select this page
                    </label>
                    <span className="muted" role="status">
                      {selectedIds.length} selected
                    </span>
                    <Button
                      disabled={!selectedIds.length || busy}
                      onClick={() => {
                        setBulkError(undefined);
                        changeSelection(selectedIds, true);
                      }}
                    >
                      Organize selected
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {(resource.loading || emptyAfterBulk) && !visibleIds.length ? (
              <LoadingRows
                label={
                  resource.lastData
                    ? "Updating study sets"
                    : "Loading study sets"
                }
              />
            ) : resource.data?.items.length ? (
              <div className="set-list" aria-busy={resource.loading}>
                {resource.data.items.map((set, i) => (
                  <SurfaceLight
                    className={`set-row${selectedIds.includes(set.id) ? " set-row-selected" : ""}`}
                    key={set.id}
                  >
                    {currentSelection ? (
                      <label className="checkbox-row selection-set">
                        <input
                          type="checkbox"
                          aria-label={`Select ${set.title}`}
                          checked={selectedIds.includes(set.id)}
                          onChange={(event) =>
                            changeSelection(
                              event.target.checked
                                ? [...selectedIds, set.id]
                                : selectedIds.filter((id) => id !== set.id),
                            )
                          }
                        />
                      </label>
                    ) : (
                      <span className="ordinal" aria-hidden="true">
                        {String(
                          (resource.data?.page ?? page) * LIST_PAGE_SIZE +
                            i +
                            1,
                        ).padStart(2, "0")}
                      </span>
                    )}
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
                      {set.ownershipRole === "co_owner" ? (
                        <span className="library-course">Co-owned</span>
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
                        <Button
                          disabled={busy}
                          onClick={() => setSettingUp(set)}
                        >
                          Practice <ArrowRight size={17} />
                        </Button>
                      )}
                      <Menu
                        label={
                          <>
                            <Ellipsis size={20} />
                            <span className="sr-only">
                              Actions for {set.title}
                            </span>
                          </>
                        }
                      >
                        {set.continuation ? (
                          <button
                            disabled={busy}
                            onClick={() => setSettingUp(set)}
                          >
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
                        {set.ownershipRole === "primary" ? (
                          <button onClick={() => setSharing(set)}>
                            Share and manage access
                          </button>
                        ) : null}
                        <button
                          disabled={busy}
                          onClick={() => void duplicate(set)}
                        >
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
                              const full = await api<StudySet>(
                                `/sets/${set.id}`,
                              );
                              exportContent(full.content);
                            } catch (e) {
                              setError(e as Error);
                            }
                          }}
                        >
                          Export
                        </button>
                        {set.ownershipRole === "primary" ? (
                          <button
                            className="negative"
                            onClick={() => {
                              setError(undefined);
                              setDeleting(set);
                            }}
                          >
                            Delete
                          </button>
                        ) : null}
                      </Menu>
                    </div>
                  </SurfaceLight>
                ))}
              </div>
            ) : !resource.error &&
              (appliedSearch ||
                filter !== "all" ||
                page > 0 ||
                course !== null ||
                archived) ? (
              <EmptyState
                title={
                  appliedSearch
                    ? "No study sets match this search."
                    : archived &&
                        course === null &&
                        filter === "all" &&
                        page === 0
                      ? "No archived study sets."
                      : "No study sets match this filter."
                }
                actions={
                  <>
                    {appliedSearch ? (
                      <Button
                        onClick={() => {
                          updateSearch("", { page: null });
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
                  Try a different title or reset the filters to see your study
                  sets.
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
                  Import a study set from a file. Create one manually in the
                  editor. Or prepare a file in your own external AI tool and
                  return to import it.
                </p>
              </EmptyState>
            ) : null}
            <Pagination
              label="Library pages"
              page={page}
              hasMore={resource.data?.hasMore}
              loading={resource.loading}
              onChange={goToPage}
            />
          </section>
        </>
      )}
      {currentSelection?.editing ? (
        <BulkOrganizationDialog
          count={selectedIds.length}
          courses={courses}
          archived={archived}
          busy={busy}
          error={bulkError}
          onClose={() => {
            if (!busy) changeSelection(selectedIds);
          }}
          onSave={(changes) => void organizeSelected(changes)}
        />
      ) : null}
      {panel && panel !== "ai" ? (
        <ImportPanel
          aiSettings={panel === "import" ? undefined : panel.aiSettings}
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
          key={user!.id}
          onClose={() => setPanel(null)}
          onImport={(aiSettings) => setPanel({ aiSettings })}
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
              <Selector
                editable
                maxLength={100}
                value={courseName}
                onValueChange={setCourseName}
                options={courses.map((name) => ({ value: name, label: name }))}
              />
            </Field>
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
      {sharing ? (
        <SetSharing id={sharing.id} onClose={() => setSharing(undefined)} />
      ) : null}
      {deleting ? (
        <Dialog
          title="Delete this study set?"
          onClose={() => setDeleting(undefined)}
        >
          <p>
            “{deleting.title}” will be removed from the library of every owner.
            Everyone keeps their own past attempts in History.
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
