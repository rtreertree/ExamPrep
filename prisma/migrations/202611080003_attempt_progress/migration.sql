ALTER TABLE "Attempt" ADD COLUMN "snapshotVersion" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "progressContent" JSONB;

-- Trusted scoring metadata is immutable after its validated creation/legacy upgrade.
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_snapshot_version" CHECK (
  ("snapshotVersion" = 0 AND "progressContent" IS NULL)
  OR ("snapshotVersion" = 1 AND "progressContent" IS NOT NULL)
);
CREATE FUNCTION protect_attempt_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."snapshotVersion" = 1 AND (
    NEW."snapshotVersion" <> OLD."snapshotVersion"
    OR NEW."progressContent" IS DISTINCT FROM OLD."progressContent"
  ) THEN RAISE EXCEPTION 'Attempt scoring metadata is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Attempt_rules_integrity" BEFORE UPDATE ON "Attempt"
  FOR EACH ROW EXECUTE FUNCTION protect_attempt_rules();
CREATE INDEX "Attempt_continuation" ON "Attempt" ("userId", "studySetId", "updatedAt" DESC, id)
  WHERE status IN ('in_progress', 'reviewing');
