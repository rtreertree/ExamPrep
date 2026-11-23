import { createHash } from "node:crypto";
import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import {
  MAX_BYTES,
  validateContent,
  type StudyContent,
} from "../shared/content";
import type { Database } from "./db";
import { lockLibrary } from "./libraryOrder";
import {
  lockSet,
  lockOwnerLibrary,
  readLibrarySet,
  readLockedLibrarySet,
  unavailableSet,
} from "./setAccess";
import { decodeStorage, encodeStorage } from "./storage";
import { conflict } from "./routeHelpers";

type Tx = Pick<Database, "$queryRaw" | "$executeRaw">;
type Placement = { folderId: string | null };
type NewSet = {
  id: string;
  content: StudyContent;
  revision?: number;
  archived?: boolean;
  pinned?: boolean;
  reviewLimit?: number;
  lastStudiedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
} & Partial<Placement>;

// Both the fingerprint index and JSON equality use the stored document. The
// fingerprint narrows the index scan and never substitutes for equality.
export const exactContent = (content: ReturnType<typeof sql>) => sql`
  s."contentFingerprint" = study_content_fingerprint(${content}) AND s.content = ${content}
`;
export const joinPrimaryEntry = sql`
  JOIN "LibraryEntry" e ON e."studySetId" = s.id AND e."userId" = s."userId"
`;
export const exactMatchOrder = sql`e.archived, s."createdAt", s.id`;

export async function insertPrivateSets(
  tx: Tx,
  userId: string,
  sets: NewSet[],
) {
  if (!sets.length) return;
  const input = JSON.stringify(
    encodeStorage(sets.map((set, position) => ({ ...set, position }))),
  );
  await tx.$executeRaw`
    INSERT INTO "StudySet" (id, "userId", content, revision, "createdAt", "updatedAt")
    SELECT id, ${userId}, content, COALESCE(revision, 1),
      COALESCE("createdAt", CURRENT_TIMESTAMP), COALESCE("updatedAt", CURRENT_TIMESTAMP)
    FROM jsonb_to_recordset(${input}::jsonb) AS s(
      id text, content jsonb, revision int, "createdAt" timestamp, "updatedAt" timestamp, position int)
    ORDER BY position`;
  const entries = sets
    .filter(
      (set) =>
        set.folderId != null ||
        set.archived ||
        set.pinned ||
        set.reviewLimit !== undefined ||
        set.lastStudiedAt,
    )
    .map(({ id, folderId, pinned, archived, reviewLimit, lastStudiedAt }) => ({
      id,
      folderId,
      pinned,
      archived,
      reviewLimit,
      lastStudiedAt,
    }));
  if (entries.length)
    await tx.$executeRaw`
      UPDATE "LibraryEntry" e SET "folderId" = p."folderId", pinned = COALESCE(p.pinned, false),
        archived = COALESCE(p.archived, false), "reviewLimit" = COALESCE(p."reviewLimit", 20),
        "lastStudiedAt" = p."lastStudiedAt"
      FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS p(
        id text, "folderId" text, pinned bool, archived bool, "reviewLimit" int, "lastStudiedAt" timestamp)
      WHERE e."studySetId" = p.id AND e."userId" = ${userId}`;
}

type Input =
  | { operation: "reuse" | "copy"; content: StudyContent; requestId?: string }
  | {
      operation: "copy";
      scope: "library" | "discover" | "admin";
      sourceId: string;
      requestId?: string;
    };

type Receipt = {
  operation: string;
  inputIdentity: string;
  setId: string | null;
  reused: boolean;
  resultRevision: number | null;
};

function requestConflict(): never {
  throw new HTTPException(409, {
    message: "This request ID was used for a different save or copy.",
  });
}

async function findReceipt(
  tx: Tx,
  userId: string,
  originalId: string,
  requestId: string,
): Promise<Receipt | undefined> {
  const legacyId = (key: string) =>
    createHash("sha256")
      .update(JSON.stringify(["create-set", userId, key]))
      .digest("hex");
  const [receipt] = await tx.$queryRaw<Receipt[]>`
    SELECT operation, "inputIdentity", "setId", reused, "resultRevision" FROM "StudySetOperation"
    WHERE "userId" = ${userId} AND "requestId" IN (${requestId}, ${legacyId(originalId)}, ${legacyId(requestId)})
    ORDER BY ("requestId" = ${requestId}) DESC, ("requestId" = ${legacyId(originalId)}) DESC
    LIMIT 1`;
  return receipt;
}

async function lockOperation(tx: Tx, userId: string, requestId: string) {
  await tx.$queryRaw`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('exam-prep-set-operation'), hashtext(${userId} || '/' || ${requestId}))`;
}

async function fingerprintFor(tx: Tx, document: string) {
  const [row] = await tx.$queryRaw<{ fingerprint: string }[]>`
    SELECT study_content_fingerprint(${document}::jsonb) AS fingerprint`;
  return row.fingerprint;
}

