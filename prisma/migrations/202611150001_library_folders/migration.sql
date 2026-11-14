BEGIN;

CREATE SEQUENCE "library_manual_rank_seq";

CREATE TABLE "LibraryFolder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manualRank" BIGINT NOT NULL DEFAULT nextval('library_manual_rank_seq'::regclass),
    CONSTRAINT "LibraryFolder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LibraryFolder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LibraryFolder_userId_id_key" ON "LibraryFolder"("userId", "id");
CREATE UNIQUE INDEX "LibraryFolder_userId_name_key" ON "LibraryFolder"("userId", "name");

ALTER TABLE "StudySet" ADD COLUMN "folderId" TEXT,
  ADD COLUMN "manualRank" BIGINT;
ALTER TABLE "StudySetCoOwner" ADD COLUMN "folderId" TEXT,
  ADD COLUMN "manualRank" BIGINT;

INSERT INTO "LibraryFolder" ("id", "userId", "name")
SELECT gen_random_uuid()::text, "userId", course FROM (
    SELECT "userId", course FROM "StudySet" WHERE course <> ''
    UNION
    SELECT "userId", course FROM "StudySetCoOwner" WHERE course <> ''
) folders ORDER BY "userId", lower(course), course;

WITH settings AS (
    SELECT "userId", id, course, archived, pinned, "updatedAt", false AS "coOwned" FROM "StudySet"
    UNION ALL
    SELECT co."userId", co."studySetId", co.course, co.archived, co.pinned, s."updatedAt", true
    FROM "StudySetCoOwner" co JOIN "StudySet" s ON s.id = co."studySetId"
), ranked AS MATERIALIZED (
    SELECT settings.*, f.id AS "folderId",
      nextval('library_manual_rank_seq'::regclass) AS rank
    FROM settings LEFT JOIN "LibraryFolder" f ON f."userId" = settings."userId" AND f.name = settings.course
    ORDER BY settings."userId", f.id, archived, pinned DESC, "updatedAt" DESC, settings.id
), primary_sets AS (
    UPDATE "StudySet" s SET "folderId" = ranked."folderId", "manualRank" = ranked.rank
    FROM ranked WHERE NOT ranked."coOwned" AND s.id = ranked.id
)
UPDATE "StudySetCoOwner" co SET "folderId" = ranked."folderId", "manualRank" = ranked.rank
FROM ranked WHERE ranked."coOwned" AND co."studySetId" = ranked.id AND co."userId" = ranked."userId";

ALTER TABLE "StudySet" ALTER COLUMN "manualRank" SET NOT NULL,
  ALTER COLUMN "manualRank" SET DEFAULT nextval('library_manual_rank_seq'::regclass),
  ADD CONSTRAINT "StudySet_userId_folderId_fkey" FOREIGN KEY ("userId", "folderId") REFERENCES "LibraryFolder"("userId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "StudySetCoOwner" ALTER COLUMN "manualRank" SET NOT NULL,
  ALTER COLUMN "manualRank" SET DEFAULT nextval('library_manual_rank_seq'::regclass),
  ADD CONSTRAINT "StudySetCoOwner_userId_folderId_fkey" FOREIGN KEY ("userId", "folderId") REFERENCES "LibraryFolder"("userId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "StudySet_userId_folderId_archived_manualRank_idx" ON "StudySet"("userId", "folderId", "archived", "manualRank");
CREATE INDEX "StudySetCoOwner_userId_folderId_archived_manualRank_idx" ON "StudySetCoOwner"("userId", "folderId", "archived", "manualRank");

COMMIT;
