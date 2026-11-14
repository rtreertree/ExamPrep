import type { ReactNode } from "react";
import { own, type Responses, type Status } from "../../shared/attempts";
import type { StudyContent } from "../../shared/content";
import { Button, Dialog, ErrorNotice, Notice, Tabs } from "../components/ui";
import type { Attempt } from "../lib/api";
import {
  planPracticeRecovery,
  type PracticeCheckpoint,
} from "../lib/practiceRecovery";

export function PracticeSubmitDialog({
  kind,
  itemIds,
  unanswered,
  flaggedCount,
  writtenAnswered,
  omissions,
  position,
  error,
  busy,
  submitting,
  onClose,
  onJump,
  onDownload,
  onSubmit,
}: {
  kind: StudyContent["kind"];
  itemIds: string[];
  unanswered: number;
  flaggedCount: number;
  writtenAnswered: number;
  omissions: number[];
  position: number;
  error?: Error;
  busy: boolean;
  submitting: boolean;
  onClose: () => void;
  onJump: (index: number) => Promise<void>;
  onDownload: () => void;
  onSubmit: () => Promise<void>;
}) {
  const isExam = kind === "exam";
  return (
    <Dialog
      title={kind === "exam" ? "Submit this exam?" : "Finish this session?"}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <div className={isExam ? "exam-submit-summary" : undefined}>
        <p>
          {itemIds.length - unanswered} {isExam ? "answered" : "rated"},{" "}
          {unanswered}{" "}
          {isExam ? `unanswered, ${flaggedCount} flagged` : "unreviewed"}.
        </p>
        {isExam ? (
          <p>
            {unanswered ? "Unanswered questions earn zero points. " : ""}
            Submitting locks your answers.
            {writtenAnswered ? " You’ll assess your written answers next." : ""}
          </p>
        ) : (
          <p>
            {unanswered} unreviewed cards will be included in your summary. Only
            cards rated Review again appear in a retry.
          </p>
        )}
      </div>
      {omissions.length ? (
        <details>
          <summary>
            {kind === "exam"
              ? "Review unanswered questions"
              : "Review unreviewed cards"}
          </summary>
          <div
            className={`question-nav${isExam ? " exam-unanswered-list" : ""}`}
          >
            {omissions.map((i) => (
              <Button
                key={itemIds[i]}
                disabled={submitting}
                onClick={() => void onJump(i)}
              >
                {kind === "exam" ? "Question" : "Card"} {i + 1}
              </Button>
            ))}
          </div>
        </details>
      ) : null}
      {kind === "flashcards" && omissions.length ? (
        <Button
          disabled={submitting}
          onClick={() =>
            void onJump(omissions.find((i) => i > position) ?? omissions[0])
          }
        >
          Go to next unreviewed card
        </Button>
      ) : null}
      <ErrorNotice error={error} />
      {error ? (
        <Button onClick={onDownload}>Download recovery copy</Button>
      ) : null}
      <div className={isExam ? "actions dialog-footer" : "actions"}>
        <Button disabled={submitting} onClick={onClose}>
          {isExam ? "Return to exam" : "Keep studying"}
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void onSubmit()}>
          {isExam ? "Submit exam" : "Finish session"}
        </Button>
      </div>
    </Dialog>
  );
}

