import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Upload, Plus, ArrowLeft, ChevronDown, Folder, X } from "lucide-react";
import { useResource } from "../lib/hooks";
import { api, type StudySet, type StudySetMetadata } from "../lib/api";
import { useAuth } from "../lib/auth";
import { accountDrafts, type Draft } from "../lib/drafts";
import type { AISettings } from "../lib/aiSettings";
import { useLibraryContext } from "../lib/useLibraryContext";
import { listPage, useListQuery } from "../lib/listQuery";
import {
  LIST_PAGE_SIZE,
  folderSorts,
  setSorts,
  type LibraryFolder,
  type ManualOrder,
  type SetOrganization,
} from "../../shared/listing";
import { ListOrdering } from "../components/ListOrdering";
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
import { AIHandoffPanel } from "./AIHandoffPanel";
import { ImportPanel } from "./ImportPanel";
import { LibrarySetRow, type LibrarySetRowActions } from "./LibrarySetRow";
import { PracticeSetup, type PracticeSet } from "../components/PracticeSetup";
import { NextStudyAction } from "./NextStudyAction";
import { OwnershipInvitations, SetSharing } from "./SetSharing";
import {
  ArchiveScope,
  BulkOrganizationDialog,
  FolderPicker,
  LibraryFolders,
  PositionDialog,
  ReorderActions,
  type OrderItem,
} from "./LibraryOrganization";
import "./library-editor.css";

const setArrangements = [
  { value: "updated", label: "Last updated" },
  { value: "studied", label: "Last studied" },
  { value: "title", label: "Title" },
] as const;
const folderSetArrangements = [
  ...setArrangements,
  { value: "manual", label: "Manual" },
] as const;
const folderArrangements = [
  { value: "name", label: "Name" },
  { value: "manual", label: "Manual" },
] as const;
const directoryView = (params: URLSearchParams) =>
  (params.get("view") === "folders" || params.get("view") === "courses") &&
  !params.has("folder");
const emptyFolders: LibraryFolder[] = [];

