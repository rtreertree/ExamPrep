import { Selector } from "../components/Selector";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import {
  ArrowUp,
  ArrowDown,
  Copy,
  ListOrdered,
  Plus,
  Search,
  Trash2,
  Download,
} from "lucide-react";
import {
  emptyContent,
  freshId,
  itemsOf,
  validateContent,
  type StudyContent,
  type Question,
  type Card,
  type AnswerType,
  type Criterion,
} from "../../shared/content";
import {
  api,
  ApiError,
  download,
  exportContent,
  type StudySet,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { getDraft, putDraft, removeDraft, type Draft } from "../lib/drafts";
import { issuesOf, issueLabel } from "../lib/issues";
import type { Issue } from "../../shared/json";
import { useUnsaved } from "../lib/hooks";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  FieldIssues,
  LoadingRows,
  Notice,
  PageHeader,
  SaveStatus,
  Tabs,
} from "../components/ui";
import { ContentPreview } from "./Authoring";
import { RubricList } from "../components/RubricList";
import { NotationEditor } from "../components/NotationEditor";
import { PracticeSetup } from "../components/PracticeSetup";
import "./library-editor.css";

type Loaded = { set?: StudySet; draft?: Draft; missing: boolean };
type Removal =
  | { kind: "item"; item: Question | Card; index: number }
  | {
      kind: "option";
      itemId: string;
      option: { id: string; text: string };
      index: number;
      wasAnswer: boolean;
    }
  | { kind: "criterion"; itemId: string; criterion: Criterion; index: number };

function matchesItem(item: Question | Card, search: string) {
  const matches = (text: string) => text.toLowerCase().includes(search);
  if ("front" in item) return matches(item.front) || matches(item.back);
  if (matches(item.prompt) || matches(item.explanation ?? "")) return true;
  return item.type === "single_choice"
    ? item.options.some(({ text }) => matches(text))
    : matches(item.answer) ||
        item.rubric?.some(({ description }) => matches(description));
}

