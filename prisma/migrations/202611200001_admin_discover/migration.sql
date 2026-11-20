ALTER TABLE "user" ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin')), ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT false;
UPDATE "user" SET name = 'Student' WHERE name IS NULL OR name ~ '^[[:space:]]*$';
ALTER TABLE "StudySet" ADD COLUMN published BOOLEAN NOT NULL DEFAULT false;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX user_name_search ON "user" USING gin (name gin_trgm_ops);
CREATE INDEX user_email_search ON "user" USING gin (email gin_trgm_ops);
CREATE INDEX study_set_title_search ON "StudySet" USING gin (title gin_trgm_ops);
CREATE INDEX "user_role_suspended_id_idx" ON "user"(role, suspended, id);
CREATE INDEX "user_suspended_id_idx" ON "user"(suspended, id);
CREATE INDEX "StudySet_published_kind_id_idx" ON "StudySet"(published, kind, id);
CREATE INDEX "StudySet_published_id_idx" ON "StudySet"(published, id);
CREATE INDEX "StudySet_userId_id_idx" ON "StudySet"("userId", id);
CREATE INDEX "StudySetCoOwner_userId_studySetId_idx" ON "StudySetCoOwner"("userId", "studySetId");

-- Serialize session insertion with a concurrent suspension and session revocation.
CREATE FUNCTION require_active_session_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM "user" WHERE id = NEW."userId" AND NOT suspended FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session requires an active account'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER require_active_session BEFORE INSERT ON session
  FOR EACH ROW EXECUTE FUNCTION require_active_session_account();
