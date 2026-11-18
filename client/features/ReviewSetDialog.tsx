import { useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import {
  retrySnapshot,
  type Responses,
  type RetryMode,
} from "../../shared/attempts";
import type { StudyContent } from "../../shared/content";
import { codePoints, itemsOf } from "../../shared/contentItems";
import { Button, Dialog, ErrorNotice, Field } from "../components/ui";
import { Selector } from "../components/Selector";
import { api } from "../lib/api";
import { matchesItem, withItems } from "./editorItems";

export function ReviewSetDialog({
  content,
  responses,
  onClose,
}: {
  content: StudyContent;
  responses: Responses;
  onClose: () => void;
}) {
  const items = itemsOf(content);
  const isExam = content.kind === "exam";
  const location = useLocation();
  const groups = useMemo(() => {
    const modes: [RetryMode, string][] = [
      ["mistakes", isExam ? "Missed questions" : "Review again"],
      ["flagged", "Flagged"],
      ["low_confidence", "Low confidence"],
      ["unreviewed", "Unreviewed cards"],
    ];
    const presets = modes.flatMap(([value, label]) => {
      const subset = retrySnapshot(content, responses, value);
      if (!subset) return [];
      const ids = itemsOf(subset).map((item) => item.id);
      return [{ value, label: `${label} (${ids.length})`, ids }];
    });
    return [
      ...presets,
      {
        value: "all",
        label: `All ${isExam ? "questions" : "cards"} (${items.length})`,
        ids: items.map((item) => item.id),
      },
      { value: "none", label: "Clear selection", ids: [] },
    ];
  }, [content, responses, items, isExam]);
  const [selection, setSelection] = useState(() => new Set(groups[0].ids));
  const [group, setGroup] = useState(groups[0].value);
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const selectedFilter = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const query = search.trim().toLowerCase();
  const matches = useMemo(() => {
    const number = /^#\d+$/.test(query) ? Number(query.slice(1)) : undefined;
    return items.flatMap((item, index) => {
      const found =
        number === undefined
          ? !query || matchesItem(item, query)
          : index + 1 === number;
      return found ? [{ item, index }] : [];
    });
  }, [items, query]);
  const visible = selectedOnly
    ? matches.filter(({ item }) => selection.has(item.id))
    : matches;
  const [title, setTitle] = useState(() =>
    Array.from(`Review · ${content.title}`).slice(0, 200).join(""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [saved, setSaved] = useState<{ id: string; title: string }>();
  const request = useRef<{
    signature: string;
    id: string;
  } | null>(null);
  const name = title.trim();
  const titleTooLong = codePoints(name) > 200;
  const canSave = selection.size > 0 && !!name && !titleTooLong;

  function chooseGroup(value: string) {
    const chosen = groups.find((entry) => entry.value === value);
    if (!chosen) return;
    setGroup(value);
    setSelection(new Set(chosen.ids));
  }

  async function save() {
    if (busy || !canSave) return;
    setBusy(true);
    setError(undefined);
    try {
      const chosen = items.filter((item) => selection.has(item.id));
      const signature = JSON.stringify([name, chosen.map((item) => item.id)]);
      if (request.current?.signature !== signature) {
        request.current = { signature, id: crypto.randomUUID() };
      }
      const subset = withItems(content, chosen);
      setSaved(
        await api<{ id: string; title: string }>(
          `/sets?requestId=${request.current.id}`,
          "POST",
          { ...subset, title: name },
        ),
      );
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={saved ? "Review set saved" : "Create a review set"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {saved ? (
        <>
          <p role="status">
            <strong>{saved.title}</strong> is in your library.
          </p>
          <div className="actions">
            <Link className="button primary" to={`/sets/${saved.id}/edit`}>
              Open set
            </Link>
            <Link
              className="button secondary"
              to={`/sets/${saved.id}/worksheet`}
              state={{
                returnTo: location.pathname,
                practiceReturnTo: location.state?.returnTo,
              }}
            >
              Print worksheet
            </Link>
            <Button onClick={onClose}>Back to results</Button>
          </div>
        </>
      ) : (
        <form
          className="review-set-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="review-set-fields">
            <Field label="Set title">
              <input
                required
                value={title}
                disabled={busy}
                aria-invalid={titleTooLong}
                aria-describedby={
                  titleTooLong ? "review-title-error" : undefined
                }
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="Selection preset">
              <Selector
                value={group}
                options={
                  group === "custom"
                    ? [
                        ...groups,
                        {
                          value: "custom",
                          label: "Custom selection",
                          disabled: true,
                        },
                      ]
                    : groups
                }
                disabled={busy}
                onValueChange={chooseGroup}
              />
            </Field>
          </div>
          {titleTooLong ? (
            <p id="review-title-error" role="alert" className="negative">
              Use a title of 200 characters or fewer.
            </p>
          ) : null}
          {items.length > 1 ? (
            <div className="review-set-filters">
              <label className="review-set-search">
                <Search size={16} aria-hidden="true" />
                <span className="sr-only">
                  {isExam ? "Search questions" : "Search cards"}
                </span>
                <input
                  ref={searchInput}
                  type="search"
                  placeholder="Text or #12"
                  value={search}
                  disabled={busy}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing)
                      event.preventDefault();
                  }}
                />
              </label>
              <Button
                ref={selectedFilter}
                aria-pressed={selectedOnly}
                disabled={busy}
                onClick={() => setSelectedOnly(!selectedOnly)}
              >
                Selected only
              </Button>
            </div>
          ) : null}
          <fieldset className="review-set-items" disabled={busy}>
            <legend className="sr-only">Include in review set</legend>
            {visible.map(({ item, index }, row) => (
              <label className="checkbox-row" key={item.id}>
                <input
                  type="checkbox"
                  checked={selection.has(item.id)}
                  onChange={(event) => {
                    if (selectedOnly && !event.target.checked) {
                      const boxes = event.currentTarget
                        .closest("fieldset")
                        ?.querySelectorAll<HTMLInputElement>("input");
                      (
                        boxes?.[row + 1] ??
                        boxes?.[row - 1] ??
                        selectedFilter.current
                      )?.focus();
                    }
                    const next = new Set(selection);
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    setGroup("custom");
                    setSelection(next);
                  }}
                />
                <span>
                  <span className="mono muted">
                    {isExam ? "Question" : "Card"} {index + 1}
                  </span>
                  <span className="review-set-prompt">
                    {"prompt" in item ? item.prompt : item.front}
                  </span>
                </span>
              </label>
            ))}
            {!visible.length ? (
              <div className="review-set-empty">
                <p>
                  {query ? "No matches for this search." : "No items selected."}
                </p>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setSearch("");
                    setSelectedOnly(false);
                    searchInput.current?.focus();
                  }}
                >
                  Show all items
                </Button>
              </div>
            ) : null}
          </fieldset>
          <ErrorNotice error={error} />
          <footer className="review-set-footer">
            <p className="muted" role="status">
              {selection.size} of {items.length} selected
              {query || selectedOnly ? ` · ${visible.length} shown` : ""}
            </p>
            <div className="actions">
              <Button
                variant="primary"
                type="submit"
                busy={busy}
                disabled={!canSave}
              >
                Save to library
              </Button>
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </div>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
