BEGIN;
-- Run with writers paused. A busy database or overlong backfill must roll back.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE "user", "LibraryFolder", "StudySet", "StudySetCopyLink", "StudySetCoOwner",
  "StudySetViewer", "CardReview", "CoOwnerCardReview", "ViewerCardReview",
  "StudySetCopyImport", "Attempt" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE "LibraryEntry" (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "studySetId" text NOT NULL REFERENCES "StudySet"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "folderId" text,
  "manualRank" bigint NOT NULL DEFAULT nextval('library_manual_rank_seq'),
  pinned boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  "lastStudiedAt" timestamp(3),
  "reviewLimit" integer NOT NULL DEFAULT 20,
  "coOwner" boolean NOT NULL DEFAULT false,
  discovered boolean NOT NULL DEFAULT false,
  "linkNonce" text,
  PRIMARY KEY ("userId", "studySetId"),
  FOREIGN KEY ("userId", "folderId") REFERENCES "LibraryFolder" ("userId", id) ON UPDATE CASCADE
);
CREATE INDEX ON "LibraryEntry" ("studySetId", "userId");
CREATE INDEX ON "LibraryEntry" ("userId", archived, pinned, "lastStudiedAt");
CREATE INDEX ON "LibraryEntry" ("userId", "folderId", archived, "manualRank");

ALTER TABLE "CardReview" RENAME TO "LegacyCardReview";
CREATE TABLE "CardReview" (
  "userId" text NOT NULL,
  "studySetId" text NOT NULL,
  "cardId" text NOT NULL,
  fingerprint text NOT NULL,
  streak integer NOT NULL,
  "dueAt" timestamp(3) NOT NULL,
  "attemptStartedAt" timestamp(3) NOT NULL,
  CONSTRAINT "CardReview_entry_pkey" PRIMARY KEY ("userId", "studySetId", "cardId"),
  CONSTRAINT "CardReview_entry_fkey" FOREIGN KEY ("userId", "studySetId")
    REFERENCES "LibraryEntry" ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CardReview_valid_schedule" CHECK (streak BETWEEN 0 AND 5 AND isfinite("dueAt")
    AND isfinite("attemptStartedAt") AND "dueAt" >= "attemptStartedAt")
);

CREATE TEMP TABLE expected_library_entries ON COMMIT DROP AS
  SELECT "userId", id AS "studySetId", "folderId", "manualRank", pinned, archived, "lastStudiedAt", "reviewLimit",
    false AS "coOwner", false AS discovered, NULL::text AS "linkNonce" FROM "StudySet"
  UNION ALL
  SELECT "userId", "studySetId", "folderId", "manualRank", pinned, archived, "lastStudiedAt", "reviewLimit",
    true, false, NULL FROM "StudySetCoOwner"
  UNION ALL
  SELECT "userId", "studySetId", "folderId", "manualRank", pinned, archived, "lastStudiedAt", "reviewLimit",
    false, discovered, "linkNonce" FROM "StudySetViewer";
CREATE TEMP TABLE expected_card_reviews ON COMMIT DROP AS
  SELECT s."userId", r."studySetId", r."cardId", r.fingerprint, r.streak, r."dueAt", r."attemptStartedAt"
    FROM "LegacyCardReview" r JOIN "StudySet" s ON s.id = r."studySetId"
  UNION ALL
  SELECT "userId", "studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt" FROM "CoOwnerCardReview"
  UNION ALL
  SELECT "userId", "studySetId", "cardId", fingerprint, streak, "dueAt", "attemptStartedAt" FROM "ViewerCardReview";

INSERT INTO "LibraryEntry" SELECT * FROM expected_library_entries;
INSERT INTO "CardReview" SELECT * FROM expected_card_reviews;

DO $$ BEGIN
  IF EXISTS ((TABLE expected_library_entries EXCEPT ALL TABLE "LibraryEntry")
             UNION ALL (TABLE "LibraryEntry" EXCEPT ALL TABLE expected_library_entries))
    OR EXISTS ((TABLE expected_card_reviews EXCEPT ALL TABLE "CardReview")
               UNION ALL (TABLE "CardReview" EXCEPT ALL TABLE expected_card_reviews)) THEN
    RAISE EXCEPTION 'Library cutover backfill did not reconcile';
  END IF;
END $$;

