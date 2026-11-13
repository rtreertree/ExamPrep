import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { SharedSetPreview } from "../../shared/sharing";
import { Button, ErrorNotice, LoadingRows, PageHeader } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import "./sharing.css";

export default function SharedSetPage() {
  const { hash } = useLocation();
  const { user } = useAuth();
  const token = hash.slice(1);
  return (
    <SharedSet
      key={JSON.stringify([user?.id, token])}
      token={token}
      userId={user!.id}
    />
  );
}

function pendingImport(key: string, value?: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else if (value) sessionStorage.setItem(key, value);
    else return sessionStorage.getItem(key) ?? undefined;
  } catch {
    // The current page can still retry when device storage is unavailable.
  }
}

function SharedSet({ token, userId }: { token: string; userId: string }) {
  const navigate = useNavigate();
  const [preview, setPreview] = useState<SharedSetPreview>();
  const [previewError, setPreviewError] = useState<Error>();
  const [previewVersion, setPreviewVersion] = useState(0);
  const [importError, setImportError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const importKey = `examprep:share-import:${userId}:${token.split(".")[0]}`;
  const [requestId, setRequestId] = useState(() => pendingImport(importKey));

  useEffect(() => {
    let active = true;
    setPreviewError(undefined);
    api<SharedSetPreview>("/shares/preview", "POST", { token }).then(
      (value) => {
        if (active) setPreview(value);
      },
      (error: Error) => {
        if (active) setPreviewError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [token, previewVersion]);

  async function addCopy() {
    const idempotencyKey = requestId ?? crypto.randomUUID();
    setRequestId(idempotencyKey);
    pendingImport(importKey, idempotencyKey);
    setBusy(true);
    setImportError(undefined);
    try {
      const { id } = await api<{ id: string }>("/shares/import", "POST", {
        token,
        requestId: idempotencyKey,
      });
      pendingImport(importKey, null);
      navigate(`/sets/${id}/edit`, { replace: true });
    } catch (error) {
      setImportError(error as Error);
      if (error instanceof ApiError && error.status === 404) {
        pendingImport(importKey, null);
        setRequestId(undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  const itemName = preview?.kind === "exam" ? "question" : "card";
  return (
    <div className="stack">
      <PageHeader title={preview?.title ?? "Shared study set"} />
      <ErrorNotice
        error={previewError}
        retry={() => setPreviewVersion((version) => version + 1)}
      />
      <ErrorNotice error={importError} />
      {preview ? (
        <section
          className="shared-set-details stack"
          aria-label="Shared set details"
        >
          <p>
            {preview.kind === "exam" ? "Exam" : "Flashcards"} · {preview.count}{" "}
            {itemName}
            {preview.count === 1 ? "" : "s"}
          </p>
          <p className="muted">Add an independent copy to your library.</p>
          <div className="actions">
            <Button
              variant="primary"
              busy={busy}
              onClick={() => void addCopy()}
            >
              Add to my library
            </Button>
            <Link to="/" className="button secondary">
              Back to library
            </Link>
          </div>
        </section>
      ) : previewError ? (
        <div className="actions">
          {requestId ? (
            <Button busy={busy} onClick={() => void addCopy()}>
              Retry adding to my library
            </Button>
          ) : null}
          <Link to="/">Back to library</Link>
        </div>
      ) : (
        <LoadingRows label="Loading shared study set" />
      )}
    </div>
  );
}
