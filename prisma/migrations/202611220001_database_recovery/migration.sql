BEGIN;

ALTER TABLE "CloneConversion" ADD COLUMN "restoredCopyId" TEXT;

ALTER TABLE "CardReview" ADD CONSTRAINT "CardReview_schedule_integrity"
  CHECK (streak BETWEEN 0 AND 5 AND isfinite("dueAt") AND isfinite("attemptStartedAt")
    AND "dueAt" >= "attemptStartedAt");
ALTER TABLE "CoOwnerCardReview" ADD CONSTRAINT "CoOwnerCardReview_schedule_integrity"
  CHECK (streak BETWEEN 0 AND 5 AND isfinite("dueAt") AND isfinite("attemptStartedAt")
    AND "dueAt" >= "attemptStartedAt");
ALTER TABLE "ViewerCardReview" ADD CONSTRAINT "ViewerCardReview_schedule_integrity"
  CHECK (streak BETWEEN 0 AND 5 AND isfinite("dueAt") AND isfinite("attemptStartedAt")
    AND "dueAt" >= "attemptStartedAt");

COMMIT;