export function PracticeNavigationDialog({
  questionMap,
  error,
  itemIds,
  status,
  navFilter,
  setNavFilter,
  flagged,
  uncertain,
  omissions,
  incorrectIds,
  responses,
  submitting,
  position,
  onClose,
  onJump,
}: {
  questionMap: ReactNode;
  error?: Error;
  itemIds: string[];
  status: Status;
  navFilter: string;
  setNavFilter: (filter: string) => void;
  flagged: boolean;
  uncertain: boolean;
  omissions: ReadonlySet<number>;
  incorrectIds: ReadonlySet<string>;
  responses: Responses;
  submitting: boolean;
  position: number;
  onClose: () => void;
  onJump: (index: number) => Promise<void>;
}) {
  return questionMap ? (
    <Dialog title="Question navigation" onClose={onClose}>
      {questionMap}
      <ErrorNotice error={error} />
    </Dialog>
  ) : (
    <Dialog title="Card navigation" onClose={onClose}>
      <Tabs
        label="Navigation filter"
        value={navFilter}
        onChange={setNavFilter}
        tabs={[
          { value: "all", label: "All" },
          {
            value: "unanswered",
            label: "Unreviewed",
          },
          ...(status === "completed"
            ? [{ value: "mistakes", label: "Needs review" }]
            : []),
          ...(flagged ? [{ value: "flagged", label: "Flagged" }] : []),
          ...(uncertain
            ? [{ value: "uncertain", label: "Low confidence" }]
            : []),
        ]}
      />
      <div
        className="question-nav"
        role="tabpanel"
        id={`navigation-filter-${navFilter}`}
        aria-label="Filtered items"
      >
        {itemIds.map((id, i) =>
          navFilter === "all" ||
          (navFilter === "unanswered" && omissions.has(i)) ||
          (navFilter === "mistakes" && incorrectIds.has(id)) ||
          (navFilter === "flagged" && own(responses, id)?.flagged) ||
          (navFilter === "uncertain" &&
            own(responses, id)?.confidence === "low") ? (
            <Button
              disabled={submitting}
              className={i === position ? "selected" : ""}
              key={id}
              onClick={() => void onJump(i)}
            >
              {i + 1} · {own(responses, id)?.rating ? "Rated" : "Unreviewed"}
            </Button>
          ) : null,
        )}
      </div>
    </Dialog>
  );
}

export function PracticeRecoveryDialog({
  checkpoint,
  attempt,
  error,
  onRestore,
  onDiscard,
  onClose,
  onDownload,
}: {
  checkpoint: PracticeCheckpoint;
  attempt: Attempt;
  error?: Error;
  onRestore: (checkpoint: PracticeCheckpoint, replace: boolean) => void;
  onDiscard: (checkpoint: PracticeCheckpoint) => void;
  onClose: () => void;
  onDownload: (checkpoint: PracticeCheckpoint) => void;
}) {
  const plan = planPracticeRecovery(checkpoint, attempt);
  const conflicts = plan.conflictCount || plan.positionConflict;
  const hasSafe =
    plan.safeCount > 0 || (plan.hasPosition && !plan.positionConflict);
  return (
    <Dialog title="Restore practice progress?" onClose={onClose}>
      <p>
        There are unsaved changes from{" "}
        {new Date(checkpoint.updatedAt).toLocaleString()}.
      </p>
      {plan.staleStatus ? (
        <Notice tone="warning">
          This attempt moved to a new stage after the checkpoint was saved.
          Download the local copy to keep these changes for reference.
        </Notice>
      ) : conflicts ? (
        <Notice tone="warning">
          {plan.conflictCount
            ? `Another save changed ${plan.conflictCount} of the same items. `
            : ""}
          {plan.positionConflict
            ? "It also recorded a different study position. "
            : ""}
          You can keep the newer saved changes or replace them with your local
          copy.
        </Notice>
      ) : null}
      <ErrorNotice error={error} />
      <div className="actions">
        {!plan.staleStatus && hasSafe ? (
          <Button
            variant="primary"
            onClick={() => onRestore(checkpoint, false)}
          >
            {conflicts
              ? "Restore without replacing newer changes"
              : "Restore progress"}
          </Button>
        ) : null}
        {!plan.staleStatus && conflicts ? (
          <Button onClick={() => onRestore(checkpoint, true)}>
            Restore and replace newer changes
          </Button>
        ) : null}
        <Button onClick={() => onDownload(checkpoint)}>
          Download recovery copy
        </Button>
        <Button variant="quiet" onClick={() => onDiscard(checkpoint)}>
          Discard recovery copy
        </Button>
      </div>
    </Dialog>
  );
}
