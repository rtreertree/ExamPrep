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
  readLibrarySet,
  readLockedLibrarySet,
  unavailableSet,
} from "./setAccess";
import { decodeStorage, encodeStorage } from "./storage";

type Tx = Pick<Database, "$queryRaw" | "$executeRaw">;
type Placement = { folderId: string | null; course: string };
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
export const exactMatchOrder = sql`s.archived, s."createdAt", s.id`;

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
    INSERT INTO "StudySet" (id, "userId", title, kind, content, revision, course, "folderId",
      pinned, archived, "reviewLimit", "lastStudiedAt", "createdAt", "updatedAt")
    SELECT id, ${userId}, content->>'title', content->>'kind', content, COALESCE(revision, 1),
      COALESCE(course, ''), "folderId", COALESCE(pinned, false), COALESCE(archived, false),
      COALESCE("reviewLimit", 20), "lastStudiedAt",
      COALESCE("createdAt", CURRENT_TIMESTAMP), COALESCE("updatedAt", CURRENT_TIMESTAMP)
    FROM jsonb_to_recordset(${input}::jsonb) AS s(
      id text, content jsonb, revision int, course text, "folderId" text, pinned bool, archived bool,
      "reviewLimit" int, "lastStudiedAt" timestamp, "createdAt" timestamp, "updatedAt" timestamp, position int)
    ORDER BY position`;
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
  const [receipt] = await tx.$queryRaw<Receipt[]>`
    SELECT operation, "inputIdentity", "setId", reused FROM "StudySetOperation"
    WHERE "userId" = ${userId} AND "requestId" = ${requestId}`;
  if (receipt) return receipt;

  // Catch a copy committed by the previous release after the migration ran.
  const [legacyCopy] = await tx.$queryRaw<Receipt[]>`
    SELECT 'copy' AS operation, regexp_replace("linkNonce", '^editable:', '') AS "inputIdentity",
      "copyId" AS "setId", false AS reused FROM "StudySetCopyImport"
    WHERE "userId" = ${userId} AND "requestId" = ${requestId}`;
  if (legacyCopy) return legacyCopy;

  const legacyId = (key: string) =>
    createHash("sha256")
      .update(JSON.stringify(["create-set", userId, key]))
      .digest("hex");
  const ids = [legacyId(originalId), legacyId(requestId)];
  const [legacyCreate] = await tx.$queryRaw<Receipt[]>`
    SELECT operation, "inputIdentity", "setId", reused FROM "StudySetOperation"
    WHERE "userId" = ${userId} AND "requestId" IN (${ids[0]}, ${ids[1]})
    UNION ALL
    SELECT 'legacy-create', "contentFingerprint", id, false FROM "StudySet"
    WHERE "userId" = ${userId} AND id IN (${ids[0]}, ${ids[1]})
    LIMIT 1`;
  return legacyCreate;
}

export async function createStudySet(
  db: Database,
  userId: string,
  input: Input,
) {
  return db.$transaction(async (tx) => {
    await lockLibrary(tx, userId);
    const requestId = input.requestId?.toLowerCase();
    const document =
      "content" in input ? JSON.stringify(encodeStorage(input.content)) : null;
    const [fingerprint] =
      document && requestId
        ? await tx.$queryRaw<{ fingerprint: string }[]>`
          SELECT study_content_fingerprint(${document}::jsonb) AS fingerprint`
        : [];
    const identity =
      "content" in input
        ? "content:" + fingerprint?.fingerprint
        : input.scope + ":" + input.sourceId;
    const receipt =
      requestId && (await findReceipt(tx, userId, input.requestId!, requestId));
    if (receipt) {
      const matches =
        receipt.operation === "legacy-create"
          ? input.operation === "reuse" &&
            receipt.inputIdentity === fingerprint?.fingerprint
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
        SELECT s.id FROM "StudySet" s WHERE s."userId" = ${userId}
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
    if (requestId)
      await tx.$executeRaw`
        INSERT INTO "StudySetOperation" ("userId", "requestId", operation, "inputIdentity", "setId", reused)
        VALUES (${userId}, ${requestId}, ${input.operation}, ${identity}, ${id}, ${reused})`;
    const set = await readLibrarySet(tx, id, userId);
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
      course: decodeStorage(source.course),
      folderId: source.folderId,
    };
  }
  if (!(await lockSet(tx, id))) throw unavailableSet();
  const [source] = await tx.$queryRaw<{ content: StudyContent }[]>`
    SELECT content FROM "StudySet" WHERE id = ${id} AND (${scope === "admin"} OR published)`;
  if (!source) throw unavailableSet();
  return { content: validateContent(decodeStorage(source.content)) };
}
