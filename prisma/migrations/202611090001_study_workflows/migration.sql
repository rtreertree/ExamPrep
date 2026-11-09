ALTER TABLE "StudySet"
  ADD COLUMN "course" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastStudiedAt" TIMESTAMP(3),
  ADD COLUMN "reviewLimit" INTEGER NOT NULL DEFAULT 20;

ALTER TABLE "Attempt"
  ADD COLUMN "studySetRevision" INTEGER,
  ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "reviewMode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fullSet" BOOLEAN NOT NULL DEFAULT true;

-- Previous rows have no reliable source content revision. Keep those snapshots
-- resumable and exclude them from revision-specific score comparisons.
UPDATE "Attempt" SET "fullSet" = false WHERE "sourceAttemptId" IS NOT NULL;
UPDATE "StudySet" AS s
SET "lastStudiedAt" = a."lastStudiedAt"
FROM (
  SELECT "studySetId", MAX("startedAt") AS "lastStudiedAt"
  FROM "Attempt" WHERE "studySetId" IS NOT NULL GROUP BY "studySetId"
) AS a
WHERE s.id = a."studySetId";

CREATE TABLE "CardReview" (
  "studySetId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "streak" INTEGER NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "attemptStartedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CardReview_pkey" PRIMARY KEY ("studySetId", "cardId"),
  CONSTRAINT "CardReview_studySetId_fkey" FOREIGN KEY ("studySetId")
    REFERENCES "StudySet"(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "StudySet_userId_archived_pinned_lastStudiedAt_idx"
  ON "StudySet"("userId", "archived", "pinned", "lastStudiedAt");
CREATE INDEX "Attempt_studySetId_reviewMode_completedAt_idx"
  ON "Attempt"("studySetId", "reviewMode", "completedAt");

-- Only personal annotations may change after completion. Annotation-only rows
-- are equivalent to an unanswered item for the frozen response comparison.
CREATE FUNCTION attempt_graded_responses(response_data JSONB) RETURNS JSONB
LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT COALESCE(jsonb_object_agg(key, fields), '{}'::jsonb)
  FROM (
    SELECT key, value - ARRAY['flagged', 'confidence', 'note'] AS fields
    FROM jsonb_each(response_data)
  ) AS graded
  WHERE fields <> '{}'::jsonb;
$$;

CREATE OR REPLACE FUNCTION protect_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW."userId" <> OLD."userId" OR NEW."startedAt" <> OLD."startedAt"
      OR NEW.settings IS DISTINCT FROM OLD.settings OR NEW."studySetRevision" IS DISTINCT FROM OLD."studySetRevision"
      OR NEW."reviewMode" <> OLD."reviewMode" OR NEW."fullSet" <> OLD."fullSet" THEN
      RAISE EXCEPTION 'Attempt snapshot, settings and ownership are immutable';
    END IF;
    IF NEW."studySetId" IS DISTINCT FROM OLD."studySetId" AND NEW."studySetId" IS NOT NULL THEN RAISE EXCEPTION 'Attempt source is immutable'; END IF;
    IF NEW."sourceAttemptId" IS DISTINCT FROM OLD."sourceAttemptId" AND NEW."sourceAttemptId" IS NOT NULL THEN RAISE EXCEPTION 'Retry source is immutable'; END IF;
    IF OLD.status = 'completed' THEN
      IF NEW.status <> OLD.status OR NEW.result IS DISTINCT FROM OLD.result OR NEW.position <> OLD.position
        OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
        RAISE EXCEPTION 'Completed scores and status are read-only';
      END IF;
      IF NEW.responses IS DISTINCT FROM OLD.responses THEN
        IF NEW.revision <> OLD.revision + 1 OR attempt_graded_responses(NEW.responses) IS DISTINCT FROM attempt_graded_responses(OLD.responses) THEN
          RAISE EXCEPTION 'Completed answers are read-only';
        END IF;
      ELSIF NEW.revision <> OLD.revision THEN
        RAISE EXCEPTION 'Completed revision requires an annotation change';
      END IF;
    END IF;
    IF OLD.status = 'reviewing' AND NEW.status = 'in_progress' THEN RAISE EXCEPTION 'Invalid attempt transition'; END IF;
  ELSE
    IF NEW."studySetId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StudySet" WHERE id = NEW."studySetId" AND "userId" = NEW."userId") THEN RAISE EXCEPTION 'Source ownership mismatch'; END IF;
    IF NEW."sourceAttemptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Attempt" WHERE id = NEW."sourceAttemptId" AND "userId" = NEW."userId" AND status = 'completed') THEN RAISE EXCEPTION 'Retry ownership/state mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
