BEGIN;

CREATE FUNCTION study_content_fingerprint(document jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT encode(sha256(convert_to(document::text, 'UTF8')), 'hex') $$;

ALTER TABLE "StudySet" ADD COLUMN "contentFingerprint" text GENERATED ALWAYS AS
  (study_content_fingerprint(content)) STORED NOT NULL;
CREATE INDEX "StudySet_userId_contentFingerprint_idx" ON "StudySet" ("userId", "contentFingerprint");

CREATE TABLE "StudySetOperation" (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "requestId" text NOT NULL,
  operation text NOT NULL,
  "inputIdentity" text NOT NULL,
  "setId" text,
  reused boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("userId", "requestId")
);
-- Receipts deliberately outlive their results. Keep both legacy ID namespaces:
-- keyed creation encoded the request as the set ID, while copies stored the key.
INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId")
SELECT "userId", id, 'legacy-create', "contentFingerprint", id
FROM "StudySet" WHERE id ~ '^[0-9a-f]{64}$';

-- The previous application can still serve during the additive rollout.
CREATE FUNCTION capture_legacy_keyed_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId")
  VALUES (NEW."userId", NEW.id, 'legacy-create', NEW."contentFingerprint", NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_legacy_keyed_creation AFTER INSERT ON "StudySet"
  FOR EACH ROW WHEN (NEW.id ~ '^[0-9a-f]{64}$') EXECUTE FUNCTION capture_legacy_keyed_creation();

INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId")
SELECT "userId", "requestId", 'copy', regexp_replace("linkNonce", '^editable:', ''), "copyId"
FROM "StudySetCopyImport";

CREATE TABLE "BackupSetRestore" (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "backupId" text NOT NULL,
  "sourceId" text NOT NULL,
  "setId" text NOT NULL,
  "contentFingerprint" text NOT NULL,
  "destinationRevision" integer NOT NULL,
  PRIMARY KEY ("userId", "backupId", "sourceId"),
  UNIQUE ("userId", "backupId", "setId")
);

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'examprep_runtime') THEN
    GRANT SELECT, INSERT ON "StudySetOperation", "BackupSetRestore" TO examprep_runtime;
  END IF;
END $$;

COMMIT;
