import { useState, type FormEvent } from "react";
import {
  Link,
  NavLink,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import type {
  DirectorySet,
  DirectoryUser,
  SetAccessSummary,
  SetReaderData,
  ShareRecipient,
} from "../../shared/directory";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  LoadingRows,
  PageHeader,
} from "../components/ui";
import { Selector } from "../components/Selector";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useResource } from "../lib/hooks";
import { Directory, kindFilter, SetRow, sharingFilter } from "./Directory";
import { CloneButton } from "./Discover";
import SetReader from "./SetReader";

const roleOptions = [
  { value: "user", label: "User" },
  { value: "admin", label: "Admin" },
];
const statusOptions = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];
function useAdminAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>(),
    [message, setMessage] = useState("");
  async function run(task: () => Promise<void>, success: string) {
    setBusy(true);
    setError(undefined);
    setMessage("");
    try {
      await task();
      setMessage(success);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    run,
    feedback: (
      <>
        <ErrorNotice error={error} />
        {message && <p role="status">{message}</p>}
      </>
    ),
  };
}
export default function Admin() {
  const { userId, setId } = useParams(),
    { pathname } = useLocation();
  const sets = pathname.startsWith("/admin/sets");
  return (
    <div className="stack">
      <PageHeader title="Admin" />
      <nav className="directory-sections" aria-label="Admin directory">
        <Link aria-current={sets ? undefined : "page"} to="/admin">
          Users
        </Link>
        <NavLink to="/admin/sets">Study sets</NavLink>
      </nav>
      {userId ? (
        <UserDetails key={userId} id={userId} />
      ) : setId ? (
        <SetDetails key={setId} id={setId} />
      ) : sets ? (
        <Directory<DirectorySet>
          path="/admin/sets"
          filters={[kindFilter, sharingFilter]}
          searchLabel="Search study sets"
          render={(set) => <SetRow to={"/admin/sets/" + set.id} set={set} />}
        />
      ) : (
        <Directory<DirectoryUser>
          path="/admin/users"
          searchLabel="Search users"
          filters={[
            {
              key: "role",
              label: "Role",
              options: [{ value: "", label: "All roles" }, ...roleOptions],
            },
            {
              key: "status",
              label: "Status",
              options: [{ value: "", label: "All statuses" }, ...statusOptions],
            },
          ]}
          render={(user) => (
            <div className="directory-row">
              <div className="directory-text">
                <Link
                  className="directory-title"
                  to={"/admin/users/" + user.id}
                >
                  {user.name}
                </Link>
                <p>{user.email}</p>
              </div>
              <span>
                {user.role === "admin" ? "Admin" : "User"} ·{" "}
                {user.suspended ? "Suspended" : "Active"}
              </span>
            </div>
          )}
        />
      )}
    </div>
  );
}
function UserDetails({ id }: { id: string }) {
  const { data, error, refresh, setData } = useResource<DirectoryUser>(
    "/admin/users/" + id,
  );
  const [adding, setAdding] = useState(false),
    [version, update] = useState(0);
  const action = useAdminAction();
  async function grant(set: DirectorySet) {
    await api("/admin/sets/" + set.id + "/access", "POST", {
      action: "grant",
      userId: id,
    });
    update((v) => v + 1);
  }
  if (error) return <ErrorNotice error={error} retry={refresh} />;
  if (!data) return <LoadingRows />;
  return (
    <div className="stack">
      <h2>{data.name}</h2>
      <p>{data.email}</p>
      <details>
        <summary>Account settings</summary>
        <Profile user={data} saved={setData} />
      </details>
      <div className="directory-row">
        <h2 className="directory-text">Library</h2>
        <Button onClick={() => setAdding(!adding)}>
          {adding ? "Close set picker" : "Add item"}
        </Button>
      </div>
      {action.feedback}
      {adding && (
        <Directory<DirectorySet>
          path="/admin/sets"
          searchLabel="Find a set to add"
          filters={[kindFilter]}
          render={(set) => (
            <SetRow set={set} to={"/admin/sets/" + set.id}>
              <CloneButton
                path={"/admin/users/" + id + "/copies"}
                actionKey={set.id}
                label="Add independent copy"
                onCreated={() => {
                  setAdding(false);
                  update((v) => v + 1);
                }}
              />
              <Button
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await grant(set);
                    setAdding(false);
                  }, "Co-ownership granted.")
                }
              >
                Grant co-ownership
              </Button>
            </SetRow>
          )}
        />
      )}
      <Directory<DirectorySet>
        version={version}
        path={"/admin/users/" + id + "/library"}
        searchLabel="Search this library"
        filters={[kindFilter]}
        render={(set) => (
          <SetRow set={set} to={"/admin/sets/" + set.id}>
            {set.ownershipRole === "co_owner" ? (
              <Button
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await api("/admin/sets/" + set.id + "/access", "POST", {
                      action: "revoke",
                      userId: id,
                    });
                    update((v) => v + 1);
                  }, "Access revoked.")
                }
              >
                Revoke access
              </Button>
            ) : (
              <Link to={"/admin/sets/" + set.id}>Manage set</Link>
            )}
          </SetRow>
        )}
      />
    </div>
  );
}
function Profile({
  user,
  saved,
}: {
  user: DirectoryUser;
  saved: (value: DirectoryUser) => void;
}) {
  const [name, setName] = useState(user.name),
    [email, setEmail] = useState(user.email),
    [role, setRole] = useState(user.role),
    [suspended, setSuspended] = useState(user.suspended);
  const auth = useAuth(),
    action = useAdminAction();
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const changed = {
        ...(name !== user.name && { name }),
        ...(email !== user.email && { email }),
        ...(role !== user.role && { role }),
        ...(suspended !== user.suspended && { suspended }),
      };
      const updated = await api<DirectoryUser>(
        "/admin/users/" + user.id,
        "PATCH",
        changed,
      );
      if (auth.user?.id === user.id) await auth.refresh();
      setEmail(updated.email);
      setName(updated.name);
      saved(updated);
    }, "Account saved.");
  }
  return (
    <form className="stack directory-form" onSubmit={save}>
      <Field label="Display name">
        <input
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Email">
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Role">
        <Selector
          options={roleOptions}
          value={role}
          onValueChange={(v) => setRole(v as DirectoryUser["role"])}
        />
      </Field>
      <Field label="Status">
        <Selector
          options={statusOptions}
          value={suspended ? "suspended" : "active"}
          onValueChange={(v) => setSuspended(v === "suspended")}
        />
      </Field>
      {action.feedback}
      <div>
        <Button busy={action.busy} type="submit">
          Save account
        </Button>
      </div>
    </form>
  );
}
function SetDetails({ id }: { id: string }) {
  const base = "/admin/sets/" + id,
    navigate = useNavigate();
  const preview = useResource<SetReaderData>(base + "/preview"),
    settings = useResource<SetAccessSummary>(base + "/access");
  const [email, setEmail] = useState(""),
    [version, update] = useState(0),
    [confirm, setConfirm] = useState<SetAccessSummary>();
  const action = useAdminAction();
  function change(input: object, success: string) {
    return action.run(async () => {
      await api(base + "/access", "POST", input);
      settings.refresh();
      update((v) => v + 1);
    }, success);
  }
  if (preview.error || settings.error)
    return (
      <ErrorNotice
        error={preview.error || settings.error}
        retry={() => {
          preview.refresh();
          settings.refresh();
        }}
      />
    );
  const info = settings.data;
  if (!preview.data || !info) return <LoadingRows />;
  return (
    <div className="stack">
      <PageHeader
        title={preview.data.content.title}
        description={"Owned by " + preview.data.ownerName}
      />
      <div className="actions">
        <Button
          disabled={action.busy || settings.loading}
          onClick={() =>
            change(
              { action: "publish", enabled: !info.published },
              "Discover publication updated.",
            )
          }
        >
          {info.published ? "Unpublish from Discover" : "Publish in Discover"}
        </Button>
        <Button
          disabled={action.busy || settings.loading}
          onClick={() =>
            change(
              { action: "link", enabled: !info.link },
              "Share link updated.",
            )
          }
        >
          {info.link ? "Turn off link" : "Enable view-only link"}
        </Button>
      </div>
      {info.link && (
        <Field label="View-only link">
          <input
            readOnly
            value={new URL(info.link, location.origin).href}
            onFocus={(e) => e.target.select()}
          />
        </Field>
      )}
      <details>
        <summary>Preview content</summary>
        <SetReader set={preview.data} showHeading={false} />
      </details>
      <h2>Sharing</h2>
      <form
        className="directory-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ action: "invite", email }, "Invitation sent.");
        }}
      >
        <Field label="Co-owner email">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={action.busy}>
          Invite co-owner
        </Button>
      </form>
      {action.feedback}
      <Directory<ShareRecipient>
        version={version}
        path={base + "/recipients"}
        searchLabel="Search recipients"
        render={(r) => (
          <div className="directory-row">
            <div className="directory-text">
              <strong>{r.name}</strong>
              <p>
                {r.email} · {r.invited ? "Pending invitation" : "Co-owner"}
              </p>
            </div>
            <Button
              disabled={action.busy}
              onClick={() =>
                change(
                  { action: r.invited ? "cancel" : "revoke", userId: r.id },
                  r.invited ? "Invitation canceled." : "Access revoked.",
                )
              }
            >
              {r.invited ? "Cancel invitation" : "Revoke access"}
            </Button>
          </div>
        )}
      />
      <div>
        <Button
          variant="danger"
          disabled={action.busy || settings.loading}
          onClick={() => setConfirm(info)}
        >
          Delete set for everyone
        </Button>
      </div>
      {confirm && (
        <Dialog
          title="Delete set for everyone?"
          onClose={() => setConfirm(undefined)}
        >
          <p>
            Delete <strong>{preview.data.content.title}</strong> from its
            owner’s library and revoke access for {confirm.coOwners} co-owners and {confirm.viewers} saved viewers.
            This removes {confirm.invitations} pending invitations.
          </p>
          <p>
            View-only link is {confirm.link ? "active" : "off"}. Discover
            listing is {confirm.published ? "published" : "unpublished"}.
            Independent copies and saved attempt history are retained.
          </p>
          {(confirm.coOwners > 0 || confirm.invitations > 0) && (
            <details>
              <summary>Review affected people</summary>
              <Directory<ShareRecipient>
                path={base + "/recipients"}
                searchLabel="Find affected people"
                render={(person) => (
                  <div className="directory-text">
                    <strong>{person.name}</strong>
                    <p>
                      {person.email} ·{" "}
                      {person.invited ? "Pending invitation" : "Co-owner"}
                    </p>
                  </div>
                )}
              />
            </details>
          )}
          <div className="actions">
            <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
            <Button
              variant="danger"
              busy={action.busy}
              onClick={() =>
                action.run(async () => {
                  try {
                    await api(base, "DELETE", confirm);
                    navigate("/admin/sets", { replace: true });
                  } finally {
                    setConfirm(undefined);
                    settings.refresh();
                  }
                }, "Set deleted.")
              }
            >
              Delete set for everyone
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
