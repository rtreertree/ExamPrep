import {
  ArrowRight,
  ClipboardList,
  Layers,
  LayoutList,
  Search,
  X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DirectorySet, SetReaderData } from "../../shared/directory";
import { Button, ErrorNotice, LoadingRows } from "../components/ui";
import { copyDirectorySet } from "../lib/setSave";
import { useAuth } from "../lib/auth";
import { useResource } from "../lib/hooks";
import { DirectoryResults, useDirectorySearch } from "./Directory";
import { SaveLiveSet, useRefreshOnReturn } from "./SharedSet";
import SetReader from "./SetReader";
import "./discover.css";

const formats = [
  { value: "", label: "All sets", Icon: LayoutList },
  { value: "exam", label: "Exams", Icon: ClipboardList },
  { value: "flashcards", label: "Flashcards", Icon: Layers },
] as const;

function DiscoverCatalog() {
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState<(typeof formats)[number]["value"]>("");
  const searchInput = useRef<HTMLInputElement>(null);
  const { search, searching } = useDirectorySearch(query);
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (format) params.set("kind", format);
  const path = "/discover?" + params.toString();
  const filtered = Boolean(search || format);

  function clearSearch() {
    setQuery("");
    searchInput.current?.focus();
  }

  return (
    <div className="discover-catalog">
      <header className="discover-masthead">
        <div className="discover-intro">
          <h1>Discover</h1>
          <p>Find practice exams and flashcards to add to your library.</p>
          <label className="discover-search-label" htmlFor="discover-search">
            Search published sets
          </label>
          <div className="discover-search">
            <Search aria-hidden="true" size={21} />
            <input
              id="discover-search"
              ref={searchInput}
              type="search"
              maxLength={254}
              placeholder="Search by title"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <Button
                aria-label="Clear search"
                variant="quiet"
                onClick={clearSearch}
              >
                <X aria-hidden="true" size={18} />
              </Button>
            )}
          </div>
        </div>
        <fieldset className="discover-formats">
          <legend>Browse by format</legend>
          <div className="discover-format-options">
            {formats.map(({ value, label, Icon }) => (
              <label key={value}>
                <input
                  className="sr-only"
                  type="radio"
                  name="discover-format"
                  value={value}
                  checked={format === value}
                  onChange={() => setFormat(value)}
                />
                <span className="discover-format-choice">
                  <Icon aria-hidden="true" size={18} />
                  {label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </header>
      <section className="discover-results" aria-label="Published sets">
        <DirectoryResults<DirectorySet>
          key={path}
          path={searching ? null : path}
          heading="Published sets"
          render={(set) => <DiscoverSetLink set={set} />}
          empty={
            <div className="discover-empty">
              <h3>{filtered ? "No matching sets" : "No published sets yet"}</h3>
              {filtered && (
                <>
                  <p>Try a different title or browse all formats.</p>
                  <Button
                    onClick={() => {
                      setFormat("");
                      clearSearch();
                    }}
                  >
                    Clear filters
                  </Button>
                </>
              )}
            </div>
          }
        />
      </section>
    </div>
  );
}

function DiscoverSetLink({ set }: { set: DirectorySet }) {
  const id = useId();
  const exam = set.kind === "exam";
  const Icon = exam ? ClipboardList : Layers;
  const item = exam ? "question" : "card";
  return (
    <Link
      className="discover-set"
      to={"/discover/" + set.id}
      aria-labelledby={id}
      aria-describedby={id + "-owner " + id + "-format"}
    >
      <span className="discover-set-icon">
        <Icon aria-hidden="true" size={22} />
      </span>
      <span className="discover-set-title" id={id}>
        {set.title}
      </span>
      <span className="discover-set-owner" id={id + "-owner"}>
        Owned by {set.ownerName}
      </span>
      <span className="discover-set-format" id={id + "-format"}>
        <span>{exam ? "Exam" : "Flashcards"}</span>
        <small>
          {set.count} {item}
          {set.count === 1 ? "" : "s"}
        </small>
      </span>
      <ArrowRight className="discover-set-arrow" aria-hidden="true" size={20} />
    </Link>
  );
}

export function CloneButton({
  path,
  actionKey,
  label,
  onCreated,
}: {
  path: string;
  actionKey: string;
  label: string;
  onCreated: (id: string) => void;
}) {
  const { user } = useAuth();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  async function clone() {
    if (!user || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await copyDirectorySet(user.id, path, actionKey);
      onCreated(id);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant={path.startsWith("/admin/") ? "primary" : "secondary"}
        busy={busy}
        onClick={clone}
      >
        {label}
      </Button>
      <ErrorNotice error={error} />
    </>
  );
}
export default function Discover() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, error, refresh } = useResource<SetReaderData>(
    id ? "/discover/" + id : null,
  );
  useRefreshOnReturn(refresh);
  if (id)
    return (
      <div className="stack">
        <Link to="/discover">Back to Discover</Link>
        <ErrorNotice error={error} retry={refresh} />
        {data && !error ? (
          <SetReader
            set={data}
            actions={
              <div className="stack">
                <SaveLiveSet key={"save" + id} discoverId={id} />
                <details>
                  <summary>Make an editable copy</summary>
                  <p>
                    Your copy starts with fresh progress and keeps its own
                    edits.
                  </p>
                  <CloneButton
                    key={id}
                    path={"/discover/" + id + "/clone"}
                    actionKey={id}
                    label="Make an independent copy"
                    onCreated={(copy) => navigate("/sets/" + copy + "/edit")}
                  />
                </details>
              </div>
            }
          />
        ) : (
          !error && <LoadingRows />
        )}
      </div>
    );
  return <DiscoverCatalog />;
}
