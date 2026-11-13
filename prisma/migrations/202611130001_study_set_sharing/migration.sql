-- CreateTable
CREATE TABLE "StudySetCoOwner" (
    "studySetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "course" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "lastStudiedAt" TIMESTAMP(3),
    "reviewLimit" INTEGER NOT NULL DEFAULT 20,

    CONSTRAINT "StudySetCoOwner_pkey" PRIMARY KEY ("studySetId","userId")
);

-- CreateTable
CREATE TABLE "CoOwnerCardReview" (
    "studySetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "streak" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "attemptStartedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoOwnerCardReview_pkey" PRIMARY KEY ("studySetId","userId","cardId")
);

-- CreateTable
CREATE TABLE "StudySetInvitation" (
    "id" TEXT NOT NULL,
    "studySetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudySetInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudySetCopyLink" (
    "studySetId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,

    CONSTRAINT "StudySetCopyLink_pkey" PRIMARY KEY ("studySetId")
);

-- CreateTable
CREATE TABLE "StudySetCopyImport" (
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "linkNonce" TEXT NOT NULL,
    "copyId" TEXT,

    CONSTRAINT "StudySetCopyImport_pkey" PRIMARY KEY ("userId","requestId")
);

-- CreateIndex
CREATE INDEX "StudySetCoOwner_userId_archived_pinned_lastStudiedAt_idx" ON "StudySetCoOwner"("userId", "archived", "pinned", "lastStudiedAt");

-- CreateIndex
CREATE INDEX "StudySetInvitation_userId_createdAt_idx" ON "StudySetInvitation"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudySetInvitation_studySetId_userId_key" ON "StudySetInvitation"("studySetId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudySetCopyLink_nonce_key" ON "StudySetCopyLink"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "StudySetCopyImport_copyId_key" ON "StudySetCopyImport"("copyId");

-- AddForeignKey
ALTER TABLE "StudySetCoOwner" ADD CONSTRAINT "StudySetCoOwner_studySetId_fkey" FOREIGN KEY ("studySetId") REFERENCES "StudySet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySetCoOwner" ADD CONSTRAINT "StudySetCoOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoOwnerCardReview" ADD CONSTRAINT "CoOwnerCardReview_studySetId_userId_fkey" FOREIGN KEY ("studySetId", "userId") REFERENCES "StudySetCoOwner"("studySetId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySetInvitation" ADD CONSTRAINT "StudySetInvitation_studySetId_fkey" FOREIGN KEY ("studySetId") REFERENCES "StudySet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySetInvitation" ADD CONSTRAINT "StudySetInvitation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySetCopyLink" ADD CONSTRAINT "StudySetCopyLink_studySetId_fkey" FOREIGN KEY ("studySetId") REFERENCES "StudySet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySetCopyImport" ADD CONSTRAINT "StudySetCopyImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudySetCopyImport" ADD CONSTRAINT "StudySetCopyImport_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "StudySet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Permit a new attempt to reference a set the student co-owns.
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
    IF NEW."studySetId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "StudySet" s WHERE s.id = NEW."studySetId"
      AND (s."userId" = NEW."userId" OR EXISTS (
        SELECT 1 FROM "StudySetCoOwner" co
        WHERE co."studySetId" = s.id AND co."userId" = NEW."userId"
      ))
    ) THEN RAISE EXCEPTION 'Source ownership mismatch'; END IF;
    IF NEW."sourceAttemptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Attempt" WHERE id = NEW."sourceAttemptId" AND "userId" = NEW."userId" AND status = 'completed') THEN RAISE EXCEPTION 'Retry ownership/state mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
