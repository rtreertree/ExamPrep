import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DirectorySet, SetReaderData } from "../../shared/directory";
import { Button, ErrorNotice, LoadingRows, PageHeader } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useResource } from "../lib/hooks";
import { Directory, kindFilter, SetRow } from "./Directory";
import { SaveLiveSet, useRefreshOnReturn } from "./SharedSet";
import SetReader from "./SetReader";

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
  const key = JSON.stringify(["clone", user?.id, path, actionKey]);
  const request = useRef<string | undefined>(undefined);
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  function clearRequest() {
    request.current = undefined;
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Device storage is optional. */
    }
  }
  async function clone() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      try {
        request.current ||= sessionStorage.getItem(key) || undefined;
      } catch {
        /* Device storage is optional. */
      }
      const requestId = (request.current ||= crypto.randomUUID());
      try {
        sessionStorage.setItem(key, requestId);
      } catch {
        /* Retain the key in memory. */
      }
      const { id } = await api<{ id: string }>(
        path,
        "POST",
        path.startsWith("/admin/")
          ? { requestId, setId: actionKey }
          : { requestId },
      );
      clearRequest();
      onCreated(id);
    } catch (err) {
      if (err instanceof ApiError && [404, 409].includes(err.status))
        clearRequest();
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
                    label="Create editable copy"
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
  return (
    <div className="stack">
      <PageHeader title="Discover" />
      <Directory<DirectorySet>
        path="/discover"
        searchLabel="Search published sets"
        filters={[kindFilter]}
        render={(set) => <SetRow set={set} to={"/discover/" + set.id} />}
      />
    </div>
  );
}
