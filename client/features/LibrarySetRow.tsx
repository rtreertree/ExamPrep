import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Ellipsis } from "lucide-react";
import type { SetOrganization } from "../../shared/listing";
import { SurfaceLight } from "../components/SurfaceLight";
import { Button, Menu } from "../components/ui";
import type { StudySetMetadata } from "../lib/api";

export type LibrarySetRowActions = {
  practice: (set: StudySetMetadata) => void;
  share: (set: StudySetMetadata) => void;
  duplicate: (set: StudySetMetadata) => void;
  move: (set: StudySetMetadata) => void;
  organize: (set: StudySetMetadata, changes: SetOrganization) => void;
  export: (set: StudySetMetadata) => void;
  remove: (set: StudySetMetadata) => void;
};

type ActionProps = {
  set: StudySetMetadata;
  busy: boolean;
  returnTo: string;
  reorder?: ReactNode;
  actions: LibrarySetRowActions;
};

export function LibrarySetRow({
  set,
  ordinal,
  selecting,
  selected,
  showFolder,
  onSelect,
  busy,
  returnTo,
  reorder,
  actions,
}: ActionProps & {
  ordinal: number;
  selecting: boolean;
  selected: boolean;
  showFolder: boolean;
  onSelect: (checked: boolean) => void;
}) {
  return (
    <SurfaceLight className={`set-row${selected ? " set-row-selected" : ""}`}>
      {selecting ? (
        <label className="checkbox-row selection-set">
          <input
            type="checkbox"
            aria-label={`Select ${set.title}`}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        </label>
      ) : (
        <span className="ordinal" aria-hidden="true">
          {String(ordinal).padStart(2, "0")}
        </span>
      )}
      <Link
        className="set-title"
        aria-description="Edit this study set"
        to={`/sets/${set.id}/edit`}
      >
        {set.title}
        <span className="set-edit-cue" aria-hidden="true">
          Edit
        </span>
      </Link>
      <span className="set-meta">
        {set.kind === "exam"
          ? `Exam · ${set.count} question${set.count === 1 ? "" : "s"}`
          : `Flashcards · ${set.count} card${set.count === 1 ? "" : "s"}`}
        {showFolder && set.folderName ? (
          <span className="set-detail">{set.folderName}</span>
        ) : null}
        {set.pinned ? <span className="set-detail">Pinned</span> : null}
        {set.ownershipRole === "co_owner" ? (
          <span className="set-detail">Co-owned</span>
        ) : null}
        {set.continuation?.isOlderVersion ? (
          <span className="set-detail">
            Attempt uses an earlier set version
          </span>
        ) : null}
      </span>
      {selecting ? null : (
        <LibrarySetActions
          set={set}
          busy={busy}
          returnTo={returnTo}
          reorder={reorder}
          actions={actions}
        />
      )}
    </SurfaceLight>
  );
}

function LibrarySetActions({
  set,
  busy,
  returnTo,
  reorder,
  actions,
}: ActionProps) {
  return (
    <div className="row-actions">
      {set.continuation ? (
        <Link
          className="button secondary"
          to={`/practice/${set.continuation.id}`}
          state={{ returnTo }}
        >
          {set.continuation.status === "reviewing"
            ? `Finish assessment — ${set.continuation.result?.selfAssessed?.pendingCount ?? "some"} remaining`
            : `Resume — ${set.continuation.kind === "exam" ? "question" : "card"} ${set.continuation.position + 1} of ${set.continuation.total}`}
        </Link>
      ) : (
        <Button disabled={busy} onClick={() => actions.practice(set)}>
          Practice <ArrowRight size={17} />
        </Button>
      )}
      {set.kind === "flashcards" && !set.archived ? (
        <Link className="button quiet" to={`/review/${set.id}`}>
          Spaced review
        </Link>
      ) : null}
      <Menu
        label={
          <>
            <Ellipsis size={20} />
            <span className="sr-only">Actions for {set.title}</span>
          </>
        }
      >
        {set.continuation ? (
          <button disabled={busy} onClick={() => actions.practice(set)}>
            Start new attempt
          </button>
        ) : null}
        <Link to={`/history?setId=${set.id}`}>All attempts for this set</Link>
        <Link to={`/sets/${set.id}/edit`}>Edit set</Link>
        <Link to={`/sets/${set.id}/worksheet`} state={{ returnTo }}>
          Print worksheet
        </Link>
        {set.ownershipRole === "primary" ? (
          <button onClick={() => actions.share(set)}>
            Share and manage access
          </button>
        ) : null}
        <button disabled={busy} onClick={() => actions.duplicate(set)}>
          Duplicate set
        </button>
        <button disabled={busy} onClick={() => actions.move(set)}>
          Move to folder
        </button>
        {reorder}
        <button
          disabled={busy}
          onClick={() => actions.organize(set, { pinned: !set.pinned })}
        >
          {set.pinned ? "Unpin set" : "Pin set"}
        </button>
        <button
          disabled={busy}
          onClick={() => actions.organize(set, { archived: !set.archived })}
        >
          {set.archived ? "Unarchive set" : "Archive set"}
        </button>
        <button onClick={() => actions.export(set)}>Export</button>
        {set.ownershipRole === "primary" ? (
          <button className="negative" onClick={() => actions.remove(set)}>
            Delete
          </button>
        ) : null}
      </Menu>
    </div>
  );
}
