import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { ArrowUp, ArrowDown, Plus, Trash2, Download } from "lucide-react";
import {
  emptyContent,
  freshId,
  itemsOf,
  validateContent,
  type StudyContent,
  type Question,
  type Card,
  type AnswerType,
} from "../../shared/content";
import { api, ApiError, exportContent, type StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { getDraft, putDraft, removeDraft, type Draft } from "../lib/drafts";
import { useUnsaved } from "../lib/hooks";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  LoadingRows,
  Notice,
  PageHeader,
  SaveStatus,
  Tabs,
} from "../components/ui";
import { ContentPreview } from "./Authoring";
import { RubricList } from "../components/RubricList";
import { NotationEditor } from "../components/NotationEditor";

type Loaded = { set?: StudySet; draft?: Draft; missing: boolean };
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
  const [mode, setMode] = useState("edit");
  const [localStatus, setLocalStatus] = useState("No local changes");
  const [databaseStatus, setDatabaseStatus] = useState(
    initial.set ? "Saved" : "Not saved to account",
  );
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState<Error>();
  const [announce, setAnnounce] = useState("");
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
          setLocalStatus("Saved");
          setStorageError(undefined);
        })
        .catch(() => {
          setLocalStatus("Could not save");
          setStorageError(
            new Error(
              "Device storage is unavailable. Keep this page open and save to your account or export your content.",
            ),
          );
        });
    }, 300);
    return () => clearTimeout(timeout);
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
  async function save(asNew = false) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    setDatabaseStatus("Saving…");
    const captured = structuredClone(current.current);
    try {
      const valid = validateContent(captured);
      const set = await api<StudySet>(
        asNew || !setId ? "/sets" : `/sets/${setId}`,
        asNew || !setId ? "POST" : "PUT",
        asNew || !setId ? valid : { revision, content: valid },
      );
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
      if (!initial.set || asNew) {
        allowedLeave.current = true;
        navigate(`/sets/${set.id}/edit`, { replace: true });
      }
    } catch (e) {
      setDatabaseStatus("Could not save");
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
    setAnnounce("Item added.");
  }
  function move(delta: number) {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setContent(
      content.kind === "exam"
        ? { ...content, questions: next as Question[] }
        : { ...content, cards: next as Card[] },
    );
    setIndex(index + delta);
    setAnnounce(`Item moved to position ${index + delta + 1}.`);
  }
  function remove() {
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
              variant="primary"
              busy={busy}
              disabled={!!recovery || conflict}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        }
      />
      <div className="save-channels">
        <SaveStatus state={localStatus} local />
        <SaveStatus
          state={
            dirty && databaseStatus === "Saved"
              ? "Unsaved account changes"
              : databaseStatus
          }
        />
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
                await removeDraft(user!.id, draftKey);
                allowedLeave.current = true;
                window.location.assign(setId ? `/sets/${setId}/edit` : "/");
              }}
            >
              Discard changes
            </Button>
          </div>
        </Notice>
      ) : null}
      <ErrorNotice error={error} />
      <ErrorNotice error={storageError} />
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      <fieldset className="editor-fieldset" disabled={busy || !!recovery}>
        <div className="metadata-fields">
          <Field label="Title">
            <input
              value={content.title}
              onChange={(e) =>
                setContent({ ...content, title: e.target.value })
              }
            />
          </Field>
          <Field label="Description (optional)">
            <NotationEditor
              rows={2}
              value={content.description ?? ""}
              onChange={(value) => optional("description", value)}
            />
          </Field>
        </div>
        <div className="editor-layout">
          <aside className="item-rail">
            <h2>{content.kind === "exam" ? "Questions" : "Cards"}</h2>
            <div className="item-picker">
              <Field label="Selected item">
                <select
                  value={index}
                  onChange={(e) => setIndex(Number(e.target.value))}
                >
                  {items.map((item, i) => (
                    <option key={item.id} value={i}>
                      {i + 1}.{" "}
                      {"prompt" in item
                        ? item.prompt.slice(0, 35) || "Untitled question"
                        : item.front.slice(0, 35) || "Untitled card"}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="item-rail-list">
              {items.map((item, i) => (
                <button
                  className={`rail-item ${index === i ? "selected" : ""}`}
                  key={item.id}
                  onClick={() => setIndex(i)}
                >
                  <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    {"prompt" in item
                      ? item.prompt.slice(0, 35) || "Untitled question"
                      : item.front.slice(0, 35) || "Untitled card"}
                  </span>
                </button>
              ))}
            </div>
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
                  <Button
                    disabled={items.length >= 500}
                    onClick={() => add("written")}
                  >
                    <Plus size={16} />
                    Written answer
                  </Button>
                </>
              ) : (
                <Button
                  disabled={items.length >= 500}
                  onClick={() => add("card")}
                >
                  <Plus size={16} />
                  Add card
                </Button>
              )}
            </div>
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
                  onClick={() => move(-1)}
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  aria-label="Move item down"
                  disabled={index >= items.length - 1}
                  onClick={() => move(1)}
                >
                  <ArrowDown size={16} />
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
              <ItemFields key={item.id} item={item} onChange={updateItem} />
            ) : null}
          </section>
          <section
            id="editor-mode-preview"
            role="tabpanel"
            aria-label="Preview"
            className={`preview-column ${mode === "preview" ? "active" : ""}`}
          >
            <h2>Preview</h2>
            <ContentPreview
              content={
                content.kind === "exam"
                  ? { ...content, questions: item ? [item as Question] : [] }
                  : { ...content, cards: item ? [item as Card] : [] }
              }
            />
          </section>
        </div>
      </fieldset>
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
            <Button onClick={() => blocker.proceed()}>Leave editor</Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
