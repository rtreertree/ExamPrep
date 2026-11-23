import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DirectorySet, SetReaderData } from "../../shared/directory";
import { Button, ErrorNotice, LoadingRows, PageHeader } from "../components/ui";
import { copyDirectorySet } from "../lib/setSave";
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
