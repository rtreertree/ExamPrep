import { useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import type { StudyContent as Content } from "../../shared/content";
import { decodeFile, MAX_BYTES, ValidationError } from "../../shared/json";
import { ImportCopyButton } from "../components/ImportCopyButton";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  Notice,
  Tabs,
} from "../components/ui";
import { checkAIImport, hasCompleteAISetup } from "../lib/aiImport";
import {
  buildAIAnswerReviewPrompt,
  buildAIRepairPrompt,
} from "../lib/aiPrompt";
import type { AISettings } from "../lib/aiSettings";
import type { StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { saveStudySet } from "../lib/setSave";
import { ExistingSet, type SetMatch } from "./ExistingSet";
import { useUnsaved } from "../lib/hooks";
import { unwrapPastedJSON } from "../lib/importSource";
import { issueLabel, issuesOf, repairInstructions } from "../lib/issues";

export function ImportPanel({
  aiSettings,
  onClose,
  onSaved,
}: {
  aiSettings?: AISettings;
  onClose: () => void;
  onSaved: (set: StudySet) => void;
}) {
  const { user } = useAuth();
  const [match, setMatch] = useState<SetMatch>();
  const [mode, setMode] = useState(aiSettings ? "paste" : "file");
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [validated, setValidated] = useState<{
    content: Content;
    Preview: typeof import("./ImportPreview").ContentPreview;
  }>();
  const preview = validated?.content;
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
  useUnsaved(!!raw && !match);
  function close() {
    if (busy) return;
    if (raw && !match) setConfirmClose(true);
    else onClose();
  }
  async function validate(source: string, read: number, pasted = false) {
    setRaw(source);
    setSaveError(undefined);
    try {
      const { parseContent, ContentPreview } = await import("./ImportPreview");
      if (read !== fileRead.current) return;
      const content = parseContent(pasted ? unwrapPastedJSON(source) : source);
      setValidated({ content, Preview: ContentPreview });
      setError(undefined);
    } catch (e) {
      if (read !== fileRead.current) return;
      setValidated(undefined);
      setError(e as Error);
    }
  }
  async function file(file?: File) {
    if (!file || busy) return;
    const read = ++fileRead.current;
    setFileName(file.name);
    setReadingFile(true);
    setValidated(undefined);
    setError(undefined);
    setSaveError(undefined);
    try {
      if (file.size > MAX_BYTES) throw new Error("File exceeds 2 MiB.");
      const bytes = await file.arrayBuffer();
      if (read === fileRead.current) await validate(decodeFile(bytes), read);
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
    setValidated(undefined);
    setError(undefined);
    setSaveError(undefined);
  }
  async function save() {
    if (!user || !preview || readingFile || busy || blockers.length) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const { set, reused } = await saveStudySet(user.id, preview);
      if (reused) setMatch({ set, content: preview });
      else onSaved(set);
    } catch (e) {
      setSaveError(e as Error);
    } finally {
      setBusy(false);
    }
  }
  if (match)
    return (
      <Dialog title="Study set already saved" onClose={close}>
        <ExistingSet match={match} onCopy={onSaved} />
      </Dialog>
    );
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
              onClick={() => void validate(raw, ++fileRead.current, true)}
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
      {preview && validated ? (
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
          <validated.Preview content={preview} />
        </>
      ) : null}
    </Dialog>
  );
}
