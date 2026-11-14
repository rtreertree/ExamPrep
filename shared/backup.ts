import { z } from "zod";
import {
  contentId,
  itemsOf,
  validateContent,
  type StudyContent,
} from "./content";
import {
  grade,
  practiceSettingsSchema,
  validateProgress,
  type Responses,
  type Result,
} from "./attempts";
import { ValidationError } from "./json";

const stamp = z.iso.datetime();
const archive = { schemaVersion: z.literal(1), backupId: z.uuid() };
const revision = z.number().int().min(1).max(2_147_483_647);
const folderEntry = z.strictObject({
  id: contentId,
  name: z.string().trim().min(1).max(100),
});
const setEntry = z.strictObject({
  id: contentId,
  content: z.unknown(),
  revision,
  course: z.string().trim().max(100),
  folderId: contentId.nullable().optional(),
  pinned: z.boolean(),
  archived: z.boolean(),
  reviewLimit: z.number().int().min(1).max(500),
  lastStudiedAt: stamp.nullable(),
  createdAt: stamp,
  updatedAt: stamp,
});
const attemptEntry = z.strictObject({
  id: contentId,
  studySetId: contentId.nullable(),
  studySetRevision: revision.nullable(),
  sourceAttemptId: contentId.nullable(),
  snapshot: z.unknown(),
  settings: practiceSettingsSchema,
  reviewMode: z.boolean(),
  fullSet: z.boolean(),
  responses: z.unknown(),
  result: z.unknown(),
  position: z.number().int().nonnegative(),
  status: z.enum(["in_progress", "reviewing", "completed"]),
  startedAt: stamp,
  updatedAt: stamp,
  completedAt: stamp.nullable(),
});
const reviewEntry = z.strictObject({
  studySetId: contentId,
  cardId: contentId,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  streak: z.number().int().min(0).max(5),
  dueAt: stamp,
  attemptStartedAt: stamp,
});
const backupSchema = z.strictObject({
  library: z.strictObject({
    ...archive,
    kind: z.literal("exam-prep-library"),
    folders: z.array(folderEntry).optional(),
    sets: z.array(setEntry),
  }),
  history: z
    .strictObject({
      ...archive,
      kind: z.literal("exam-prep-history"),
      attempts: z.array(attemptEntry),
      reviews: z.array(reviewEntry),
    })
    .optional(),
});

function invalid(path: string, message: string): never {
  throw new ValidationError([{ path, message }]);
}
function validateAt<T>(path: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ValidationError)
      throw new ValidationError(
        error.issues.map((issue) => ({
          path: path + (issue.path === "/" ? "" : issue.path),
          message: issue.message,
        })),
      );
    throw error;
  }
}
function byId<T extends { id: string }>(rows: T[], path: string) {
  const index = new Map<string, T>();
  rows.forEach((row, i) => {
    if (index.has(row.id)) invalid(`${path}/${i}/id`, "Duplicate entry ID.");
    index.set(row.id, row);
  });
  return index;
}
function fullSetSignature(doc: StudyContent) {
  return JSON.stringify([
    doc.kind,
    doc.title,
    doc.description,
    [...itemsOf(doc)].sort((a, b) => a.id.localeCompare(b.id)),
  ]);
}