export function EditorPage() {
  const { id, kind, draftId } = useParams();
  const { user } = useAuth();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<Error>();
  const key = id || `new:${draftId}`;
  useEffect(() => {
    let live = true;
    setLoaded(undefined);
    setError(undefined);
    Promise.all([
      id
        ? api<StudySet>(`/sets/${id}`).catch((e) => {
            if (e instanceof ApiError && e.status === 404) return undefined;
            throw e;
          })
        : Promise.resolve(undefined),
      getDraft(user!.id, key).catch(() => undefined),
    ])
      .then(([set, draft]) => {
        if (live) setLoaded({ set, draft, missing: !!id && !set });
      })
      .catch((e) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [id, key, user!.id]);
  if (error) return <ErrorNotice error={error} />;
  if (!loaded) return <LoadingRows />;
  if (loaded.missing && !loaded.draft)
    return (
      <Notice tone="warning">
        This study set was deleted or is unavailable.{" "}
        <Link to="/">Return to library</Link>
      </Notice>
    );
  return (
    <Editor
      key={key}
      initial={loaded}
      draftKey={key}
      kind={kind === "flashcards" ? "flashcards" : "exam"}
    />
  );
}
function Editor({
  initial,
  draftKey,
  kind,
}: {
  initial: Loaded;
  draftKey: string;
  kind: StudyContent["kind"];
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [content, setContent] = useState<StudyContent>(
    () => initial.set?.content ?? emptyContent(kind),
  );
  const [revision, setRevision] = useState<number | null>(
    initial.set?.revision ?? null,
  );
  const [setId, setSetId] = useState(initial.set?.id);
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(initial.set?.content ?? content),
  );
  const [recovery, setRecovery] = useState(initial.draft);
  const [conflict, setConflict] = useState(initial.missing);
  const [index, setIndex] = useState(0);
  const [itemSearch, setItemSearch] = useState("");
  const [itemSearchOpen, setItemSearchOpen] = useState(false);
  const itemSearchId = useId();
  const itemSearchField = useRef<HTMLInputElement>(null);
  const searchTerm = useDeferredValue(itemSearch.trim().toLowerCase());
  const [movePosition, setMovePosition] = useState<string>();
  const [settingUp, setSettingUp] = useState<StudySet>();
  const [mode, setMode] = useState("edit");
  const [localStatus, setLocalStatus] = useState("No local changes");
  const [databaseStatus, setDatabaseStatus] = useState(
    initial.set ? "Saved" : "Not saved to account",
  );
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState<Error>();
  const [announce, setAnnounce] = useState("");
  const [fieldIssues, setFieldIssues] = useState<Issue[]>([]);
  const [removals, setRemovals] = useState<Removal[]>([]);
  const [metadataOpen, setMetadataOpen] = useState(!initial.set);
  const [showIssueSummary, setShowIssueSummary] = useState(false);
  const touched = useRef(new Set<string>());
  const fullCheck = useRef(false);
  const issueCursor = useRef(0);
  function checkFields() {
    try {
      validateContent(current.current);
      setFieldIssues([]);
    } catch (e) {
      setFieldIssues(
        issuesOf(e as Error).filter(
          (issue) => fullCheck.current || touched.current.has(issue.path),
        ),
      );
    }
  }
  function focusIssue(issue: Issue) {
    const match = /^\/(?:questions|cards)\/(\d+)/.exec(issue.path);
    if (match) setIndex(Number(match[1]));
    else setMetadataOpen(true);
    setMode("edit");
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLElement>(
        `[data-field-path="${CSS.escape(issue.path)}"]`,
      );
      const control =
        field?.querySelector<HTMLElement>(
          "input,textarea,button[role=combobox]",
        ) ?? document.querySelector<HTMLElement>(".edit-column textarea");
      control?.focus();
      control?.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }
  function recoveryDownload() {
    download(
      JSON.stringify(
        {
          purpose: "Unfinished editor draft, not an importable study set",
          version: 1,
          setId,
          baseRevision: revision,
          content: current.current,
        },
        null,
        2,
      ),
      "editor-draft-recovery.json",
    );
  }
  const saving = useRef(false);
  const current = useRef(content);
  current.current = content;
  const serialized = JSON.stringify(content);
  const dirty = serialized !== baseline;
  const allowedLeave = useRef(false);
  useUnsaved(dirty);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      !allowedLeave.current &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (recovery) return;
    if (!dirty) {
      setLocalStatus("No local changes");
      void removeDraft(user!.id, draftKey).catch(() => {});
      return;
    }
    setLocalStatus("Saving local draft…");
    let active = true;
    const timeout = setTimeout(() => {
      void putDraft({
        version: 1,
        userId: user!.id,
        key: draftKey,
        baseRevision: revision,
        content,
        updatedAt: Date.now(),
      })
        .then(() => {
          if (!active) return;
          setLocalStatus("Saved");
          setStorageError(undefined);
        })
        .catch(() => {
          if (!active) return;
          setLocalStatus("Could not save");
          setStorageError(
            new Error(
              "Device storage is unavailable. Keep this page open and save to your account or export your content.",
            ),
          );
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [content, dirty, draftKey, recovery, revision, user!.id]);
  async function discardRecovery() {
    try {
      await removeDraft(user!.id, draftKey);
      setRecovery(undefined);
      if (initial.missing) {
        allowedLeave.current = true;
        navigate("/");
      }
    } catch {
      setStorageError(
        new Error("Could not remove the local draft. Try again."),
      );
    }
  }
  function restore() {
    if (!recovery) return;
    setContent(recovery.content);
    setRevision(recovery.baseRevision);
    setConflict(
      initial.missing ||
        (initial.set ? recovery.baseRevision !== initial.set.revision : false),
    );
    setRecovery(undefined);
    setIndex(0);
    setLocalStatus("Draft restored");
  }
  async function save(asNew = false, practiceAfter = false) {
    if (saving.current) return;
    fullCheck.current = true;
    setShowIssueSummary(true);
    saving.current = true;
    setBusy(true);
    setError(undefined);
    setDatabaseStatus("Saving…");
    const captured = structuredClone(current.current);
    let accountSaved = false;
    try {
      const valid = validateContent(captured);
      const set = await api<StudySet>(
        asNew || !setId ? "/sets" : `/sets/${setId}`,
        asNew || !setId ? "POST" : "PUT",
        asNew || !setId ? valid : { revision, content: valid },
      );
      accountSaved = true;
      setFieldIssues([]);
      setRevision(set.revision);
      setSetId(set.id);
      setBaseline(JSON.stringify(captured));
      setConflict(false);
      setDatabaseStatus("Saved");
      try {
        if (JSON.stringify(current.current) === JSON.stringify(captured))
          await removeDraft(user!.id, draftKey);
        else
          await putDraft({
            version: 1,
            userId: user!.id,
            key: draftKey,
            baseRevision: set.revision,
            content: current.current,
            updatedAt: Date.now(),
          });
      } catch {
        setStorageError(
          new Error(
            "Your account save succeeded, but the device draft could not be updated.",
          ),
        );
      }
      if (practiceAfter) setSettingUp(set);
      else if (!initial.set || asNew) {
        allowedLeave.current = true;
        navigate(`/sets/${set.id}/edit`, { replace: true });
      }
    } catch (e) {
      setDatabaseStatus(accountSaved ? "Saved" : "Could not save");
      setFieldIssues(issuesOf(e as Error));
      setError(e as Error);
      if (e instanceof ApiError && [404, 409].includes(e.status))
        setConflict(true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const items = itemsOf(content);
  const item = items[index];
  const listedItems = useMemo(
    () =>
      items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !searchTerm || matchesItem(item, searchTerm)),
    [items, searchTerm],
  );
  const missingAnswers: Issue[] =
    content.kind === "exam"
      ? content.questions.flatMap((q, i) =>
          q.type === "single_choice" &&
          !q.options.some((o) => o.id === q.answer)
            ? [
                {
                  path: `/questions/${i}/answer`,
                  message:
                    "The correct option was removed. Select a replacement correct answer.",
                },
              ]
            : [],
        )
      : [];
  const visibleIssues = [
    ...missingAnswers,
    ...fieldIssues.filter(
      (issue) => !missingAnswers.some((missing) => missing.path === issue.path),
    ),
  ];
  function rememberRemoval(removal: Removal) {
    setRemovals((previous) => [...previous, removal]);
    touched.current.clear();
    setFieldIssues([]);
  }
  const lastRemoval = removals.at(-1);
  const undoAvailable =
    !!lastRemoval &&
    (lastRemoval.kind === "item"
      ? items.length < 500
      : content.kind === "exam" &&
        content.questions.some(
          (q) =>
            q.id === lastRemoval.itemId &&
            (lastRemoval.kind === "option"
              ? q.type === "single_choice" && q.options.length < 6
              : q.type === "written" && (q.rubric?.length ?? 0) < 20),
        ));
  function undoRemoval() {
    if (!lastRemoval || !undoAvailable) return;
    if (lastRemoval.kind === "item") {
      const restored = [...items];
      const position = Math.min(lastRemoval.index, restored.length);
      restored.splice(position, 0, lastRemoval.item);
      setContent(
        content.kind === "exam"
          ? { ...content, questions: restored as Question[] }
          : { ...content, cards: restored as Card[] },
      );
      setIndex(position);
    } else if (content.kind === "exam") {
      setContent({
        ...content,
        questions: content.questions.map((q) => {
          if (q.id !== lastRemoval.itemId) return q;
          if (lastRemoval.kind === "option" && q.type === "single_choice") {
            const options = [...q.options];
            options.splice(lastRemoval.index, 0, lastRemoval.option);
            return {
              ...q,
              options,
              answer:
                lastRemoval.wasAnswer && !q.answer
                  ? lastRemoval.option.id
                  : q.answer,
            };
          }
          if (lastRemoval.kind === "criterion" && q.type === "written") {
            const rubric = [...(q.rubric ?? [])];
            rubric.splice(lastRemoval.index, 0, lastRemoval.criterion);
            return { ...q, rubric };
          }
          return q;
        }),
      });
      setIndex(content.questions.findIndex((q) => q.id === lastRemoval.itemId));
    }
    setMode("edit");
    setRemovals((previous) => previous.slice(0, -1));
    touched.current.clear();
    setFieldIssues([]);
    setAnnounce("Removed content restored.");
  }
  function updateItem(next: Question | Card) {
    if (content.kind === "exam")
      setContent({
        ...content,
        questions: content.questions.map((q, i) =>
          i === index ? (next as Question) : q,
        ),
      });
    else
      setContent({
        ...content,
        cards: content.cards.map((c, i) => (i === index ? (next as Card) : c)),
      });
  }
  function add(type: "single_choice" | "written" | "card") {
    const id = freshId();
    if (content.kind === "exam") {
      const q: Question =
        type === "written"
          ? { id, type: "written", prompt: "", answer: "" }
          : {
              id,
              type: "single_choice",
              prompt: "",
              options: [
                { id: "a", text: "" },
                { id: "b", text: "" },
              ],
              answer: "a",
            };
      setContent({ ...content, questions: [...content.questions, q] });
    } else
      setContent({
        ...content,
        cards: [...content.cards, { id, front: "", back: "" }],
      });
    setIndex(items.length);
    setItemSearch("");
    setAnnounce("Item added.");
  }
  function replaceItems(next: (Question | Card)[], activeIndex: number) {
    touched.current.clear();
    setFieldIssues([]);
    setContent(
      content.kind === "exam"
        ? { ...content, questions: next as Question[] }
        : { ...content, cards: next as Card[] },
    );
    setIndex(activeIndex);
  }
  function move(destination: number) {
    if (
      !item ||
      destination < 0 ||
      destination >= items.length ||
      destination === index
    )
      return;
    const next = [...items];
    next.splice(index, 1);
    next.splice(destination, 0, item);
    replaceItems(next, destination);
    setAnnounce(`Item moved to position ${destination + 1}.`);
  }
  function duplicateItem() {
    if (!item || items.length >= 500) return;
    const next = [...items];
    next.splice(index + 1, 0, { ...structuredClone(item), id: freshId() });
    replaceItems(next, index + 1);
    setAnnounce(`Item copied to position ${index + 2}.`);
  }
  function remove() {
    rememberRemoval({ kind: "item", item: structuredClone(item), index });
    if (content.kind === "exam")
      setContent({
        ...content,
        questions: content.questions.filter((_, i) => i !== index),
      });
    else
      setContent({
        ...content,
        cards: content.cards.filter((_, i) => i !== index),
      });
    setIndex(Math.max(0, index - 1));
    setAnnounce("Item removed.");
  }
  function optional(name: "description", value: string) {
    const next = { ...content };
    if (value === "") delete next[name];
    else next[name] = value;
    setContent(next);
  }
  const addActions = (
    <div className="stack item-add">
      {content.kind === "exam" ? (
        <>
          <Button
            disabled={items.length >= 500}
            onClick={() => add("single_choice")}
          >
            <Plus size={16} />
            Single choice
          </Button>
          <Button disabled={items.length >= 500} onClick={() => add("written")}>
            <Plus size={16} />
            Written answer
          </Button>
        </>
      ) : (
        <Button disabled={items.length >= 500} onClick={() => add("card")}>
          <Plus size={16} />
          Add card
        </Button>
      )}
    </div>
  );
  return (
    <div className="editor-page">
      <Link className="back-link" to="/">
        ← Library
      </Link>
      <PageHeader
        title={content.title || "Untitled study set"}
        actions={
          <>
            <Button
              onClick={() => {
                try {
                  exportContent(validateContent(content));
                  setError(undefined);
                } catch (e) {
                  setError(e as Error);
                }
              }}
            >
              <Download size={18} />
              Export
            </Button>
            <Button
              disabled={!!recovery || conflict}
              busy={busy}
              onClick={() => void save(false, true)}
            >
              Save and practice
            </Button>
          </>
        }
      />
      <div className="editor-persistent-controls">
        <div className="editor-savebar">
          <div className="editor-save-state">
            <SaveStatus
              state={
                dirty && databaseStatus === "Saved"
                  ? "Unsaved account changes"
                  : databaseStatus
              }
            />
            <SaveStatus state={localStatus} local />
          </div>
          <Button
            variant="primary"
            busy={busy}
            disabled={!!recovery || conflict}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
        {lastRemoval ? (
          <div className="removal-notice" role="status">
            <span>
              {lastRemoval.kind === "item"
                ? "type" in lastRemoval.item
                  ? "Question"
                  : "Card"
                : lastRemoval.kind === "option"
                  ? "Option"
                  : "Criterion"}{" "}
              removed.
            </span>
            <Button
              disabled={!undoAvailable || busy || !!recovery}
              onClick={undoRemoval}
            >
              Undo
            </Button>
            <Button variant="quiet" onClick={() => setRemovals([])}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
      {recovery ? (
        <Notice tone="warning">
          <p>
            A local draft from {new Date(recovery.updatedAt).toLocaleString()}{" "}
            is available. Restore it to continue editing, or discard it to use
            the saved version.
          </p>
          <div className="actions">
            <Button onClick={restore}>Restore draft</Button>
            <Button variant="quiet" onClick={() => void discardRecovery()}>
              Discard draft
            </Button>
          </div>
        </Notice>
      ) : null}
      {conflict && !recovery ? (
        <Notice tone="warning">
          <p>
            {initial.missing
              ? "The original set was deleted."
              : "The saved version changed since this draft began."}{" "}
            Preserve these changes as a new set, or discard them.
          </p>
          <div className="actions">
            <Button
              variant="primary"
              busy={busy}
              onClick={() => void save(true)}
            >
              Save as new set
            </Button>
            <Button
              onClick={async () => {
                try {
                  await removeDraft(user!.id, draftKey);
                  allowedLeave.current = true;
                  window.location.assign(setId ? `/sets/${setId}/edit` : "/");
                } catch {
                  setStorageError(
                    new Error(
                      "Could not remove the device draft. Keep this page open and retry.",
                    ),
                  );
                }
              }}
            >
              Discard changes
            </Button>
          </div>
        </Notice>
      ) : null}
      {showIssueSummary && visibleIssues.length ? (
        <Notice tone="warning">
          <p>
            {
              new Set(
                visibleIssues.map(
                  (i) =>
                    /^\/(?:questions|cards)\/(\d+)/.exec(i.path)?.[1] ??
                    "metadata",
                ),
              ).size
            }{" "}
            {new Set(
              visibleIssues.map(
                (i) =>
                  /^\/(?:questions|cards)\/(\d+)/.exec(i.path)?.[1] ??
                  "metadata",
              ),
            ).size === 1
              ? "item needs"
              : "items need"}{" "}
            attention.
          </p>
          <Button
            onClick={() => {
              const issue =
                visibleIssues[issueCursor.current++ % visibleIssues.length];
              focusIssue(issue);
            }}
          >
            Next issue
          </Button>
          <details>
            <summary>Show fields that need attention</summary>
            <ul>
              {visibleIssues.slice(0, 20).map((i, n) => (
                <li key={n}>
                  <Button variant="quiet" onClick={() => focusIssue(i)}>
                    {issueLabel(i)}
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        </Notice>
      ) : null}
      <ErrorNotice error={error} onIssue={focusIssue} />
      {(error || storageError) && dirty ? (
        <Button onClick={recoveryDownload}>Download draft recovery copy</Button>
      ) : null}
      <ErrorNotice error={storageError} />
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      <FieldIssues.Provider value={visibleIssues}>
        <fieldset
          className="editor-fieldset"
          disabled={busy || !!recovery}
          onBlurCapture={(event) => {
            const field =
              event.target.closest<HTMLElement>("[data-field-path]");
            if (!field) return;
            if (field.dataset.fieldPath)
              touched.current.add(field.dataset.fieldPath);
            checkFields();
          }}
        >
          <details
            className="set-details"
            open={metadataOpen}
            onToggle={(event) => setMetadataOpen(event.currentTarget.open)}
          >
            <summary>Set details</summary>
            <div className="metadata-fields">
              <Field
                path="/title"
                label="Title"
                hint={`${[...content.title].length} / 200 characters`}
              >
                <input
                  value={content.title}
                  onChange={(e) =>
                    setContent({ ...content, title: e.target.value })
                  }
                />
              </Field>
              <Field path="/description" label="Description (optional)">
                <NotationEditor
                  rows={2}
                  maxCharacters={2000}
                  value={content.description ?? ""}
                  onChange={(value) => optional("description", value)}
                />
              </Field>
            </div>
          </details>
          <div className="editor-layout">
            <aside className="item-rail">
              <h2>{content.kind === "exam" ? "Questions" : "Cards"}</h2>
              <div className="item-picker">
                <Field label="Selected item">
                  <Selector
                    value={String(index)}
                    disabled={busy || !!recovery}
                    onValueChange={(value) => setIndex(Number(value))}
                    options={[
                      ...(!listedItems.some((entry) => entry.index === index)
                        ? [
                            {
                              value: String(index),
                              label: `Item ${index + 1} · outside search results`,
                              disabled: true,
                            },
                          ]
                        : []),
                      ...listedItems.map(({ item, index: i }) => {
                        const needsAttention = visibleIssues.some((issue) =>
                          issue.path.startsWith(
                            `/${content.kind === "exam" ? "questions" : "cards"}/${i}/`,
                          ),
                        );
                        const label =
                          "prompt" in item
                            ? item.prompt.slice(0, 35) || "Untitled question"
                            : item.front.slice(0, 35) || "Untitled card";
                        return {
                          value: String(i),
                          label: `${i + 1}. ${needsAttention ? "Needs attention · " : ""}${label}`,
                        };
                      }),
                    ]}
                  />
                </Field>
                <Button
                  className="item-search-toggle"
                  aria-expanded={itemSearchOpen}
                  aria-controls={itemSearchId}
                  aria-label={
                    content.kind === "exam"
                      ? "Search questions"
                      : "Search cards"
                  }
                  onClick={() => {
                    if (itemSearchOpen) setItemSearch("");
                    else
                      requestAnimationFrame(() =>
                        itemSearchField.current?.focus(),
                      );
                    setItemSearchOpen(!itemSearchOpen);
                  }}
                >
                  <Search size={18} />
                </Button>
              </div>
              <div
                id={itemSearchId}
                className={`item-search${itemSearchOpen ? " is-open" : ""}`}
              >
                <Field
                  label={
                    content.kind === "exam" ? "Find a question" : "Find a card"
                  }
                >
                  <input
                    ref={itemSearchField}
                    type="search"
                    value={itemSearch}
                    maxLength={200}
                    onChange={(e) => setItemSearch(e.target.value)}
                  />
                </Field>
                {searchTerm ? (
                  <p className="muted" role="status">
                    {listedItems.length === 0
                      ? "No matching items."
                      : `${listedItems.length} of ${items.length} items match.`}
                  </p>
                ) : null}
              </div>
              <div className="item-rail-list">
                {listedItems.map(({ item, index: i }) => (
                  <button
                    className={`rail-item ${index === i ? "selected" : ""}`}
                    key={item.id}
                    aria-current={index === i ? "true" : undefined}
                    onClick={() => setIndex(i)}
                  >
                    <span className="mono">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>
                      {visibleIssues.some((issue) =>
                        issue.path.startsWith(
                          `/${content.kind === "exam" ? "questions" : "cards"}/${i}/`,
                        ),
                      )
                        ? "⚠ "
                        : ""}
                      {"prompt" in item
                        ? item.prompt.slice(0, 35) || "Untitled question"
                        : item.front.slice(0, 35) || "Untitled card"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="item-add-desktop">{addActions}</div>
            </aside>
            <div className="editor-tabs">
              <Tabs
                label="Editor mode"
                value={mode}
                onChange={setMode}
                tabs={[
                  { value: "edit", label: "Edit" },
                  { value: "preview", label: "Preview" },
                ]}
              />
            </div>
            <section
              id="editor-mode-edit"
              role="tabpanel"
              aria-label="Edit"
              className={`edit-column ${mode === "edit" ? "active" : ""}`}
            >
              <div className="item-toolbar">
                <span className="mono muted">
                  Item {index + 1} of {items.length}
                </span>
                <div className="actions">
                  <Button
                    aria-label="Move item up"
                    disabled={index === 0}
                    onClick={() => move(index - 1)}
                  >
                    <ArrowUp size={16} />
                  </Button>
                  <Button
                    aria-label="Move item down"
                    disabled={index >= items.length - 1}
                    onClick={() => move(index + 1)}
                  >
                    <ArrowDown size={16} />
                  </Button>
                  <Button
                    aria-label="Move item to position"
                    title="Move item to position"
                    disabled={items.length <= 1}
                    onClick={() => setMovePosition(String(index + 1))}
                  >
                    <ListOrdered size={16} />
                  </Button>
                  <Button
                    aria-label="Duplicate item"
                    title="Duplicate item"
                    disabled={items.length >= 500}
                    onClick={duplicateItem}
                  >
                    <Copy size={16} />
                  </Button>
                  <Button
                    variant="quiet"
                    aria-label="Remove item"
                    disabled={items.length <= 1}
                    onClick={remove}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </div>
              {item ? (
                <ItemFields
                  key={item.id}
                  path={`/${content.kind === "exam" ? "questions" : "cards"}/${index}`}
                  item={item}
                  disabled={busy || !!recovery}
                  onChange={updateItem}
                  onRemove={rememberRemoval}
                />
              ) : null}
            </section>
            <section
              id="editor-mode-preview"
              role="tabpanel"
              aria-label="Preview"
              className={`preview-column ${mode === "preview" ? "active" : ""}`}
            >
              <h2>Preview</h2>
              <ContentPreview content={content} selectedIndex={index} />
            </section>
          </div>
          <div className="item-add-mobile">{addActions}</div>
        </fieldset>
      </FieldIssues.Provider>
      {settingUp ? (
        <PracticeSetup
          set={settingUp}
          onClose={() => {
            setSettingUp(undefined);
            if (!initial.set) {
              allowedLeave.current = true;
              navigate(`/sets/${settingUp.id}/edit`, { replace: true });
            }
          }}
        />
      ) : null}
      {movePosition !== undefined ? (
        <Dialog
          title="Move item to position"
          onClose={() => setMovePosition(undefined)}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              move(Number(movePosition) - 1);
              setMovePosition(undefined);
            }}
          >
            <Field
              label="New position"
              hint={`Choose a position from 1 to ${items.length}.`}
            >
              <input
                type="number"
                min={1}
                max={items.length}
                step={1}
                required
                value={movePosition}
                onChange={(e) => setMovePosition(e.target.value)}
              />
            </Field>
            <div className="actions">
              <Button onClick={() => setMovePosition(undefined)}>Cancel</Button>
              <Button type="submit" variant="primary">
                Move item
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {blocker.state === "blocked" ? (
        <Dialog
          title="Leave with unsaved changes?"
          onClose={() => blocker.reset()}
        >
          <p>
            Your changes have not been saved to your account.{" "}
            {localStatus === "Saved"
              ? "A draft is saved on this device."
              : "Device draft persistence is not confirmed yet."}
          </p>
          <div className="actions">
            <Button variant="primary" onClick={() => blocker.reset()}>
              Keep editing
            </Button>
            <Button onClick={recoveryDownload}>
              Download draft recovery copy
            </Button>
            <Button onClick={() => blocker.proceed()}>Leave editor</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
function ItemFields({
  item,
  disabled,
  onChange,
  path,
  onRemove,
}: {
  path: string;
  item: Question | Card;
  disabled: boolean;
  onChange: (item: Question | Card) => void;
  onRemove: (removal: Removal) => void;
}) {
  if (!("type" in item))
    return (
      <div className="stack">
        <h2>Flashcard</h2>
        <Field path={`${path}/front`} label="Front">
          <NotationEditor
            value={item.front}
            onChange={(value) => onChange({ ...item, front: value })}
          />
        </Field>
        <Field path={`${path}/back`} label="Back">
          <NotationEditor
            value={item.back}
            onChange={(value) => onChange({ ...item, back: value })}
          />
        </Field>
        <details>
          <summary>Item details</summary>
          <p className="muted mono">Stable ID: {item.id}</p>
        </details>
      </div>
    );
  const q = item;
  const optionalExplanation = (value: string) => {
    const next = { ...q };
    if (value === "") delete next.explanation;
    else next.explanation = value;
    onChange(next);
  };
  return (
    <div className="stack">
      <h2>{q.type === "written" ? "Written answer" : "Single choice"}</h2>
      <Field
        path={`${path}/prompt`}
        label="Question"
        hint="Markdown and LaTeX are supported."
      >
        <NotationEditor
          value={q.prompt}
          onChange={(value) => onChange({ ...q, prompt: value })}
        />
      </Field>
      {q.type === "single_choice" ? (
        <>
          <h3>Answer options</h3>
          {q.options.map((o, i) => (
            <div className="option-editor" key={o.id}>
              <Field
                path={`${path}/options/${i}/text`}
                label={`Option ${String.fromCharCode(65 + i)}`}
              >
                <NotationEditor
                  value={o.text}
                  onChange={(value) =>
                    onChange({
                      ...q,
                      options: q.options.map((option, n) =>
                        i === n ? { ...option, text: value } : option,
                      ),
                    })
                  }
                />
              </Field>
              <div className="actions">
                <Button
                  aria-label={`Move option ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...q.options];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    onChange({ ...q, options: next });
                  }}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  aria-label={`Move option ${i + 1} down`}
                  disabled={i === q.options.length - 1}
                  onClick={() => {
                    const next = [...q.options];
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    onChange({ ...q, options: next });
                  }}
                >
                  <ArrowDown size={16} />
                </Button>
                <Button
                  variant="quiet"
                  aria-label={`Remove option ${i + 1}`}
                  disabled={q.options.length <= 2}
                  onClick={() => {
                    const options = q.options.filter((_, n) => n !== i);
                    onRemove({
                      kind: "option",
                      itemId: q.id,
                      option: o,
                      index: i,
                      wasAnswer: q.answer === o.id,
                    });
                    onChange({
                      ...q,
                      options,
                      answer: q.answer === o.id ? "" : q.answer,
                    });
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </div>
            </div>
          ))}
          <Button
            disabled={q.options.length >= 6}
            onClick={() =>
              onChange({
                ...q,
                options: [...q.options, { id: freshId(), text: "" }],
              })
            }
          >
            Add option
          </Button>
          <Field path={`${path}/answer`} label="Correct answer">
            <Selector
              value={q.answer}
              disabled={disabled}
              onValueChange={(value) => onChange({ ...q, answer: value })}
              placeholder="Select a correct answer"
              options={[
                { value: "", label: "Select a correct answer", disabled: true },
                ...q.options.map((option, i) => ({
                  value: option.id,
                  label: `Option ${String.fromCharCode(65 + i)}`,
                })),
              ]}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Answer type"
            hint="Choose the preferred keyboard for this written answer."
          >
            <Selector
              value={q.answerType ?? "simple"}
              disabled={disabled}
              onValueChange={(value) =>
                onChange({ ...q, answerType: value as AnswerType })
              }
              options={[
                { value: "simple", label: "Simple · text" },
                { value: "math", label: "Math · equations and symbols" },
                { value: "chem", label: "Chem · formulas and reactions" },
              ]}
            />
          </Field>
          <Field path={`${path}/answer`} label="Reference answer">
            <NotationEditor
              value={q.answer}
              answerType={q.answerType}
              onChange={(value) => onChange({ ...q, answer: value })}
            />
          </Field>
          {q.rubric ? (
            <RubricList
              criteria={q.rubric}
              path={`${path}/rubric`}
              mode="author"
              onRemove={(criterion, index) =>
                onRemove({ kind: "criterion", itemId: q.id, criterion, index })
              }
              onChange={(rubric) => {
                if (rubric.length) onChange({ ...q, rubric });
                else {
                  const next = { ...q };
                  delete next.rubric;
                  onChange(next);
                }
              }}
            />
          ) : (
            <Button
              onClick={() =>
                onChange({
                  ...q,
                  rubric: [{ id: freshId(), description: "", points: 1 }],
                })
              }
            >
              Add marking rubric
            </Button>
          )}
        </>
      )}
      <Field path={`${path}/explanation`} label="Explanation (optional)">
        <NotationEditor
          value={q.explanation ?? ""}
          onChange={optionalExplanation}
        />
      </Field>
      <details>
        <summary>Item details</summary>
        <p className="muted mono">Stable ID: {q.id}</p>
      </details>
    </div>
  );
}