async function rememberOperation(
  tx: Tx,
  userId: string,
  requestId: string,
  operation: string,
  identity: string,
  setId: string,
  resultRevision: number,
  reused = false,
) {
  await tx.$executeRaw`
    INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId", "resultRevision", reused)
    VALUES (${userId}, ${requestId}, ${operation}, ${identity}, ${setId}, ${resultRevision}, ${reused})`;
}

export async function editStudySet(
  db: Database,
  userId: string,
  id: string,
  content: StudyContent,
  revision: number,
  key?: string,
) {
  return db.$transaction(async (tx) => {
    const requestId = key?.toLowerCase();
    if (requestId) await lockOperation(tx, userId, requestId);
    const document = encodeStorage(content);
    const identity = requestId
      ? JSON.stringify([
          id,
          revision,
          await fingerprintFor(tx, JSON.stringify(document)),
        ])
      : undefined;
    const receipt =
      requestId && (await findReceipt(tx, userId, key!, requestId));
    if (
      receipt &&
      (receipt.operation !== "edit" || receipt.inputIdentity !== identity)
    )
      requestConflict();
    await lockOwnerLibrary(tx, id);
    const membership = await readLockedLibrarySet(tx, id, userId);
    if (membership.ownershipRole === "viewer") throw unavailableSet();
    if (receipt) {
      return {
        ...membership,
        content: document,
        title: document.title,
        kind: document.kind,
        revision: receipt.resultRevision!,
      };
    }
    if (membership.revision !== revision) throw conflict();
    const changed = await tx.studySet.updateMany({
      where: { id, revision, NOT: { content: { equals: document } } },
      data: { content: document, revision: { increment: 1 } },
    });
    const saved = changed.count
      ? await readLibrarySet(tx, id, userId)
      : membership;
    if (requestId)
      await rememberOperation(
        tx,
        userId,
        requestId,
        "edit",
        identity!,
        id,
        saved.revision,
      );
    return saved;
  });
}

export async function createStudySet(
  db: Database,
  userId: string,
  input: Input,
) {
  return db.$transaction(async (tx) => {
    const requestId = input.requestId?.toLowerCase();
    if (requestId) await lockOperation(tx, userId, requestId);
    await lockLibrary(tx, userId);
    const document =
      "content" in input ? JSON.stringify(encodeStorage(input.content)) : null;
    const fingerprint =
      document && requestId ? await fingerprintFor(tx, document) : undefined;
    const identity =
      "content" in input
        ? "content:" + fingerprint
        : input.scope + ":" + input.sourceId;
    const receipt =
      requestId && (await findReceipt(tx, userId, input.requestId!, requestId));
    if (receipt) {
      const matches =
        receipt.operation === "legacy-create"
          ? input.operation === "reuse" && receipt.inputIdentity === fingerprint
          : receipt.operation === input.operation &&
            receipt.inputIdentity === identity;
      if (!matches) requestConflict();
      if (!receipt.setId) throw unavailableSet();
      const set = await readLibrarySet(tx, receipt.setId, userId);
      if (set.ownershipRole !== "primary") throw unavailableSet();
      return { set, created: false, reused: receipt.reused };
    }

    let id: string | undefined;
    if (input.operation === "reuse" && document !== null) {
      const [match] = await tx.$queryRaw<{ id: string }[]>(sql`
        SELECT s.id FROM "StudySet" s ${joinPrimaryEntry} WHERE s."userId" = ${userId}
          AND ${exactContent(sql`${document}::jsonb`)}
        ORDER BY ${exactMatchOrder} LIMIT 1 FOR NO KEY UPDATE OF s`);
      id = match?.id;
    }
    const reused = id !== undefined;
    if (id === undefined) {
      id = crypto.randomUUID();
      const draft =
        "content" in input
          ? { content: input.content }
          : await readCopySource(tx, userId, input.scope, input.sourceId);
      await insertPrivateSets(tx, userId, [{ id, ...draft }]);
    }
    const set = await readLibrarySet(tx, id, userId);
    if (requestId)
      await rememberOperation(
        tx,
        userId,
        requestId,
        input.operation,
        identity,
        id,
        set.revision,
        reused,
      );
    return { set, created: !reused, reused };
  });
}

async function readCopySource(
  tx: Tx,
  userId: string,
  scope: "library" | "discover" | "admin",
  id: string,
): Promise<{ content: StudyContent } & Partial<Placement>> {
  if (scope === "library") {
    const source = await readLockedLibrarySet(tx, id, userId);
    if (source.ownershipRole === "viewer") throw unavailableSet();
    const content = validateContent(decodeStorage(source.content));
    const titled = {
      ...content,
      title: [...`Copy of ${content.title}`].slice(0, 200).join(""),
    };
    const copy =
      new TextEncoder().encode(JSON.stringify(titled)).length <= MAX_BYTES
        ? titled
        : content;
    return {
      content: copy,
      folderId: source.folderId,
    };
  }
  if (!(await lockSet(tx, id))) throw unavailableSet();
  const [source] = await tx.$queryRaw<{ content: StudyContent }[]>`
    SELECT content FROM "StudySet" WHERE id = ${id} AND (${scope === "admin"} OR published)`;
  if (!source) throw unavailableSet();
  return { content: validateContent(decodeStorage(source.content)) };
}
