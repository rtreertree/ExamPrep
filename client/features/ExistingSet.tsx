import { useState } from "react";
import { Link } from "react-router-dom";
import type { StudyContent } from "../../shared/content";
import { Button, ErrorNotice } from "../components/ui";
import type { StudySet } from "../lib/api";
import { useAuth } from "../lib/auth";
import { saveStudySet } from "../lib/setSave";

export type SetMatch = { set: StudySet; content: StudyContent };

export function ExistingSet({
  match,
  onOpen,
  onCopy,
}: {
  match: SetMatch;
  onOpen?: () => void;
  onCopy: (set: StudySet) => void;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  return (
    <>
      <p>
        “{match.set.title}” is already in your{" "}
        {match.set.archived ? "archive" : "library"}.
      </p>
      <ErrorNotice error={error} />
      <div className="actions">
        {onOpen ? (
          <Button variant="primary" disabled={busy} onClick={onOpen}>
            Open existing set
          </Button>
        ) : (
          <Link className="button primary" to={`/sets/${match.set.id}/edit`}>
            Open existing set
          </Link>
        )}
        <Button
          busy={busy}
          onClick={async () => {
            if (!user || busy) return;
            setBusy(true);
            setError(undefined);
            try {
              const { set } = await saveStudySet(user.id, match.content, true);
              onCopy(set);
            } catch (e) {
              setError(e as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          Make an independent copy
        </Button>
      </div>
    </>
  );
}
