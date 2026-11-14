import { useRef, useState } from "react";
import { ChevronRight, Ellipsis, Folder, FolderOpen } from "lucide-react";
import {
  LIST_PAGE_SIZE,
  type FolderList,
  type LibraryFolder,
  type ManualOrder,
  type SetOrganization,
  type SortOrder,
} from "../../shared/listing";
import { ListOrdering } from "../components/ListOrdering";
import { PositionForm } from "../components/PositionForm";
import { Selector } from "../components/Selector";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  Field,
  LoadingRows,
  Menu,
  Pagination,
} from "../components/ui";
import { api } from "../lib/api";
import { useResource } from "../lib/hooks";

const archiveOptions = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];
const folderArrangements = [
  { value: "name", label: "Name" },
  { value: "manual", label: "Manual" },
] as const;
type FolderArrangement = (typeof folderArrangements)[number]["value"];

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

export function LibraryFolders({
  archived,
  page,
  search,
  appliedSearch,
  sort,
  order,
  onSearch,
  onClearSearch,
  onSort,
  onOrder,
  onPageChange,
  onChoose,
}: {
  archived: boolean;
  page: number;
  search: string;
  appliedSearch: string;
  sort: FolderArrangement;
  order: SortOrder;
  onSearch: (value: string) => void;
  onClearSearch: () => void;
  onSort: (value: FolderArrangement) => void;
  onOrder: (value: SortOrder) => void;
  onPageChange: (page: number) => void;
  onChoose: (folderId: string) => void;
}) {
  const results = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "rename" | "delete"; folder: LibraryFolder }
  >();
  const [orderError, setOrderError] = useState<Error>();
  const [orderBusy, setOrderBusy] = useState(false);
  const [positionItem, setPositionItem] = useState<OrderItem>();
  const [notice, setNotice] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    archived: String(archived),
    search: appliedSearch,
    sort,
    order,
  });
  const resource = useResource<FolderList>(`/folders?${query}`);
  const { data, error, loading, refresh } = resource;
  const manual = sort === "manual" && !search ? data?.manual : undefined;
  function goToPage(next: number) {
    onPageChange(next);
    results.current?.focus();
    results.current?.scrollIntoView({ block: "start" });
  }
  function moved(title: string, position: number) {
    setPositionItem(undefined);
    setOrderError(undefined);
    setNotice(`Moved “${title}” to position ${position}.`);
    refresh();
    goToPage(Math.floor((position - 1) / LIST_PAGE_SIZE));
  }
  const setCount = (count: number) =>
    `${count} ${count === 1 ? "set" : "sets"}`;
  return (
    <>
      <div className="collection-tools">
        <Field label="Search folders">
          <input
            type="search"
            value={search}
            maxLength={200}
            placeholder="Find a folder by name"
            onChange={(event) => onSearch(event.target.value)}
          />
        </Field>
        <ListOrdering
          sort={sort}
          order={order}
          options={folderArrangements}
          alphabetical
          onSort={onSort}
          onOrder={onOrder}
        />
        <Button onClick={() => setEditor({ mode: "create" })}>
          New folder
        </Button>
      </div>
      <section
        className="list-results"
        ref={results}
        tabIndex={-1}
        aria-label="Folders"
      >
        <ErrorNotice error={error} retry={refresh} />
        <ErrorNotice error={orderError} />
        <div className="list-announcement" role="status">
          {notice ? <p>{notice}</p> : null}
        </div>
        {sort === "manual" && search ? (
          <p className="muted">Clear search to reorder folders.</p>
        ) : null}
        {loading && !data ? <LoadingRows label="Loading folders" /> : null}
        {data && (data.items.length > 0 || data.unfiledCount !== null) ? (
          <ul className="organization-list" aria-busy={loading}>
            {data.unfiledCount !== null ? (
              <li className="folder-row">
                <Button
                  variant="quiet"
                  className="organization-row"
                  onClick={() => onChoose("")}
                >
                  <FolderOpen size={19} aria-hidden="true" />
                  <strong>Unfiled</strong>
                  <span className="muted">{setCount(data.unfiledCount)}</span>
                  <ChevronRight size={18} aria-hidden="true" />
                </Button>
              </li>
            ) : null}
            {data.items.map((folder, index) => (
              <li className="folder-row" key={folder.id}>
                <Button
                  variant="quiet"
                  className="organization-row"
                  onClick={() => onChoose(folder.id)}
                >
                  <Folder size={19} aria-hidden="true" />
                  <strong>{folder.name}</strong>
                  <span className="muted">{setCount(folder.count)}</span>
                  <ChevronRight size={18} aria-hidden="true" />
                </Button>
                <Menu
                  label={
                    <>
                      <Ellipsis size={20} />
                      <span className="sr-only">Actions for {folder.name}</span>
                    </>
                  }
                >
                  <button onClick={() => setEditor({ mode: "rename", folder })}>
                    Rename folder
                  </button>
                  {manual ? (
                    <ReorderActions
                      itemId={folder.id}
                      title={folder.name}
                      position={page * LIST_PAGE_SIZE + index + 1}
                      order={manual}
                      disabled={loading || orderBusy}
                      location={{ kind: "folder" }}
                      onBusy={setOrderBusy}
                      onPrompt={setPositionItem}
                      onError={(error) => {
                        setOrderError(error);
                        refresh();
                      }}
                      onMoved={(position) => moved(folder.name, position)}
                    />
                  ) : null}
                  <button
                    className="negative"
                    onClick={() => setEditor({ mode: "delete", folder })}
                  >
                    Delete folder
                  </button>
                </Menu>
              </li>
            ))}
          </ul>
        ) : !error && !loading && appliedSearch ? (
          <EmptyState
            title="No folders match this search."
            actions={<Button onClick={onClearSearch}>Clear search</Button>}
          >
            {null}
          </EmptyState>
        ) : !error && !loading ? (
          <p className="muted">No folders on this page.</p>
        ) : null}
        <Pagination
          label="Folder pages"
          page={page}
          hasMore={data?.hasMore}
          loading={loading}
          onChange={goToPage}
        />
      </section>
      {editor ? (
        <FolderEditor
          editor={editor}
          onClose={() => setEditor(undefined)}
          onSaved={(message) => {
            setEditor(undefined);
            setNotice(message);
            refresh();
            if (
              editor.mode === "delete" &&
              page > 0 &&
              data?.items.length === 1
            )
              goToPage(page - 1);
            results.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
      {positionItem ? (
        <PositionDialog
          item={positionItem}
          onClose={() => setPositionItem(undefined)}
          onMoved={(position) => moved(positionItem.title, position)}
          onError={(error) => {
            setPositionItem(undefined);
            setOrderError(error);
            refresh();
            results.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </>
  );
}

function FolderEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor:
    { mode: "create" } | { mode: "rename" | "delete"; folder: LibraryFolder };
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const folder = editor.mode === "create" ? undefined : editor.folder;
  const [name, setName] = useState(folder?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const deleting = editor.mode === "delete";
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Dialog
      title={
        deleting ? "Delete folder?" : folder ? "Rename folder" : "New folder"
      }
      onClose={close}
    >
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || (!deleting && !name.trim())) return;
          setBusy(true);
          setError(undefined);
          try {
            if (deleting && folder) {
              await api(`/folders/${folder.id}`, "DELETE", {});
              onSaved(`Deleted “${folder.name}”. Its sets moved to Unfiled.`);
            } else {
              const saved = await api<LibraryFolder>(
                folder ? `/folders/${folder.id}` : "/folders",
                folder ? "PATCH" : "POST",
                { name },
              );
              onSaved(
                folder
                  ? `Renamed folder to “${saved.name}”.`
                  : `Created “${saved.name}”.`,
              );
            }
          } catch (error) {
            setError(error as Error);
            setBusy(false);
          }
        }}
      >
        {deleting ? (
          <p>
            Delete “{folder?.name}”? Its active and archived sets will move to
            Unfiled.
          </p>
        ) : (
          <Field label="Folder name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </Field>
        )}
        <ErrorNotice error={error} />
        <div className="actions">
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant={deleting ? "danger" : "primary"}
            busy={busy}
            disabled={!deleting && !name.trim()}
            type="submit"
          >
            {deleting
              ? "Delete folder"
              : folder
                ? "Save name"
                : "Create folder"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export type OrderLocation =
  | { kind: "folder" }
  | {
      kind: "set";
      folderId: string | null;
      archived: boolean;
    };
export type OrderItem = {
  itemId: string;
  title: string;
  position: number;
  order: ManualOrder;
  location: OrderLocation;
};

export function ReorderActions({
  itemId,
  title,
  position,
  order,
  location,
  disabled,
  onBusy,
  onError,
  onMoved,
  onPrompt,
}: OrderItem & {
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onError: (error: Error) => void;
  onMoved: (position: number) => void;
  onPrompt: (item: OrderItem) => void;
}) {
  const item = { itemId, title, position, order, location };
  async function move(next: number) {
    onBusy(true);
    try {
      await savePosition(item, next);
      onMoved(next);
    } catch (error) {
      onError(error as Error);
    } finally {
      onBusy(false);
    }
  }
  return (
    <>
      <button
        disabled={disabled || position <= 1}
        onClick={() => void move(position - 1)}
      >
        Move up
      </button>
      <button
        disabled={disabled || position >= order.count}
        onClick={() => void move(position + 1)}
      >
        Move down
      </button>
      <button
        disabled={disabled || order.count < 2}
        onClick={() => onPrompt(item)}
      >
        Move to position
      </button>
    </>
  );
}

function savePosition(item: OrderItem, position: number) {
  return api("/library/order", "PATCH", {
    ...item.location,
    id: item.itemId,
    version: item.order.version,
    position,
  });
}

export function PositionDialog({
  item,
  onClose,
  onMoved,
  onError,
}: {
  item: OrderItem;
  onClose: () => void;
  onMoved: (position: number) => void;
  onError: (error: Error) => void;
}) {
  const [position, setPosition] = useState(String(item.position));
  const [busy, setBusy] = useState(false);
  const valid =
    Number.isInteger(Number(position)) &&
    Number(position) >= 1 &&
    Number(position) <= item.order.count;
  return (
    <Dialog
      title="Move to position"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <PositionForm
        label="Position"
        submitLabel="Move"
        value={position}
        max={item.order.count}
        inputMode="numeric"
        busy={busy}
        submitDisabled={!valid}
        onChange={setPosition}
        onCancel={onClose}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !valid) return;
          setBusy(true);
          try {
            await savePosition(item, Number(position));
            onMoved(Number(position));
          } catch (error) {
            onError(error as Error);
          }
        }}
      >
        <p>{item.title}</p>
      </PositionForm>
    </Dialog>
  );
}

export function FolderPicker({
  folders,
  value,
  onChange,
  disabled,
}: {
  folders: LibraryFolder[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <Field label="Destination">
      <Selector
        value={value || "__unfiled"}
        onValueChange={(next) => onChange(next === "__unfiled" ? "" : next)}
        disabled={disabled}
        options={[
          { value: "__unfiled", label: "Unfiled" },
          ...folders.map(({ id, name }) => ({ value: id, label: name })),
        ]}
      />
    </Field>
  );
}

export function BulkOrganizationDialog({
  count,
  folders,
  archived,
  busy,
  error,
  onClose,
  onSave,
}: {
  count: number;
  folders: LibraryFolder[];
  archived: boolean;
  busy: boolean;
  error?: Error;
  onClose: () => void;
  onSave: (changes: SetOrganization) => void;
}) {
  const [action, setAction] = useState("");
  const [folderId, setFolderId] = useState("");
  const changes: Record<string, SetOrganization> = {
    folder: { folderId: folderId || null },
    pin: { pinned: true },
    unpin: { pinned: false },
    archive: { archived: !archived },
  };
  return (
    <Dialog title="Organize selected sets" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && changes[action]) onSave(changes[action]);
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
              { value: "folder", label: "Move to folder" },
              { value: "pin", label: "Pin sets" },
              { value: "unpin", label: "Unpin sets" },
              {
                value: "archive",
                label: archived ? "Restore sets" : "Archive sets",
              },
            ]}
          />
        </Field>
        {action === "folder" ? (
          <FolderPicker
            folders={folders}
            value={folderId}
            onChange={setFolderId}
            disabled={busy}
          />
        ) : null}
        <ErrorNotice error={error} />
        <div className="actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!changes[action]}
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
