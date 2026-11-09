import { openDB, type DBSchema } from "idb";
import { z } from "zod";
import {
  own,
  revisionSchema,
  responseChanges,
  sameResponse,
  type ResponseChanges,
  type Responses,
  type Status,
} from "../../shared/attempts";
import type { Attempt } from "./api";

export type PracticeCheckpoint = {
  version: 1;
  userId: string;
  attemptId: string;
  sessionId: string;
  token: string;
  updatedAt: number;
  baseRevision: number;
  baseStatus: Status;
  basePosition: number;
  position: number;
  before: Responses;
  changes: ResponseChanges;
  uncertain?: boolean;
  uncertainPosition?: boolean;
};

// A recovery file can contain pending edits for all 500 maximum-size answers,
// including both the original and edited value needed for conflict checks.
const recoveryFileLimit = 160 * 1024 * 1024;
const responseMap = <T extends Responses | ResponseChanges>(
  nullable: boolean,
) =>
  z.custom<T>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 500 &&
      Object.values(value).every(
        (entry) =>
          (nullable && entry === null) ||
          (typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry)),
      ),
  );
const checkpointSchema = z.object({
  version: z.literal(1),
  userId: z.string(),
  attemptId: z.string(),
  sessionId: z.string(),
  token: z.string(),
  updatedAt: z.number().nonnegative(),
  baseRevision: revisionSchema,
  baseStatus: z.enum(["in_progress", "reviewing", "completed"]),
  basePosition: z.number().int().min(0).max(499),
  position: z.number().int().min(0).max(499),
  before: responseMap<Responses>(false),
  changes: responseMap<ResponseChanges>(true),
  uncertain: z.boolean().optional(),
  uncertainPosition: z.boolean().optional(),
});

export async function readPracticeRecoveryFile(
  file: File,
  userId: string,
  attemptId: string,
) {
  if (file.size > recoveryFileLimit)
    throw new Error("This recovery file is too large.");
  const checkpoint = checkpointSchema.safeParse(JSON.parse(await file.text()));
  if (!checkpoint.success)
    throw new Error("This file is not an Exam Prep practice recovery copy.");
  if (
    checkpoint.data.userId !== userId ||
    checkpoint.data.attemptId !== attemptId
  )
    throw new Error(
      "This recovery file belongs to a different account or attempt.",
    );
  return checkpoint.data;
}

interface RecoveryDB extends DBSchema {
  checkpoints: {
    key: [string, string, string];
    value: PracticeCheckpoint;
    indexes: { account: string; attempt: [string, string] };
  };
}

let connection: ReturnType<typeof openDB<RecoveryDB>> | undefined;
function database() {
  return (connection ??= openDB<RecoveryDB>("exam-prep-practice", 1, {
    upgrade(db) {
      const store = db.createObjectStore("checkpoints", {
        keyPath: ["userId", "attemptId", "sessionId"],
      });
      store.createIndex("account", "userId");
      store.createIndex("attempt", ["userId", "attemptId"]);
    },
  }).catch((error) => {
    connection = undefined;
    throw error;
  }));
}

export async function listPracticeCheckpoints(
  userId: string,
  attemptId: string,
) {
  const db = await database();
  const drafts = await db.getAllFromIndex("checkpoints", "attempt", [
    userId,
    attemptId,
  ]);
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putPracticeCheckpoint(checkpoint: PracticeCheckpoint) {
  await (await database()).put("checkpoints", checkpoint);
}

export async function removePracticeCheckpoint(
  userId: string,
  attemptId: string,
  sessionId: string,
  token?: string,
) {
  const db = await database();
  const tx = db.transaction("checkpoints", "readwrite");
  const key = [userId, attemptId, sessionId] as [string, string, string];
  if (!token || (await tx.store.get(key))?.token === token)
    await tx.store.delete(key);
  await tx.done;
}

export async function clearPracticeCheckpoints(userId: string) {
  const db = await database();
  const tx = db.transaction("checkpoints", "readwrite");
  const keys = await tx.store.index("account").getAllKeys(userId);
  await Promise.all(keys.map((key) => tx.store.delete(key)));
  await tx.done;
}

export function makePracticeCheckpoint(
  userId: string,
  sessionId: string,
  base: Attempt,
  responses: Responses,
  position: number,
  uncertain?: { ids: ReadonlySet<string>; position: boolean },
): PracticeCheckpoint {
  const changes = {
    // Keep explicit reversals even when the desired value equals the old base.
    ...Object.fromEntries(
      Array.from(uncertain?.ids ?? [], (id) => [
        id,
        own(responses, id) ?? null,
      ]),
    ),
    ...responseChanges(base.responses, responses),
  };
  const before = Object.fromEntries(
    Object.keys(changes).flatMap((id) => {
      const response = own(base.responses, id);
      return response ? [[id, response]] : [];
    }),
  );
  return {
    version: 1,
    userId,
    attemptId: base.id,
    sessionId,
    token: crypto.randomUUID(),
    updatedAt: Date.now(),
    baseRevision: base.revision,
    baseStatus: base.status,
    basePosition: base.position,
    position,
    before,
    changes,
    uncertain: !!uncertain && (uncertain.ids.size > 0 || uncertain.position),
    uncertainPosition: uncertain?.position,
  };
}

export function planPracticeRecovery(
  checkpoint: PracticeCheckpoint,
  attempt: Attempt,
) {
  const safe: ResponseChanges = Object.create(null);
  const conflicts: ResponseChanges = Object.create(null);
  for (const [id, value] of Object.entries(checkpoint.changes)) {
    const current = own(attempt.responses, id);
    if (sameResponse(current, value ?? undefined)) continue;
    if (sameResponse(current, own(checkpoint.before, id))) safe[id] = value;
    else {
      // A server-confirmed card reveal stays revealed even if the local response
      // was recorded before it was shown on the other device.
      conflicts[id] =
        current?.revealed && !value?.revealed
          ? { ...value, revealed: true }
          : value;
    }
  }
  const safeCount = Object.keys(safe).length;
  const conflictCount = Object.keys(conflicts).length;
  const hasPosition =
    attempt.status !== "completed" &&
    (checkpoint.position !== checkpoint.basePosition ||
      checkpoint.uncertainPosition) &&
    checkpoint.position !== attempt.position;
  const positionConflict =
    hasPosition && checkpoint.basePosition !== attempt.position;
  return {
    safe,
    conflicts,
    safeCount,
    conflictCount,
    hasPosition,
    positionConflict,
    staleStatus: checkpoint.baseStatus !== attempt.status,
  };
}
