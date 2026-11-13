import { Selector } from "../components/Selector";
import { useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
  parseContent,
  itemsOf,
  type StudyContent as Content,
} from "../../shared/content";
import { useAuth } from "../lib/auth";
import { useUnsaved } from "../lib/hooks";
import {
  readAISettings,
  aiSettingsKey,
  defaultAISettings,
  type AISettings,
} from "../lib/aiSettings";
import { checkAIImport, hasCompleteAISetup } from "../lib/aiImport";
import {
  buildAIAnswerReviewPrompt,
  buildAIRepairPrompt,
} from "../lib/aiPrompt";
import { issueLabel, issuesOf, repairInstructions } from "../lib/issues";
import { unwrapPastedJSON } from "../lib/importSource";
import { decodeFile, MAX_BYTES, ValidationError } from "../../shared/json";
import { api, type StudySet } from "../lib/api";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  Notice,
  Tabs,
} from "../components/ui";
import { StudyContent } from "../components/StudyContent";
import { RubricList } from "../components/RubricList";
import { ImportCopyButton } from "../components/ImportCopyButton";
import {
  AIAuthoringDownloads,
  AIPromptGenerator,
} from "../components/AIPromptGenerator";
export function ContentPreview({
  content,
  selectedIndex,
}: {
  content: Content;
  selectedIndex?: number;
}) {
  const [index, setIndex] = useState(0);
  const items = itemsOf(content);
  const selected = Math.min(
    selectedIndex ?? index,
    Math.max(0, items.length - 1),
  );
  const item = items[selected];
  return (
    <div className="content-preview">
      <h3>{content.title}</h3>
      <p className="muted">
        {content.kind === "exam" ? "Exam" : "Flashcards"} · {items.length}{" "}
        {content.kind === "exam"
          ? items.length === 1
            ? "question"
            : "questions"
          : items.length === 1
            ? "card"
            : "cards"}
      </p>
      <StudyContent source={content.description} label="description" />
      {selectedIndex === undefined && items.length > 1 ? (
        <Field label="Preview item">
          <Selector
            value={String(selected)}
            onValueChange={(value) => setIndex(Number(value))}
            options={items.map((_, i) => ({
              value: String(i),
              label: `Item ${i + 1}`,
            }))}
          />
        </Field>
      ) : null}
      {item ? (
        <section key={item.id}>
          <span className="mono muted">
            {selectedIndex === undefined
              ? "Item"
              : `Preview of ${content.kind === "exam" ? "question" : "card"}`}{" "}
            {selected + 1} of {items.length}
          </span>
          {"type" in item ? (
            <>
              <StudyContent
                source={item.prompt}
                label={`question ${selected + 1}`}
              />
              {item.type === "single_choice"
                ? item.options.map((o, j) => (
                    <div className="preview-option" key={o.id}>
                      <span className="mono">
                        {String.fromCharCode(65 + j)}
                      </span>
                      <StudyContent source={o.text} label={`option ${j + 1}`} />
                    </div>
                  ))
                : null}
              <details>
                <summary>Show solution and explanation</summary>
                {item.type === "single_choice" ? (
                  <p>
                    Correct option:{" "}
                    {item.options.some((o) => o.id === item.answer)
                      ? String.fromCharCode(
                          65 +
                            item.options.findIndex((o) => o.id === item.answer),
                        )
                      : "Select a correct answer in the editor"}
                  </p>
                ) : (
                  <>
                    <h4>Reference answer</h4>
                    <StudyContent
                      source={item.answer}
                      label="reference answer"
                    />
                    {item.rubric ? (
                      <RubricList criteria={item.rubric} mode="review" />
                    ) : null}
                  </>
                )}
                <StudyContent source={item.explanation} label="explanation" />
              </details>
            </>
          ) : (
            <>
              <StudyContent source={item.front} label="card front" />
              <details>
                <summary>Show back</summary>
                <StudyContent source={item.back} label="card back" />
              </details>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
export function ImportPanel({
  aiSettings,
  onClose,
  onSaved,
}: {
  aiSettings?: AISettings;
  onClose: () => void;
  onSaved: (set: StudySet) => void;
}) {
  const [mode, setMode] = useState(aiSettings ? "paste" : "file");
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Content>();
  const [error, setError] = useState<Error>();
  const [saveError, setSaveError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const fileRead = useRef(0);
  const originalSource = useRef<HTMLDetailsElement>(null);
  const findings = useMemo(
    () =>
      preview && aiSettings ? checkAIImport(preview, aiSettings) : undefined,
    [preview, aiSettings],
  );
  const completeSetup = aiSettings && hasCompleteAISetup(aiSettings);
  const blockers = findings?.errors ?? [];
  const warnings = findings?.warnings ?? [];
  const validationError =
    error ?? (blockers.length ? new ValidationError(blockers) : undefined);
  const validationIssues = issuesOf(
    aiSettings ? validationError : (validationError ?? saveError),
  );
  const feedback =
    aiSettings && (validationError || warnings.length)
      ? buildAIRepairPrompt(
          validationIssues.length
            ? validationIssues
            : validationError
              ? [{ path: "/", message: validationError.message }]
              : [],
          warnings,
          completeSetup ? aiSettings : undefined,
        )
      : undefined;
  useUnsaved(!!raw);
  function close() {
    if (busy) return;
    if (raw) setConfirmClose(true);
    else onClose();
  }
  function validate(source: string, pasted = false) {
    setRaw(source);
    setSaveError(undefined);
    try {
      setPreview(parseContent(pasted ? unwrapPastedJSON(source) : source));
      setError(undefined);
    } catch (e) {
      setPreview(undefined);
      setError(e as Error);
    }
  }
  async function file(file?: File) {
    if (!file || busy) return;
    const read = ++fileRead.current;
    setFileName(file.name);
    setReadingFile(true);
    setPreview(undefined);
    setError(undefined);
    setSaveError(undefined);
    try {
      if (file.size > MAX_BYTES) throw new Error("File exceeds 2 MiB.");
      const bytes = await file.arrayBuffer();
      if (read === fileRead.current) validate(decodeFile(bytes));
    } catch (e) {
      if (read === fileRead.current) setError(e as Error);
    } finally {
      if (read === fileRead.current) setReadingFile(false);
    }
  }
  function editPaste(source: string) {
    fileRead.current++;
    setReadingFile(false);
    setFileName("");
    setRaw(source);
    setPreview(undefined);
    setError(undefined);
    setSaveError(undefined);
  }
  async function save() {
    if (!preview || readingFile || busy || blockers.length) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const set = await api<StudySet>("/sets", "POST", preview);
      onSaved(set);
    } catch (e) {
      setSaveError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  if (confirmClose)
    return (
      <Dialog
        title="Discard your import draft?"
        onClose={() => setConfirmClose(false)}
      >
        <p>
          Your imported or pasted content has not been saved. Keep editing to
          preserve it, or discard it and close Import.
        </p>
        <div className="actions">
          <Button variant="primary" onClick={() => setConfirmClose(false)}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={onClose}>
            Discard draft
          </Button>
        </div>
      </Dialog>
    );
  return (
    <Dialog title="Import a study set" onClose={close}>
      <p className="muted">
        {aiSettings
          ? "Paste or upload the result from your AI tool to check it before saving."
          : "Bring a file from your AI tool, or one you wrote yourself."}
      </p>
      <Tabs
        label="Import method"
        value={mode}
        onChange={setMode}
        tabs={[
          { value: "file", label: "Choose file" },
          { value: "paste", label: "Paste JSON" },
        ]}
      />
      <section
        role="tabpanel"
        id={`import-method-${mode}`}
        aria-label={mode === "file" ? "Choose file" : "Paste JSON"}
      >
        {mode === "file" ? (
          <div
            className={`upload-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void file(e.dataTransfer.files[0]);
            }}
          >
            <Upload size={28} />
            <p>Drop your .examprep.json file here</p>
            <Field label="Choose a JSON file">
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(e) => {
                  const selected = e.target.files?.[0];
                  if (aiSettings) e.target.value = "";
                  void file(selected);
                }}
              />
            </Field>
            {aiSettings && fileName ? (
              <p className="muted">{fileName}</p>
            ) : null}
            <small>UTF-8 · Up to 2 MiB · 500 items</small>
          </div>
        ) : (
          <div className="stack">
            <Field
              label="Study-set JSON"
              hint="Paste raw JSON or the JSON code block from your AI chat."
            >
              <textarea
                className="json-input"
                spellCheck={false}
                value={raw}
                disabled={busy}
                onChange={(e) => editPaste(e.target.value)}
              />
            </Field>
            <Button
              disabled={busy || readingFile}
              onClick={() => validate(raw, true)}
            >
              Validate and preview
            </Button>
          </div>
        )}
      </section>
      {readingFile ? <p role="status">Checking file…</p> : null}
      <ErrorNotice error={validationError} />
      <ErrorNotice error={saveError} />
      {warnings.length ? (
        <Notice tone="warning">
          <p>Possible repetitions to review</p>
          <ul>
            {warnings.map((issue) => (
              <li key={issue.path}>{issueLabel(issue)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {feedback ? (
        <div className="import-review">
          <p className="muted">
            Send this feedback to the AI chat that generated the result. Bring
            the corrected file back to check it again.
          </p>
          <ImportCopyButton
            label="Copy feedback for AI"
            text={feedback}
            fallbackLabel="Feedback for AI"
            copiedLabel="Feedback copied"
            onCopyFailure={() => {
              if (originalSource.current) originalSource.current.open = true;
            }}
          />
        </div>
      ) : !aiSettings && validationIssues.length ? (
        <ImportCopyButton
          label="Copy repair instructions"
          text={repairInstructions(validationIssues)}
          fallbackLabel="Repair instructions"
          copiedLabel="Repair instructions copied"
        />
      ) : null}
      {raw && mode === "file" && (!preview || feedback) ? (
        <details ref={originalSource}>
          <summary>View original source</summary>
          <textarea
            readOnly
            aria-label="Original imported source"
            value={raw}
          />
        </details>
      ) : null}
      {preview ? (
        <>
          {!aiSettings ? (
            <Notice tone="success">
              Study set validated. Review the content below before saving.
            </Notice>
          ) : (
            <div className="import-review">
              <p className="muted">
                {blockers.length
                  ? "Correct the errors before saving."
                  : completeSetup
                    ? "File and quiz settings checks passed."
                    : "File checks passed. Add a topic and valid item count in the AI helper to check quiz settings on a future import."}{" "}
                Review the answers for accuracy. For a second opinion, paste the
                review prompt into a fresh AI chat with your study set and
                source notes.
              </p>
              <ImportCopyButton
                label="Copy answer review prompt"
                text={buildAIAnswerReviewPrompt(preview.kind)}
                fallbackLabel="Answer review prompt"
                copiedLabel="Answer review prompt copied"
              />
            </div>
          )}
          <div className="dialog-footer actions import-save-actions">
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={blockers.length > 0 || readingFile}
              onClick={save}
            >
              Save to library
            </Button>
          </div>
          <ContentPreview content={preview} />
        </>
      ) : null}
    </Dialog>
  );
}
export function AIHandoffPanel({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (settings: AISettings) => void;
}) {
  const { user } = useAuth();
  const userId = user!.id;
  const [initial] = useState(() => {
    try {
      return { value: readAISettings(userId), failed: false };
    } catch {
      return { value: undefined, failed: true };
    }
  });
  const [settings, setSettings] = useState(initial.value ?? defaultAISettings);
  const [storageFailed, setStorageFailed] = useState(initial.failed);
  const serializedSettings = JSON.stringify(settings);
  const lastSaved = useRef(serializedSettings);
  const unsaved = storageFailed && serializedSettings !== lastSaved.current;
  const [leaving, setLeaving] = useState<"close" | "import">();
  const keepEditing = useRef<HTMLButtonElement>(null);
  useUnsaved(unsaved);
  useEffect(() => {
    if (leaving && unsaved) keepEditing.current?.focus();
  }, [leaving, unsaved]);
  useEffect(() => {
    try {
      localStorage.setItem(aiSettingsKey(userId), serializedSettings);
      lastSaved.current = serializedSettings;
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
  }, [userId, serializedSettings]);
  function leave(destination: "close" | "import") {
    if (unsaved) setLeaving(destination);
    else if (destination === "close") onClose();
    else onImport(settings);
  }
  return (
    <Dialog title="Create with your AI" onClose={() => leave("close")}>
      <p className="muted">
        Choose what to study, copy the prompt into your AI tool, then import its
        result here.
      </p>
      {storageFailed ? (
        <Notice tone="warning">
          Device storage is unavailable. Copy your prompt before leaving to keep
          your work.
        </Notice>
      ) : null}
      <AIPromptGenerator settings={settings} onChange={setSettings} />
      <div className="stack ai-handoff-import">
        <div>
          <h3>Bring back your result</h3>
          <p className="muted">
            Paste the JSON or upload the file to preview your study set.
          </p>
        </div>
        <Button onClick={() => leave("import")}>Import AI result</Button>
      </div>
      {leaving && unsaved ? (
        <Notice tone="warning">
          <p>
            Your changes have not been saved on this device. Copy the prompt
            before leaving, or return to keep working.
          </p>
          <div className="actions">
            <Button ref={keepEditing} onClick={() => setLeaving(undefined)}>
              Keep editing
            </Button>
            <Button
              onClick={() =>
                leaving === "close" ? onClose() : onImport(settings)
              }
            >
              Leave without saving changes
            </Button>
          </div>
        </Notice>
      ) : null}
      <AIAuthoringDownloads />
      {!storageFailed ? (
        <p className="muted ai-draft-note">
          Notes and settings are saved on this device until you sign out.
        </p>
      ) : null}
    </Dialog>
  );
}