export function validateBackup(input: unknown) {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((issue) => ({
        path: "/" + issue.path.join("/"),
        message: issue.message,
      })),
    );
  const { library, history } = parsed.data;
  const foldersById = byId(library.folders ?? [], "/library/folders");
  const folderNames = new Set<string>();
  for (const [index, { name }] of (library.folders ?? []).entries()) {
    if (folderNames.has(name))
      invalid(`/library/folders/${index}/name`, "Duplicate folder name.");
    folderNames.add(name);
  }
  if (history && history.backupId !== library.backupId)
    invalid(
      "/history/backupId",
      "Choose the history file from this library backup.",
    );

  const sets = library.sets.map((row, i) => {
    if (row.folderId && !foldersById.has(row.folderId))
      invalid(
        `/library/sets/${i}/folderId`,
        "This set refers to a missing folder.",
      );
    return {
      ...row,
      content: validateAt(`/library/sets/${i}/content`, () =>
        validateContent(row.content),
      ),
    };
  });
  const setsById = byId(sets, "/library/sets");
  const fullVersions = new Map<string, string>();
  const activeReviews = new Set<string>();
  const attempts = (history?.attempts ?? []).map((row, i) => {
    const path = `/history/attempts/${i}`;
    const snapshot = validateAt(path + "/snapshot", () =>
      validateContent(row.snapshot),
    );
    const set = row.studySetId ? setsById.get(row.studySetId) : undefined;
    if (row.studySetId && !set)
      invalid(
        path + "/studySetId",
        "Attempt refers to a study set missing from the library backup.",
      );
    if (row.reviewMode && snapshot.kind !== "flashcards")
      invalid(path + "/reviewMode", "Spaced reviews require flashcards.");
    if (row.fullSet && (row.reviewMode || row.sourceAttemptId))
      invalid(
        path + "/fullSet",
        "Due reviews and retries are focused sessions.",
      );
    if (row.reviewMode && row.studySetId && row.status === "in_progress") {
      if (activeReviews.has(row.studySetId))
        invalid(
          path + "/reviewMode",
          "A deck can have only one active due review.",
        );
      activeReviews.add(row.studySetId);
    }
    if (row.fullSet && set && row.studySetRevision !== null) {
      const version = JSON.stringify([set.id, row.studySetRevision]);
      const signature = fullSetSignature(snapshot);
      const expected =
        fullVersions.get(version) ??
        (set.revision === row.studySetRevision
          ? fullSetSignature(set.content)
          : signature);
      if (expected !== signature)
        invalid(
          path + "/snapshot",
          "Full attempts for a set revision must contain the same items.",
        );
      fullVersions.set(version, expected);
    }
    if (row.settings.count !== itemsOf(snapshot).length)
      invalid(
        path + "/settings/count",
        "Practice count does not match the snapshot.",
      );
    const started = Date.parse(row.startedAt);
    const updated = Date.parse(row.updatedAt);
    const completed =
      row.completedAt === null ? null : Date.parse(row.completedAt);
    if (
      updated < started ||
      (row.status === "completed") !== (completed !== null) ||
      (completed !== null &&
        (completed < started || completed > updated + 1000))
    )
      invalid(path, "Attempt timestamps do not match its status.");

    const responses = validateAt(path, () =>
      validateProgress(
        snapshot,
        row.status === "in_progress" ? "in_progress" : "reviewing",
        row.responses as Responses,
        row.responses,
        row.position,
      ),
    );
    let result: Result | null = null;
    if (row.status !== "in_progress") {
      const scored = grade(snapshot, responses);
      if (scored.status !== row.status)
        invalid(
          path + "/status",
          "Attempt status does not match its assessments.",
        );
      result = scored.result;
    }
    return { ...row, snapshot, responses, result };
  });

  const attemptsById = byId(attempts, "/history/attempts");
  const visited = new Set<string>();
  const ordered: typeof attempts = [];
  for (const row of attempts) {
    let current = row;
    const chain = new Map<string, (typeof attempts)[number]>();
    while (!visited.has(current.id)) {
      if (chain.has(current.id))
        invalid(
          "/history/attempts",
          "A retry cannot reference itself through another attempt.",
        );
      chain.set(current.id, current);
      if (!current.sourceAttemptId) break;
      const source = attemptsById.get(current.sourceAttemptId);
      if (
        !source ||
        source.snapshot.kind !== current.snapshot.kind ||
        source.studySetId !== current.studySetId
      )
        invalid(
          "/history/attempts",
          "A retry references an unrelated or missing attempt.",
        );
      current = source;
    }
    for (const attempt of [...chain.values()].reverse()) {
      if (
        attempt.sourceAttemptId &&
        attemptsById.get(attempt.sourceAttemptId)?.status !== "completed"
      )
        invalid(
          "/history/attempts",
          "Retries must reference completed attempts.",
        );
      visited.add(attempt.id);
      ordered.push(attempt);
    }
  }

  const reviews = history?.reviews ?? [];
  const reviewKeys = new Set<string>();
  for (const [i, row] of reviews.entries()) {
    const set = setsById.get(row.studySetId);
    const key = `${row.studySetId}/${row.cardId}`;
    if (set?.content.kind !== "flashcards" || reviewKeys.has(key))
      invalid(
        `/history/reviews/${i}`,
        "Duplicate card review or missing deck.",
      );
    reviewKeys.add(key);
  }
  return {
    backupId: library.backupId,
    folders: library.folders ?? [],
    sets,
    attempts: ordered,
    reviews,
  };
}

export function backupSummary(backup: ReturnType<typeof validateBackup>) {
  const folderNames = new Set(backup.folders.map(({ name }) => name));
  for (const set of backup.sets)
    if (set.folderId === undefined && set.course) folderNames.add(set.course);
  return {
    ...(folderNames.size ? { folderCount: folderNames.size } : {}),
    setCount: backup.sets.length,
    attemptCount: backup.attempts.length,
    reviewCount: backup.reviews.length,
    titles: backup.sets.slice(0, 20).map((set) => set.content.title),
  };
}
export type BackupSummary = ReturnType<typeof backupSummary>;
