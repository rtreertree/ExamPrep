import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Upload, Plus, ArrowRight, Ellipsis } from "lucide-react";
import { useResource } from "../lib/hooks";
import { api, exportContent, type StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { accountDrafts, type Draft } from "../lib/drafts";
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
export function LibraryPage() {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [saved, setSaved] = useState<StudySet>();
  const [sample, setSample] = useState(false);
  const resource = useResource<{ items: StudySet[]; hasMore: boolean }>(
    `/sets?page=${page}${filter !== "all" ? `&kind=${filter}` : ""}&search=${encodeURIComponent(search)}`,
  );
  const [panel, setPanel] = useState<"import" | "ai" | null>(null);
  const [deleting, setDeleting] = useState<StudySet>();
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
  async function practice(set: StudySet) {
    setBusy(true);
    setError(undefined);
    try {
      const attempt = await api<{ id: string }>(
        `/sets/${set.id}/attempts`,
        "POST",
        {},
      );
      navigate(`/practice/${attempt.id}`);
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
              onClick={() => void practice(saved)}
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
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      </Field>
      <Tabs
        label="Study set type"
        value={filter}
        onChange={(v) => {
          setFilter(v);
          setPage(0);
        }}
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
        {resource.loading ? (
          <LoadingRows />
        ) : resource.data?.items.length ? (
          <div className="set-list">
            {resource.data.items.map((set, i) => (
              <SurfaceLight className="set-row" key={set.id}>
                <span className="ordinal">
                  {String(page * 30 + i + 1).padStart(2, "0")}
                </span>
                <Link
                  className="set-title"
                  aria-description="Edit this study set"
                  to={`/sets/${set.id}/edit`}
                >
                  {set.title}
                </Link>
                <span className="set-meta">
                  {set.kind === "exam"
                    ? `Exam · ${set.count} questions`
                    : `Flashcards · ${set.count} cards`}
                </span>
                <div className="row-actions">
                  {set.continuation ? (
                    <Link
                      className="button primary"
                      to={`/practice/${set.continuation.id}`}
                    >
                      {set.continuation.status === "reviewing"
                        ? `Finish assessment — ${set.continuation.result?.selfAssessed?.pendingCount ?? "some"} remaining`
                        : `Resume — ${set.kind === "exam" ? "question" : "card"} ${set.continuation.position + 1} of ${set.count}`}
                    </Link>
                  ) : (
                    <Button disabled={busy} onClick={() => void practice(set)}>
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
                    <button disabled={busy} onClick={() => void practice(set)}>
                      Start new attempt
                    </button>
                    <Link to={`/history?setId=${set.id}`}>
                      All attempts for this set
                    </Link>
                    <Link to={`/sets/${set.id}/edit`}>Edit set</Link>
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
        ) : !resource.error ? (
          <EmptyState
            title={
              search
                ? "No matching study sets."
                : filter === "all"
                  ? "Your first set starts here."
                  : "No sets here yet."
            }
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
          <Button disabled={!page} onClick={() => setPage((p) => p - 1)}>
            Previous page
          </Button>
          {page || resource.data?.hasMore ? (
            <span className="mono">Page {page + 1}</span>
          ) : null}
          <Button
            disabled={!resource.data?.hasMore}
            onClick={() => setPage((p) => p + 1)}
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
            setSearch("");
            setFilter("all");
            setPage(0);
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