-- The deferred FK makes an owner entry mandatory while allowing set deletion
-- and its entry's cascading deletion in the same transaction.
ALTER TABLE "StudySet" ADD CONSTRAINT "StudySet_userId_id_key" UNIQUE ("userId", id);
DROP INDEX "StudySet_userId_id_idx";
ALTER TABLE "StudySet" ADD CONSTRAINT "StudySet_owner_entry_fkey"
  FOREIGN KEY ("userId", id) REFERENCES "LibraryEntry" ("userId", "studySetId")
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION create_primary_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "LibraryEntry" ("userId", "studySetId") VALUES (NEW."userId", NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER create_primary_entry AFTER INSERT ON "StudySet"
  FOR EACH ROW EXECUTE FUNCTION create_primary_entry();

CREATE FUNCTION study_set_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'Study set ownership is immutable';
  END IF;
  NEW.title := NEW.content->>'title';
  NEW.kind := NEW.content->>'kind';
  RETURN NEW;
END $$;
CREATE TRIGGER study_set_metadata BEFORE INSERT OR UPDATE OF content, title, kind, "userId" ON "StudySet"
  FOR EACH ROW EXECUTE FUNCTION study_set_metadata();

CREATE FUNCTION check_library_entry_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW."coOwner" OR NEW.discovered OR NEW."linkNonce" IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM "StudySet" WHERE id = NEW."studySetId" AND "userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'Library entry requires access';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_library_entry_grants BEFORE INSERT OR UPDATE OF "coOwner", discovered, "linkNonce", "userId", "studySetId"
  ON "LibraryEntry" FOR EACH ROW EXECUTE FUNCTION check_library_entry_grants();

CREATE FUNCTION revoke_library_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Set deletion cascades to entries. The link cascade may run first.
  IF NOT EXISTS (SELECT 1 FROM "StudySet" WHERE id = OLD."studySetId") THEN
    RETURN OLD;
  END IF;
  DELETE FROM "LibraryEntry" e USING "StudySet" s WHERE s.id = OLD."studySetId"
    AND e."studySetId" = s.id AND e."linkNonce" = OLD.nonce
    AND NOT (e.discovered OR e."coOwner" OR e."userId" = s."userId");
  UPDATE "LibraryEntry" SET "linkNonce" = NULL
    WHERE "studySetId" = OLD."studySetId" AND "linkNonce" = OLD.nonce;
  RETURN OLD;
END $$;
CREATE TRIGGER revoke_library_link AFTER DELETE ON "StudySetCopyLink"
  FOR EACH ROW EXECUTE FUNCTION revoke_library_link();

CREATE FUNCTION revoke_library_discover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "LibraryEntry" WHERE "studySetId" = NEW.id AND discovered
    AND NOT ("coOwner" OR "linkNonce" IS NOT NULL OR "userId" = NEW."userId");
  UPDATE "LibraryEntry" SET discovered = false WHERE "studySetId" = NEW.id AND discovered;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_library_discover AFTER UPDATE OF published ON "StudySet"
  FOR EACH ROW WHEN (OLD.published AND NOT NEW.published) EXECUTE FUNCTION revoke_library_discover();

CREATE FUNCTION detach_library_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Attempt" SET "studySetId" = NULL
    WHERE "studySetId" = OLD."studySetId" AND "userId" = OLD."userId";
  RETURN OLD;
END $$;
CREATE TRIGGER detach_library_attempts AFTER DELETE ON "LibraryEntry"
  FOR EACH ROW EXECUTE FUNCTION detach_library_attempts();

-- Disable legacy writers while keeping their data available for reconciliation.
ALTER TABLE "StudySetCopyLink" DISABLE TRIGGER revoke_link_viewers;
ALTER TABLE "StudySet" DISABLE TRIGGER revoke_discover_viewers;
ALTER TABLE "StudySet" DISABLE TRIGGER capture_legacy_keyed_creation;
ALTER TABLE "StudySetCoOwner" DISABLE TRIGGER promote_viewer;
ALTER TABLE "StudySetViewer" DISABLE TRIGGER detach_viewer_attempts;
ALTER TABLE "StudySet" DROP CONSTRAINT "StudySet_userId_folderId_fkey";
ALTER TABLE "StudySetCoOwner" DROP CONSTRAINT "StudySetCoOwner_userId_folderId_fkey";
ALTER TABLE "StudySetViewer" DROP CONSTRAINT "StudySetViewer_userId_folderId_fkey";

ALTER TABLE "StudySetOperation" ADD COLUMN "resultRevision" integer;

-- Catch requests made by the old application between the first migration and its rollout.
INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId")
SELECT "userId", id, 'legacy-create', "contentFingerprint", id
FROM "StudySet" WHERE id ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;
INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId")
SELECT "userId", "requestId", 'copy', regexp_replace("linkNonce", '^editable:', ''), "copyId"
FROM "StudySetCopyImport"
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION protect_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE converting boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."studySetId" IS DISTINCT FROM OLD."studySetId" AND NEW."studySetId" IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM "CloneConversion" c WHERE c."copyId"=OLD."studySetId"
        AND c."sourceId"=NEW."studySetId" AND c."userId"=OLD."userId"
        AND c."convertedAt" IS NOT NULL AND NEW."studySetRevision" IS NULL) INTO converting;
      IF NOT converting THEN RAISE EXCEPTION 'Attempt source is immutable'; END IF;
    END IF;
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW."userId" <> OLD."userId" OR NEW."startedAt" <> OLD."startedAt"
      OR NEW.settings IS DISTINCT FROM OLD.settings OR (NOT converting AND NEW."studySetRevision" IS DISTINCT FROM OLD."studySetRevision")
      OR NEW."reviewMode" <> OLD."reviewMode" OR NEW."fullSet" <> OLD."fullSet" THEN
      RAISE EXCEPTION 'Attempt snapshot, settings and ownership are immutable';
    END IF;
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
    IF NEW."studySetId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "LibraryEntry" e
      WHERE e."studySetId" = NEW."studySetId" AND e."userId" = NEW."userId"
    ) THEN RAISE EXCEPTION 'Source ownership mismatch'; END IF;
    IF NEW."sourceAttemptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Attempt" WHERE id = NEW."sourceAttemptId" AND "userId" = NEW."userId" AND status = 'completed') THEN RAISE EXCEPTION 'Retry ownership/state mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP VIEW "LibraryMembership";

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'examprep_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "LibraryEntry" TO examprep_runtime;
    GRANT SELECT, INSERT, UPDATE ON "CardReview" TO examprep_runtime;
    REVOKE ALL ON "LegacyCardReview", "ViewerCardReview", "CoOwnerCardReview",
      "StudySetViewer", "StudySetCoOwner", "StudySetCopyImport" FROM examprep_runtime;
  END IF;
END $$;

COMMIT;