export function LibraryPage() {
  const { params, update, search, setSearch, updateSearch } = useListQuery(
    "library",
    [
      "search",
      "page",
      "kind",
      "course",
      "folder",
      "folderSearch",
      "folderSort",
      "folderOrder",
      "archived",
      "sort",
      "order",
      "view",
    ],
    [],
    (params) => (directoryView(params) ? "folderSearch" : "search"),
  );
  const inDirectory = directoryView(params);
  const kind = params.get("kind");
  const filter = kind === "exam" || kind === "flashcards" ? kind : "all";
  const page = listPage(params);
  const legacyCourse = params.get("course")?.slice(0, 100) ?? null;
  const folder = params.get("folder");
  const archived = params.get("archived") === "true";
  const folderSort =
    folderSorts.find((value) => value === params.get("folderSort")) ?? "name";
  const folderOrder = params.get("folderOrder") === "desc" ? "desc" : "asc";
  const sort =
    setSorts.find(
      (value) =>
        value === params.get("sort") && (value !== "manual" || folder !== null),
    ) ?? "updated";
  const order = params.has("order")
    ? params.get("order") === "asc"
      ? "asc"
      : "desc"
    : sort === "title"
      ? "asc"
      : "desc";
  const appliedSearch = (params.get("search") ?? "").slice(0, 200);
  const searchFilter =
    search || (inDirectory ? params.get("folderSearch") : appliedSearch);
  const returnTo = params.size ? `/library?${params}` : "/library";
  const results = useRef<HTMLElement>(null);
  const viewFocus = useRef(false);
  const [saved, setSaved] = useState<StudySet>();
  const [settingUp, setSettingUp] = useState<PracticeSet>();
  const [sample, setSample] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const query = new URLSearchParams({
    page: String(page),
    search: appliedSearch,
  });
  if (filter !== "all") query.set("kind", filter);
  if (folder !== null) query.set("folderId", folder);
  else if (legacyCourse !== null) query.set("course", legacyCourse);
  if (archived) query.set("archived", "true");
  if (sort !== "updated") query.set("sort", sort);
  if (params.has("order") && sort !== "manual") query.set("order", order);
  const listQuery = query.toString();
  const resource = useResource<{
    items: StudySetMetadata[];
    hasMore: boolean;
    page: number;
    manual?: ManualOrder;
  }>(inDirectory ? null : `/sets?${listQuery}&folders=0`);
  const showSuggestion =
    !inDirectory &&
    folder === null &&
    legacyCourse === null &&
    !archived &&
    !searchFilter &&
    filter === "all" &&
    !saved;
  const context = useLibraryContext(showSuggestion);
  const nextStudyAction =
    showSuggestion && !context.error ? context.data?.suggestion : null;
  const folders = context.data?.folders ?? emptyFolders;
  const currentFolder = folders.find(({ id }) => id === folder);
  const folderName =
    folder === "" ? "Unfiled" : (currentFolder?.name ?? legacyCourse);
  const manualOrder =
    sort === "manual" && !search && filter === "all" && folder !== null
      ? resource.data?.manual
      : undefined;
  const [panel, setPanel] = useState<
    "import" | "ai" | { aiSettings: AISettings } | null
  >(null);
  const [deleting, setDeleting] = useState<StudySetMetadata>();
  const [sharing, setSharing] = useState<StudySetMetadata>();
  const [folderVersion, setFolderVersion] = useState(0);
  const [movingSet, setMovingSet] = useState<StudySetMetadata>();
  const [destination, setDestination] = useState("");
  const [positionItem, setPositionItem] = useState<OrderItem>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<Error>();
  const [bulkNotice, setBulkNotice] = useState("");
  const [bulkRecovery, setBulkRecovery] = useState<{
    scope: string;
    page: number;
  }>();
  const listScope = JSON.stringify([
    inDirectory,
    filter,
    folder,
    legacyCourse,
    archived,
    sort,
    order,
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
  const focusSelection = useRef(false);
  const selectFocus = useRef(false);
  const visibleIds = resource.data?.items.map(({ id }) => id) ?? [];
  const selectedIds =
    currentSelection?.ids.filter((id) => visibleIds.includes(id)) ?? [];
  const allSelected =
    visibleIds.length > 0 && selectedIds.length === visibleIds.length;
  const partialSelection = selectedIds.length > 0 && !allSelected;
  useLayoutEffect(() => {
    if (selectPage.current) selectPage.current.indeterminate = partialSelection;
    if (currentSelection && focusSelection.current) {
      focusSelection.current = false;
      selectPage.current?.focus();
    }
  }, [currentSelection, partialSelection]);
  useLayoutEffect(() => {
    if (!inDirectory && viewFocus.current) {
      viewFocus.current = false;
      results.current?.focus({ preventScroll: true });
      results.current?.scrollIntoView({ block: "nearest" });
    }
  }, [inDirectory, folder]);
  useEffect(() => {
    if (
      inDirectory ||
      folder !== null ||
      legacyCourse === null ||
      !resource.data
    )
      return;
    const match = legacyCourse
      ? folders.find(({ name }) => name === legacyCourse)?.id
      : "";
    if (match !== undefined)
      update({ course: null, folder: match, view: "folders" });
  }, [folder, inDirectory, legacyCourse, resource.data, folders, update]);
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
      folder: null,
      archived: null,
      sort: null,
      order: null,
      view: null,
      folderSearch: null,
    });
  }
  function changeScope(next: boolean) {
    update({ archived: next ? "true" : null, page: null });
  }
  function refreshLibrary() {
    resource.refresh();
    context.refresh("suggestion");
  }
  function chooseFolder(next: string) {
    viewFocus.current = true;
    update({
      folderSearch: search || null,
      view: "folders",
      folder: next,
      course: null,
      search: null,
      kind: null,
      page: null,
    });
  }
  function openDirectory() {
    update({ view: "folders", folder: null, course: null, page: null });
  }
  function openAllSets() {
    update({
      view: null,
      folder: null,
      course: null,
      page: null,
      ...(params.get("sort") === "manual" ? { sort: null, order: null } : {}),
    });
  }
  function resetSetFilters() {
    updateSearch("", { kind: null, page: null });
  }
  function movedSet(title: string, position: number) {
    setPositionItem(undefined);
    setError(undefined);
    setBulkNotice(`Moved “${title}” to position ${position}.`);
    resource.refresh();
    goToPage(Math.floor((position - 1) / LIST_PAGE_SIZE));
  }
  function reorderFailed(error: Error) {
    setPositionItem(undefined);
    setError(error);
    resource.refresh();
    results.current?.focus({ preventScroll: true });
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
      refreshLibrary();
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
  async function organize(set: StudySetMetadata, changes: SetOrganization) {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/sets/${set.id}/organization`, "PATCH", changes);
      setMovingSet(undefined);
      setBulkRecovery({ scope: listScope, page });
      refreshLibrary();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(set: StudySetMetadata) {
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
      if (deleting.ownershipRole === "viewer")
        await api(`/sets/${deleting.id}/membership`, "DELETE", {});
      else
        await api(`/sets/${deleting.id}`, "DELETE", {
          revision: deleting.revision,
        });
      setDeleting(undefined);
      refreshLibrary();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  const rowActions: LibrarySetRowActions = {
    practice: setSettingUp,
    share: setSharing,
    duplicate: (set) => void duplicate(set),
    move: (set) => {
      setError(undefined);
      setDestination(set.folderId ?? "");
      setMovingSet(set);
    },
    organize: (set, changes) => void organize(set, changes),
    export: async (set) => {
      try {
        const [full, { exportContent }] = await Promise.all([
          api<StudySet>(`/sets/${set.id}`),
          import("../lib/exportContent"),
        ]);
        exportContent(full.content);
      } catch (e) {
        setError(e as Error);
      }
    },
    remove: (set) => {
      setError(undefined);
      setDeleting(set);
    },
  };
  return (
    <div className="library-page">
      <PageHeader
        title="Your library"
        display
        actions={
          <>
            <Button
              variant={nextStudyAction ? "secondary" : "primary"}
              onClick={() => setPanel("import")}
            >
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
      {nextStudyAction ? (
        <NextStudyAction
          suggestion={nextStudyAction}
          returnTo={returnTo}
          busy={busy}
          onPractice={setSettingUp}
        />
      ) : null}
      <ErrorNotice error={context.error} retry={context.retry} />
      <OwnershipInvitations
        invitations={context.data?.invitations ?? []}
        onRemoved={context.removeInvitation}
        refresh={() => context.refresh("invitations")}
        onAccept={() => {
          refreshLibrary();
          if (inDirectory) setFolderVersion((version) => version + 1);
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
      {folder !== null || legacyCourse !== null ? (
        <div className="folder-heading">
          <Button variant="quiet" onClick={openDirectory}>
            <ArrowLeft size={16} aria-hidden="true" />
            Back to folders
          </Button>
          <h2>
            <Folder size={22} aria-hidden="true" />
            {folderName || "Folder"}
          </h2>
        </div>
      ) : null}
      <div className="library-tools">
        <Field label={inDirectory ? "Search folders" : "Search library"}>
          <input
            key={inDirectory ? "folders" : "sets"}
            type="search"
            value={search}
            maxLength={200}
            placeholder={
              inDirectory
                ? "Find a folder by name"
                : "Find a study set by title"
            }
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <ListViewSwitcher
          label="Library view"
          listLabel="All sets"
          groupedLabel="Folders"
          grouped={inDirectory || folder !== null}
          onChange={(grouped) => {
            if (grouped && !inDirectory) openDirectory();
            if (!grouped && (inDirectory || folder !== null)) openAllSets();
          }}
        />
        <Button
          className="library-view-options"
          aria-expanded={optionsOpen}
          aria-controls="library-option-fields"
          onClick={() => setOptionsOpen(!optionsOpen)}
        >
          View options <ChevronDown size={16} aria-hidden="true" />
        </Button>
        <div
          className="library-option-fields"
          id="library-option-fields"
          hidden={!optionsOpen}
        >
          <ArchiveScope archived={archived} onChange={changeScope} />
          {inDirectory ? (
            <ListOrdering
              sort={folderSort}
              order={folderOrder}
              options={folderArrangements}
              alphabetical
              onSort={(value) =>
                update({
                  folderSort: value === "name" ? null : value,
                  folderOrder: null,
                  page: null,
                })
              }
              onOrder={(value) =>
                update({
                  folderOrder: value === "asc" ? null : value,
                  page: null,
                })
              }
            />
          ) : (
            <ListOrdering
              sort={sort}
              order={order}
              options={
                folder === null ? setArrangements : folderSetArrangements
              }
              alphabetical={sort === "title"}
              onSort={(value) =>
                update({
                  sort: value === "updated" ? null : value,
                  order: null,
                  page: null,
                })
              }
              onOrder={(value) => update({ order: value, page: null })}
            />
          )}
          {!inDirectory && visibleIds.length > 0 && !currentSelection ? (
            <Button
              disabled={busy || resource.loading}
              onClick={() => {
                setBulkNotice("");
                setOptionsOpen(false);
                focusSelection.current = true;
                changeSelection([]);
              }}
            >
              Select sets
            </Button>
          ) : null}
        </div>
      </div>
      {searchFilter || archived || (!inDirectory && filter !== "all") ? (
        <div
          className="applied-filters library-filters"
          role="group"
          aria-label="Applied filters"
        >
          {searchFilter ? (
            <Button
              variant="quiet"
              className="library-search-filter"
              aria-label="Remove search filter"
              onClick={() => updateSearch("", { page: null })}
            >
              <span>“{searchFilter}”</span>
              <X size={16} aria-hidden="true" />
            </Button>
          ) : null}
          {archived ? (
            <Button
              variant="quiet"
              aria-label="Show active sets"
              onClick={() => changeScope(false)}
            >
              Archived <X size={16} aria-hidden="true" />
            </Button>
          ) : null}
          {!inDirectory && filter !== "all" ? (
            <Button
              variant="quiet"
              aria-label="Show all study set types"
              onClick={() => update({ kind: null, page: null })}
            >
              {filter === "exam" ? "Exams" : "Flashcards"}
              <X size={16} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="list-announcement" role="status">
        {bulkNotice && !inDirectory ? <p>{bulkNotice}</p> : null}
      </div>
      {inDirectory ? (
        <LibraryFolders
          key={folderVersion}
          onFolderChange={() => context.refresh("folders")}
          archived={archived}
          page={page}
          search={search}
          appliedSearch={(params.get("folderSearch") ?? "")
            .slice(0, 200)
            .trim()}
          sort={folderSort}
          order={folderOrder}
          onClearSearch={() => updateSearch("", { page: null })}
          onPageChange={(next) =>
            update({ page: next > 0 ? String(next) : null })
          }
          onChoose={chooseFolder}
        />
      ) : (
        <>
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
          {sort === "manual" && (search || filter !== "all") ? (
            <div className="applied-filters">
              <span className="muted">
                Clear search and type filters to reorder sets.
              </span>
              <Button variant="quiet" onClick={resetSetFilters}>
                Clear filters <X size={16} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
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
            {folder === null && legacyCourse === null && draftError ? (
              <Notice tone="warning">
                Drafts on this device could not be checked. Device storage may
                be unavailable. Saved sets and attempts remain in your account.
              </Notice>
            ) : null}
            {folder === null && legacyCourse === null && drafts.length ? (
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
            {currentSelection && visibleIds.length ? (
              <div className="selection-toolbar">
                <label className="checkbox-row selection-page">
                  <input
                    type="checkbox"
                    ref={selectPage}
                    checked={allSelected}
                    onChange={(event) =>
                      changeSelection(event.target.checked ? visibleIds : [])
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
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => {
                    selectFocus.current = true;
                    setSelection(undefined);
                  }}
                >
                  Done selecting
                </Button>
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
                  <LibrarySetRow
                    key={set.id}
                    set={set}
                    ordinal={
                      (resource.data?.page ?? page) * LIST_PAGE_SIZE + i + 1
                    }
                    selecting={!!currentSelection}
                    selected={selectedIds.includes(set.id)}
                    showFolder={folder === null}
                    onSelect={(checked) =>
                      changeSelection(
                        checked
                          ? [...selectedIds, set.id]
                          : selectedIds.filter((id) => id !== set.id),
                      )
                    }
                    busy={busy}
                    returnTo={returnTo}
                    actions={rowActions}
                    reorder={
                      manualOrder ? (
                        <ReorderActions
                          itemId={set.id}
                          title={set.title}
                          position={page * LIST_PAGE_SIZE + i + 1}
                          order={manualOrder}
                          location={{
                            kind: "set",
                            folderId: folder || null,
                            archived,
                          }}
                          disabled={busy || resource.loading}
                          onBusy={setBusy}
                          onPrompt={setPositionItem}
                          onError={reorderFailed}
                          onMoved={(position) => movedSet(set.title, position)}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </div>
            ) : !resource.error &&
              (appliedSearch ||
                filter !== "all" ||
                page > 0 ||
                folder !== null ||
                legacyCourse !== null ||
                archived) ? (
              <EmptyState
                title={
                  appliedSearch
                    ? "No study sets match this search."
                    : page === 0 && filter === "all"
                      ? folder !== null || legacyCourse !== null
                        ? archived
                          ? "No archived study sets in this folder."
                          : "No study sets in this folder."
                        : "No archived study sets."
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
                    {filter !== "all" || page > 0 ? (
                      <Button onClick={resetSetFilters}>Reset filters</Button>
                    ) : null}
                  </>
                }
              >
                {appliedSearch ? (
                  <p className="muted">Try a different title.</p>
                ) : folder !== null &&
                  filter === "all" &&
                  page === 0 &&
                  !archived ? (
                  <p className="muted">Move study sets here from All sets.</p>
                ) : null}
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
          folders={folders}
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
            refreshLibrary();
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
      {positionItem ? (
        <PositionDialog
          item={positionItem}
          onClose={() => setPositionItem(undefined)}
          onMoved={(position) => movedSet(positionItem.title, position)}
          onError={reorderFailed}
        />
      ) : null}
      {movingSet ? (
        <Dialog
          title="Move to folder"
          onClose={() => {
            if (!busy) setMovingSet(undefined);
          }}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy)
                void organize(movingSet, { folderId: destination || null });
            }}
          >
            <p>{movingSet.title}</p>
            <FolderPicker
              folders={folders}
              value={destination}
              onChange={setDestination}
              disabled={busy}
            />
            <ErrorNotice error={error} />
            <div className="actions">
              <Button disabled={busy} onClick={() => setMovingSet(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} type="submit">
                Move set
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
          title={
            deleting.ownershipRole === "viewer"
              ? "Remove from your library?"
              : "Delete this study set?"
          }
          onClose={() => setDeleting(undefined)}
        >
          <p>
            {deleting.ownershipRole === "viewer"
              ? `Remove “${deleting.title}” from your library.`
              : `“${deleting.title}” will be removed from everyone’s library.`}
            Everyone keeps their own past attempts in History.
          </p>
          <ErrorNotice error={error} />
          <div className="actions">
            <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
            <Button variant="danger" busy={busy} onClick={remove}>
              {deleting.ownershipRole === "viewer" ? "Remove" : "Delete set"}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