function ItemFields({
  item,
  onChange,
}: {
  item: Question | Card;
  onChange: (item: Question | Card) => void;
}) {
  if (!("type" in item))
    return (
      <div className="stack">
        <h2>Flashcard</h2>
        <Field label="Front">
          <NotationEditor
            value={item.front}
            onChange={(value) => onChange({ ...item, front: value })}
          />
        </Field>
        <Field label="Back">
          <NotationEditor
            value={item.back}
            onChange={(value) => onChange({ ...item, back: value })}
          />
        </Field>
        <p className="muted mono">Stable ID: {item.id}</p>
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
      <Field label="Question" hint="Markdown and LaTeX are supported.">
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
              <Field label={`Option ${String.fromCharCode(65 + i)}`}>
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
                    onChange({
                      ...q,
                      options,
                      answer: q.answer === o.id ? options[0].id : q.answer,
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
          <Field label="Correct answer">
            <select
              value={q.answer}
              onChange={(e) => onChange({ ...q, answer: e.target.value })}
            >
              {q.options.map((o, i) => (
                <option key={o.id} value={o.id}>
                  Option {String.fromCharCode(65 + i)}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Answer type"
            hint="Choose the preferred keyboard for this written answer."
          >
            <select
              value={q.answerType ?? "simple"}
              onChange={(event) =>
                onChange({ ...q, answerType: event.target.value as AnswerType })
              }
            >
              <option value="simple">Simple · text</option>
              <option value="math">Math · equations and symbols</option>
              <option value="chem">Chem · formulas and reactions</option>
            </select>
          </Field>
          <Field label="Reference answer">
            <NotationEditor
              value={q.answer}
              answerType={q.answerType}
              onChange={(value) => onChange({ ...q, answer: value })}
            />
          </Field>
          {q.rubric ? (
            <RubricList
              criteria={q.rubric}
              mode="author"
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
      <Field label="Explanation (optional)">
        <NotationEditor
          value={q.explanation ?? ""}
          onChange={optionalExplanation}
        />
      </Field>
      <p className="muted mono">Stable ID: {q.id}</p>
    </div>
  );
}
