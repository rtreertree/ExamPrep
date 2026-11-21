import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import type { SetReaderData } from "../../shared/directory";
import { Button, ErrorNotice, LoadingRows } from "../components/ui";
import { PracticeSetup } from "../components/PracticeSetup";
import { api, type StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useResource } from "../lib/hooks";
import SetReader from "./SetReader";

export function useRefreshOnReturn(refresh: () => void) {
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
}

export function SaveLiveSet({
  token,
  discoverId,
}: {
  token?: string;
  discoverId?: string;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const started = useRef(false);
  const save = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api<{ id: string }>(
        discoverId ? `/discover/${discoverId}/save` : "/shares/save",
        "POST",
        discoverId ? {} : { token },
      );
      navigate(`/sets/${id}/view`, { replace: true });
    } catch (err) {
      started.current = false;
      setError(err as Error);
      setBusy(false);
    }
  }, [token, discoverId, navigate]);
  useEffect(() => {
    if (user && location.state?.saveAfterSignIn) void save();
  }, [user, location.state, save]);
  return (
    <>
      <Button
        variant="primary"
        busy={busy}
        onClick={() => {
          if (user) void save();
          else
            navigate("/sign-in", {
              state: {
                signInReturn: { ...location, state: { saveAfterSignIn: true } },
              },
            });
        }}
      >
        Save to my library
      </Button>
      <ErrorNotice error={error} />
    </>
  );
}

export function SavedSetPage() {
  const { id } = useParams();
  const { data, error, refresh } = useResource<
    StudySet & { ownerName: string }
  >(`/sets/${id}`);
  const [practice, setPractice] = useState(false);
  useRefreshOnReturn(refresh);
  if (error) return <ErrorNotice error={error} retry={refresh} />;
  if (!data) return <LoadingRows />;
  return (
    <div className="stack">
      <Link to="/library">Back to library</Link>
      <SetReader
        set={data}
        actions={
          <Button variant="primary" onClick={() => setPractice(true)}>
            Practice
          </Button>
        }
      />
      {practice && (
        <PracticeSetup
          set={data}
          onClose={() => setPractice(false)}
          returnTo={`/sets/${data.id}/view`}
        />
      )}
    </div>
  );
}

export default function SharedSetPage() {
  const token = useLocation().hash.slice(1);
  return (
    <main className="workspace-main">
      <Link to="/library">Exam Prep</Link>
      <LinkReader key={token} token={token} />
    </main>
  );
}

function LinkReader({ token }: { token: string }) {
  const location = useLocation();
  const [set, setData] = useState<SetReaderData | { signInRequired: true }>();
  const [error, setError] = useState<Error>();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useRefreshOnReturn(refresh);
  useEffect(() => {
    let active = true;
    api<SetReaderData | { signInRequired: true }>("/shares/preview", "POST", {
      token,
    }).then(
      (data) => {
        if (active) {
          setData(data);
          setError(undefined);
        }
      },
      (err) => {
        if (active) {
          setData(undefined);
          setError(err);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [token, version]);
  if (error) return <ErrorNotice error={error} retry={refresh} />;
  if (!set) return <LoadingRows label="Loading shared study set" />;
  if ("signInRequired" in set)
    return (
      <Navigate replace to="/sign-in" state={{ signInReturn: location }} />
    );
  return <SetReader set={set} actions={<SaveLiveSet token={token} />} />;
}
