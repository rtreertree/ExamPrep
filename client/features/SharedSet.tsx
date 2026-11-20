import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import type { SetReaderData } from "../../shared/directory";
import { ErrorNotice, LoadingRows } from "../components/ui";
import { api } from "../lib/api";
import SetReader from "./SetReader";

export default function SharedSetPage() {
  const token = useLocation().hash.slice(1);
  return <LinkReader key={token} token={token} />;
}
function LinkReader({ token }: { token: string }) {
  const [set, setData] = useState<SetReaderData>();
  const [error, setError] = useState<Error>();
  const [version, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    api<SetReaderData>("/shares/preview", "POST", { token }).then(
      (data) => {
        if (active) setData(data);
      },
      (err) => {
        if (active) setError(err);
      },
    );
    return () => {
      active = false;
    };
  }, [token, version]);
  if (error)
    return <ErrorNotice error={error} retry={() => retry(version + 1)} />;
  return set ? (
    <SetReader set={set} />
  ) : (
    <LoadingRows label="Loading shared study set" />
  );
}
