ALTER TABLE "StudySetCopyLink" ADD COLUMN "guestAccess" boolean NOT NULL DEFAULT false;

CREATE TABLE "StudySetViewer" (
  "studySetId" text NOT NULL REFERENCES "StudySet"(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "linkNonce" text,
  discovered boolean NOT NULL DEFAULT false,
  course text NOT NULL DEFAULT '',
  "folderId" text,
  "manualRank" bigint NOT NULL DEFAULT nextval('library_manual_rank_seq'),
  pinned boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  "lastStudiedAt" timestamp(3),
  "reviewLimit" integer NOT NULL DEFAULT 20,
  PRIMARY KEY ("studySetId","userId"),
  FOREIGN KEY ("userId","folderId") REFERENCES "LibraryFolder"("userId",id),
  CHECK ("linkNonce" IS NOT NULL OR discovered)
);
CREATE INDEX ON "StudySetViewer" ("userId","studySetId");
CREATE INDEX ON "StudySetViewer" ("userId",archived,pinned,"lastStudiedAt");
CREATE INDEX ON "StudySetViewer" ("userId","folderId",archived,"manualRank");
CREATE TABLE "ViewerCardReview" (
  "studySetId" text NOT NULL, "userId" text NOT NULL, "cardId" text NOT NULL,
  fingerprint text NOT NULL, streak integer NOT NULL, "dueAt" timestamp(3) NOT NULL,
  "attemptStartedAt" timestamp(3) NOT NULL,
  PRIMARY KEY ("studySetId","userId","cardId"),
  FOREIGN KEY ("studySetId","userId") REFERENCES "StudySetViewer" ON DELETE CASCADE
);

CREATE VIEW "LibraryMembership" AS
 SELECT "studySetId","userId",course,"folderId","manualRank",pinned,archived,"lastStudiedAt","reviewLimit",'co_owner'::text AS role FROM "StudySetCoOwner"
 UNION ALL
 SELECT "studySetId","userId",course,"folderId","manualRank",pinned,archived,"lastStudiedAt","reviewLimit",'viewer'::text FROM "StudySetViewer";

CREATE TABLE "CloneConversion" (
  "copyId" text PRIMARY KEY, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, "sourceId" text, recovery jsonb, "convertedAt" timestamp(3)
);
CREATE INDEX ON "CloneConversion" ("userId","sourceId");
-- Capture the pre-release inventory. Copies deliberately created with the new UI are independent.
INSERT INTO "CloneConversion" ("copyId","userId") SELECT id,"userId" FROM "StudySet";

CREATE FUNCTION inventory_legacy_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."copyId" IS NOT NULL AND NEW."linkNonce" NOT LIKE 'editable:%' THEN
   INSERT INTO "CloneConversion" ("copyId","userId") VALUES (NEW."copyId",NEW."userId") ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER track_legacy_copy AFTER INSERT OR UPDATE OF "copyId" ON "StudySetCopyImport"
 FOR EACH ROW EXECUTE FUNCTION inventory_legacy_copy();
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
      SELECT 1 FROM "StudySet" s WHERE s.id = NEW."studySetId"
      AND (s."userId" = NEW."userId" OR EXISTS (
        SELECT 1 FROM "LibraryMembership" co
        WHERE co."studySetId" = s.id AND co."userId" = NEW."userId"
      ))
    ) THEN RAISE EXCEPTION 'Source ownership mismatch'; END IF;
    IF NEW."sourceAttemptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Attempt" WHERE id = NEW."sourceAttemptId" AND "userId" = NEW."userId" AND status = 'completed') THEN RAISE EXCEPTION 'Retry ownership/state mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Revoke exactly the grant that disappeared, including changes made by older admin clients.
CREATE FUNCTION revoke_link_viewers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM "StudySetViewer" WHERE "studySetId" = OLD."studySetId" AND "linkNonce" = OLD.nonce AND NOT discovered;
 UPDATE "StudySetViewer" SET "linkNonce" = NULL WHERE "studySetId" = OLD."studySetId" AND "linkNonce" = OLD.nonce;
 RETURN OLD;
END $$;
CREATE TRIGGER revoke_link_viewers AFTER DELETE ON "StudySetCopyLink" FOR EACH ROW EXECUTE FUNCTION revoke_link_viewers();

CREATE FUNCTION revoke_discover_viewers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM "StudySetViewer" WHERE "studySetId" = NEW.id AND discovered AND "linkNonce" IS NULL;
 UPDATE "StudySetViewer" SET discovered = false WHERE "studySetId" = NEW.id AND discovered;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_discover_viewers AFTER UPDATE OF published ON "StudySet" FOR EACH ROW
 WHEN (OLD.published AND NOT NEW.published) EXECUTE FUNCTION revoke_discover_viewers();

CREATE FUNCTION promote_viewer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE "StudySetCoOwner" co SET course=v.course, "folderId"=v."folderId", pinned=v.pinned,
 archived=v.archived, "manualRank"=v."manualRank", "lastStudiedAt"=v."lastStudiedAt", "reviewLimit"=v."reviewLimit"
 FROM "StudySetViewer" v WHERE (v."studySetId",v."userId")=(NEW."studySetId",NEW."userId")
 AND (co."studySetId",co."userId")=(v."studySetId",v."userId");
 INSERT INTO "CoOwnerCardReview" ("studySetId","userId","cardId",fingerprint,streak,"dueAt","attemptStartedAt")
 SELECT "studySetId","userId","cardId",fingerprint,streak,"dueAt","attemptStartedAt" FROM "ViewerCardReview"
 WHERE "studySetId"=NEW."studySetId" AND "userId"=NEW."userId";
 DELETE FROM "StudySetViewer" WHERE "studySetId"=NEW."studySetId" AND "userId"=NEW."userId";
 RETURN NEW;
END $$;
CREATE TRIGGER promote_viewer AFTER INSERT ON "StudySetCoOwner" FOR EACH ROW EXECUTE FUNCTION promote_viewer();

CREATE FUNCTION detach_viewer_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "StudySetCoOwner" WHERE "studySetId"=OLD."studySetId" AND "userId"=OLD."userId") THEN
   UPDATE "Attempt" SET "studySetId"=NULL WHERE "studySetId"=OLD."studySetId" AND "userId"=OLD."userId";
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER detach_viewer_attempts AFTER DELETE ON "StudySetViewer" FOR EACH ROW EXECUTE FUNCTION detach_viewer_attempts();

-- The first successful release runs the historical conversion after its public smoke check.
CREATE TABLE "LiveSetCutover" (
  id integer PRIMARY KEY CHECK (id = 1),
  "completedAt" timestamp(3)
);
INSERT INTO "LiveSetCutover" (id) VALUES (1);
