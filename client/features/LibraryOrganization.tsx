import { useRef, useState } from "react";
import type {
  CourseSummary,
  ListResult,
  SetOrganization,
} from "../../shared/listing";
import { Selector } from "../components/Selector";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  Field,
  LoadingRows,
  Pagination,
} from "../components/ui";
import { useResource } from "../lib/hooks";

const archiveOptions = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function ArchiveScope({
  archived,
  onChange,
}: {
  archived: boolean;
  onChange: (archived: boolean) => void;
}) {
  return (
    <Field label="Show sets">
      <Selector
        value={archived ? "archived" : "active"}
        onValueChange={(value) => onChange(value === "archived")}
        options={archiveOptions}
      />
    </Field>
  );
}

export function LibraryCourses({
  archived,
  page,
  onPageChange,
  onScopeChange,
  onChoose,
}: {
  archived: boolean;
  page: number;
  onPageChange: (page: number) => void;
  onScopeChange: (archived: boolean) => void;
  onChoose: (course: string) => void;
}) {
  const results = useRef<HTMLElement>(null);
  const { data, error, loading, refresh } = useResource<
    ListResult<CourseSummary>
  >(`/sets/courses?page=${page}&archived=${archived}`);
  return (
    <>
      <div className="list-filter-fields">
        <ArchiveScope archived={archived} onChange={onScopeChange} />
      </div>
      <section
        className="list-results"
        ref={results}
        tabIndex={-1}
        aria-label="Courses"
      >
        <ErrorNotice error={error} retry={refresh} />
        {loading && !data ? <LoadingRows label="Loading courses" /> : null}
        {data?.items.length ? (
          <ul className="organization-list" aria-busy={loading}>
            {data.items.map(({ course, count }) => (
              <li key={course}>
                <button
                  className="organization-row"
                  type="button"
                  onClick={() => onChoose(course)}
                >
                  <strong>{course || "No course"}</strong>
                  <span className="muted">
                    {count} {count === 1 ? "set" : "sets"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : !error && !loading ? (
          <EmptyState
            title={
              page > 0
                ? "No courses on this page."
                : archived
                  ? "No archived study sets."
                  : "No active study sets."
            }
          >
            {null}
          </EmptyState>
        ) : null}
        <Pagination
          label="Course pages"
          page={page}
          hasMore={data?.hasMore}
          loading={loading}
          onChange={(next) => {
            onPageChange(next);
            results.current?.focus();
            results.current?.scrollIntoView({ block: "start" });
          }}
        />
      </section>
    </>
  );
}

const bulkActions = [
  { value: "course", label: "Set course" },
  { value: "clear-course", label: "Clear course" },
  { value: "pin", label: "Pin sets" },
  { value: "unpin", label: "Unpin sets" },
];

export function BulkOrganizationDialog({
  count,
  courses,
  archived,
  busy,
  error,
  onClose,
  onSave,
}: {
  count: number;
  courses: string[];
  archived: boolean;
  busy: boolean;
  error?: Error;
  onClose: () => void;
  onSave: (changes: SetOrganization) => void;
}) {
  const [action, setAction] = useState("");
  const [course, setCourse] = useState("");
  const changes: Record<string, SetOrganization> = {
    course: { course },
    "clear-course": { course: "" },
    pin: { pinned: true },
    unpin: { pinned: false },
    archive: { archived: !archived },
  };
  const canSave = Boolean(
    changes[action] && (action !== "course" || course.trim()),
  );
  return (
    <Dialog title="Organize selected sets" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && canSave) onSave(changes[action]);
        }}
      >
        <p>
          {count} {count === 1 ? "set" : "sets"} selected
        </p>
        <Field label="Action">
          <Selector
            value={action}
            onValueChange={setAction}
            disabled={busy}
            placeholder="Choose an action"
            options={[
              ...bulkActions,
              {
                value: "archive",
                label: archived ? "Restore sets" : "Archive sets",
              },
            ]}
          />
        </Field>
        {action === "course" ? (
          <Field label="Course name">
            <Selector
              editable
              maxLength={100}
              value={course}
              onValueChange={setCourse}
              disabled={busy}
              options={courses.map((name) => ({ value: name, label: name }))}
            />
          </Field>
        ) : null}
        <ErrorNotice error={error} />
        <div className="actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSave}
            busy={busy}
            type="submit"
          >
            Apply to selected sets
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
