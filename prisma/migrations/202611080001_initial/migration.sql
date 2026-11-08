-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "rateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudySet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudySet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "studySetId" TEXT,
    "sourceAttemptId" TEXT,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "responses" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "rateLimit_key_key" ON "rateLimit"("key");

-- CreateIndex
CREATE INDEX "StudySet_userId_updatedAt_idx" ON "StudySet"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "Attempt_userId_startedAt_idx" ON "Attempt"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "Attempt_studySetId_idx" ON "Attempt"("studySetId");

-- CreateIndex
CREATE INDEX "Attempt_sourceAttemptId_idx" ON "Attempt"("sourceAttemptId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySet" ADD CONSTRAINT "StudySet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_studySetId_fkey" FOREIGN KEY ("studySetId") REFERENCES "StudySet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_sourceAttemptId_fkey" FOREIGN KEY ("sourceAttemptId") REFERENCES "Attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Defense in depth: snapshots, ownership, content metadata, and terminal state.
ALTER TABLE "StudySet" ADD CONSTRAINT "StudySet_metadata" CHECK (
  "kind" IN ('exam', 'flashcards') AND "revision" > 0
  AND content->>'kind' = "kind" AND content->>'title' = "title"
  AND content->>'schemaVersion' = '1'
);
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_state" CHECK (
  status IN ('in_progress', 'reviewing', 'completed') AND revision > 0 AND position >= 0
  AND position < COALESCE(jsonb_array_length(snapshot->'questions'), jsonb_array_length(snapshot->'cards'))
  AND ((status = 'completed') = ("completedAt" IS NOT NULL))
  AND ((status = 'in_progress') = (result IS NULL))
  AND (snapshot->>'kind' = 'exam' OR status <> 'reviewing')
);
CREATE FUNCTION protect_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW."userId" <> OLD."userId" OR NEW."startedAt" <> OLD."startedAt" THEN
      RAISE EXCEPTION 'Attempt snapshot and ownership are immutable';
    END IF;
    IF NEW."studySetId" IS DISTINCT FROM OLD."studySetId" AND NEW."studySetId" IS NOT NULL THEN RAISE EXCEPTION 'Attempt source is immutable'; END IF;
    IF NEW."sourceAttemptId" IS DISTINCT FROM OLD."sourceAttemptId" AND NEW."sourceAttemptId" IS NOT NULL THEN RAISE EXCEPTION 'Retry source is immutable'; END IF;
    IF OLD.status = 'completed' AND (NEW.status <> OLD.status OR NEW.responses IS DISTINCT FROM OLD.responses OR NEW.result IS DISTINCT FROM OLD.result OR NEW.position <> OLD.position OR NEW.revision <> OLD.revision OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt") THEN
      RAISE EXCEPTION 'Completed attempts are read-only';
    END IF;
    IF OLD.status = 'reviewing' AND NEW.status = 'in_progress' THEN RAISE EXCEPTION 'Invalid attempt transition'; END IF;
  ELSE
    IF NEW."studySetId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "StudySet" WHERE id = NEW."studySetId" AND "userId" = NEW."userId") THEN RAISE EXCEPTION 'Source ownership mismatch'; END IF;
    IF NEW."sourceAttemptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Attempt" WHERE id = NEW."sourceAttemptId" AND "userId" = NEW."userId" AND status = 'completed') THEN RAISE EXCEPTION 'Retry ownership/state mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Attempt_integrity" BEFORE INSERT OR UPDATE ON "Attempt" FOR EACH ROW EXECUTE FUNCTION protect_attempt();
