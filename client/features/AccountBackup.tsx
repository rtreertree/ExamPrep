import { useRef, useState } from "react";
import type { BackupSummary } from "../../shared/backup";
import { BACKUP_BYTES, decodeFile, parseJSON } from "../../shared/json";
import { Button, ErrorNotice, Field, Notice } from "../components/ui";
import { api, download } from "../lib/api";

type BackupFiles = { library: unknown; history?: unknown };

export function AccountBackup() {
  const [includeHistory, setIncludeHistory] = useState(false);
  const [historyDownload, setHistoryDownload] = useState<{
    name: string;
    data: string;
  }>();
  const [libraryFile, setLibraryFile] = useState<File>();
  const [historyFile, setHistoryFile] = useState<File>();
  const [preview, setPreview] = useState<{
    files: BackupFiles;
    summary: BackupSummary;
  }>();
  const [restored, setRestored] = useState<Omit<BackupSummary, "titles">>();
  const [busy, setBusy] = useState<"download" | "preview" | "restore">();
  const [error, setError] = useState<Error>();
  const libraryInput = useRef<HTMLInputElement>(null);
  const historyInput = useRef<HTMLInputElement>(null);

  async function exportFiles() {
    setBusy("download");
    setError(undefined);
    setHistoryDownload(undefined);
    try {
      const files = await api<BackupFiles>(
        `/backup?history=${includeHistory ? 1 : 0}`,
      );
      const date = new Date().toISOString().slice(0, 10);
      download(JSON.stringify(files.library), `exam-prep-library-${date}.json`);
      if (files.history)
        setHistoryDownload({
          name: `exam-prep-history-${date}.json`,
          data: JSON.stringify(files.history),
        });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(undefined);
    }
  }

  async function previewFiles() {
    if (!libraryFile) return;
    setBusy("preview");
    setError(undefined);
    setRestored(undefined);
    setPreview(undefined);
    try {
      if (libraryFile.size + (historyFile?.size ?? 0) > BACKUP_BYTES)
        throw new Error("Choose files that total at most 16 MiB.");
      const read = async (file: File) =>
        parseJSON(
          decodeFile(await file.arrayBuffer(), BACKUP_BYTES),
          BACKUP_BYTES,
        );
      const [library, history] = await Promise.all([
        read(libraryFile),
        historyFile ? read(historyFile) : undefined,
      ]);
      const files = { library, ...(history !== undefined ? { history } : {}) };
      const summary = await api<BackupSummary>(
        "/backup/preview",
        "POST",
        files,
      );
      setPreview({ files, summary });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(undefined);
    }
  }

  async function restore() {
    if (!preview) return;
    setBusy("restore");
    setError(undefined);
    try {
      const counts = await api<Omit<BackupSummary, "titles">>(
        "/backup/restore",
        "POST",
        preview.files,
      );
      setRestored(counts);
      setPreview(undefined);
      setLibraryFile(undefined);
      setHistoryFile(undefined);
      if (libraryInput.current) libraryInput.current.value = "";
      if (historyInput.current) historyInput.current.value = "";
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(undefined);
    }
  }

  function clearPreview() {
    setPreview(undefined);
    setRestored(undefined);
    setError(undefined);
  }

  return (
    <section className="stack">
      <h2>Library backup</h2>
      <p className="muted">
        Download your entire library, including archived sets and course labels.
        The optional history file includes answers, scores, private notes, and
        review schedules.
      </p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={includeHistory}
          disabled={Boolean(busy)}
          onChange={(event) => {
            setIncludeHistory(event.target.checked);
            setHistoryDownload(undefined);
          }}
        />
        Prepare a separate practice history file
      </label>
      <div className="actions">
        <Button
          onClick={exportFiles}
          disabled={Boolean(busy)}
          busy={busy === "download"}
        >
          Download library backup
        </Button>
        {historyDownload ? (
          <Button
            disabled={Boolean(busy)}
            onClick={() => download(historyDownload.data, historyDownload.name)}
          >
            Download practice history
          </Button>
        ) : null}
      </div>
      <h3>Restore a backup</h3>
      <p className="muted">
        Choose a library file and its matching history file if you have one.
        Restoring adds copies and skips entries already restored from these
        files. The files can total up to 16 MiB.
      </p>
      <Field label="Library backup file">
        <input
          ref={libraryInput}
          type="file"
          accept=".json,application/json"
          disabled={Boolean(busy)}
          onChange={(event) => {
            setLibraryFile(event.target.files?.[0]);
            clearPreview();
          }}
        />
      </Field>
      <Field label="Practice history file (optional)">
        <input
          ref={historyInput}
          type="file"
          accept=".json,application/json"
          disabled={Boolean(busy)}
          onChange={(event) => {
            setHistoryFile(event.target.files?.[0]);
            clearPreview();
          }}
        />
      </Field>
      <div className="actions">
        <Button
          onClick={previewFiles}
          disabled={!libraryFile || Boolean(busy)}
          busy={busy === "preview"}
        >
          Preview restore
        </Button>
      </div>
      <ErrorNotice error={error} />
      {preview ? (
        <div className="stack">
          <Notice>{countsText(preview.summary)} ready to restore.</Notice>
          {preview.summary.titles.length ? (
            <ul>
              {preview.summary.titles.map((title, i) => (
                <li key={i}>{title}</li>
              ))}
            </ul>
          ) : null}
          <div className="actions">
            <Button
              variant="primary"
              onClick={restore}
              disabled={
                Boolean(busy) ||
                preview.summary.setCount +
                  preview.summary.attemptCount +
                  preview.summary.reviewCount ===
                  0
              }
              busy={busy === "restore"}
            >
              Restore backup
            </Button>
          </div>
        </div>
      ) : null}
      {restored ? (
        <Notice tone="success">Restored {countsText(restored)}.</Notice>
      ) : null}
    </section>
  );
}

function countsText({
  setCount,
  attemptCount,
  reviewCount,
}: Omit<BackupSummary, "titles">) {
  return `${setCount} study ${setCount === 1 ? "set" : "sets"}, ${attemptCount} ${attemptCount === 1 ? "attempt" : "attempts"}, and ${reviewCount} scheduled ${reviewCount === 1 ? "card" : "cards"}`;
}
