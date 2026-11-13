import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Prisma, StudySet } from "../generated/prisma/client";
import { validateContent } from "../shared/content";
import type {
  OwnershipInvitation,
  SharedSetPreview,
  ShareSettings,
} from "../shared/sharing";
import type { Context } from "./app";
import type { Database } from "./db";
import { read, schema } from "./request";
import { lockPrimarySet, lockSet, unavailableSet } from "./setAccess";
import { decodeStorage, encodeStorage } from "./storage";

type QueryDb = Pick<Database, "$queryRaw">;
const tokenPattern = /^([a-f0-9-]{36})\.([a-f0-9]{64})$/;
const text = new TextEncoder();
const invalidLink = () =>
  new HTTPException(404, { message: "This copy link is unavailable." });
const invalidInvitation = () =>
  new HTTPException(404, {
    message: "This invitation is no longer available.",
  });

function linkKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    text.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const linkMessage = (nonce: string) =>
  text.encode(`exam-prep-copy-v1:${nonce}`);

async function signLink(nonce: string, secret: string) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await linkKey(secret),
    linkMessage(nonce),
  );
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${nonce}.${hex}`;
}

async function verifyLink(token: string, secret: string) {
  const match = tokenPattern.exec(token);
  if (!match) throw invalidLink();
  const [, nonce, hex] = match;
  const signature = Uint8Array.from(hex.match(/../g)!, (byte) =>
    Number.parseInt(byte, 16),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await linkKey(secret),
      signature,
      linkMessage(nonce),
    ))
  )
    throw invalidLink();
  return nonce;
}

async function activeLink(db: QueryDb, nonce: string) {
  const [link] = await db.$queryRaw<{ studySetId: string }[]>`
    SELECT "studySetId" FROM "StudySetCopyLink" WHERE nonce = ${nonce}
  `;
  if (!link) throw invalidLink();
  return link.studySetId;
}

async function readShareSettings(
  db: QueryDb,
  studySetId: string,
  userId: string,
  secret: string,
): Promise<ShareSettings> {
  type SettingsRow = Omit<ShareSettings, "link"> & { nonce: string | null };
  const [row] = await db.$queryRaw<SettingsRow[]>`
    SELECT l.nonce,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email) ORDER BY u.email, u.id)
        FROM "StudySetCoOwner" co JOIN "user" u ON u.id = co."userId"
        WHERE co."studySetId" = s.id
      ), '[]'::jsonb) AS "coOwners",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', i.id, 'email', u.email) ORDER BY i."createdAt", i.id)
        FROM "StudySetInvitation" i JOIN "user" u ON u.id = i."userId"
        WHERE i."studySetId" = s.id
      ), '[]'::jsonb) AS invitations
    FROM "StudySet" s LEFT JOIN "StudySetCopyLink" l ON l."studySetId" = s.id
    WHERE s.id = ${studySetId} AND s."userId" = ${userId}
  `;
  if (!row) throw unavailableSet();
  return {
    link: row.nonce ? `/share#${await signLink(row.nonce, secret)}` : null,
    coOwners: row.coOwners,
    invitations: row.invitations,
  };
}

async function importCopy(
  db: Database,
  userId: string,
  nonce: string,
  requestId: string,
) {
  return db.$transaction(async (tx) => {
    // The receipt reserves this account's action before any copy can be created.
    const [claim] = await tx.$queryRaw<{ requestId: string }[]>`
      INSERT INTO "StudySetCopyImport" ("userId", "requestId", "linkNonce")
      VALUES (${userId}, ${requestId}, ${nonce})
      ON CONFLICT ("userId", "requestId") DO NOTHING RETURNING "requestId"
    `;
    if (!claim) {
      const [receipt] = await tx.$queryRaw<
        { copyId: string | null; linkNonce: string }[]
      >`
        SELECT "copyId", "linkNonce" FROM "StudySetCopyImport"
        WHERE "userId" = ${userId} AND "requestId" = ${requestId}
      `;
      if (receipt?.linkNonce !== nonce)
        throw new HTTPException(409, {
          message: "This import request was used for another link.",
        });
      if (!receipt.copyId)
        throw new HTTPException(404, {
          message: "The copy from this import was deleted.",
        });
      return { id: receipt.copyId, created: false };
    }
    const sourceId = await activeLink(tx, nonce);
    if (!(await lockSet(tx, sourceId))) throw invalidLink();
    const [source] = await tx.$queryRaw<Pick<StudySet, "content">[]>`
      SELECT s.content FROM "StudySet" s JOIN "StudySetCopyLink" l ON l."studySetId" = s.id
      WHERE s.id = ${sourceId} AND l.nonce = ${nonce}
    `;
    if (!source) throw invalidLink();
    const content = validateContent(decodeStorage(source.content));
    const copy = await tx.studySet.create({
      data: {
        userId,
        title: encodeStorage(content.title),
        kind: content.kind,
        content: encodeStorage(content) as Prisma.InputJsonValue,
      },
    });
    await tx.$executeRaw`
      UPDATE "StudySetCopyImport" SET "copyId" = ${copy.id}
      WHERE "userId" = ${userId} AND "requestId" = ${requestId}
    `;
    return { id: copy.id, created: true };
  });
}

const tokenBody = { token: z.string().max(128) };

export function registerSharing(app: Hono<Context>, secret: string) {
  app.get("/api/sets/:id/sharing", async (c) =>
    c.json(
      await readShareSettings(
        c.get("db"),
        c.req.param("id"),
        c.get("userId"),
        secret,
      ),
    ),
  );
  app.put("/api/sets/:id/sharing/link", async (c) => {
    const { enabled } = schema(
      z.strictObject({ enabled: z.boolean() }),
      await read(c.req.raw, 1024),
    );
    const setId = c.req.param("id");
    const userId = c.get("userId");
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        await lockPrimarySet(tx, setId, userId);
        if (enabled)
          await tx.$executeRaw`
          INSERT INTO "StudySetCopyLink" ("studySetId", nonce) VALUES (${setId}, ${crypto.randomUUID()})
          ON CONFLICT ("studySetId") DO NOTHING
        `;
        else
          await tx.$executeRaw`DELETE FROM "StudySetCopyLink" WHERE "studySetId" = ${setId}`;
        return readShareSettings(tx, setId, userId, secret);
      }),
    );
  });
  app.post("/api/shares/preview", async (c) => {
    const { token } = schema(
      z.strictObject(tokenBody),
      await read(c.req.raw, 1024),
    );
    const nonce = await verifyLink(token, secret);
    const [preview] = await c.get("db").$queryRaw<SharedSetPreview[]>`
      SELECT s.title, s.kind,
        COALESCE(jsonb_array_length(s.content->'questions'), jsonb_array_length(s.content->'cards')) AS count
      FROM "StudySet" s JOIN "StudySetCopyLink" l ON l."studySetId" = s.id WHERE l.nonce = ${nonce}
    `;
    if (!preview) throw invalidLink();
    return c.json(decodeStorage(preview));
  });
  app.post("/api/shares/import", async (c) => {
    const { token, requestId } = schema(
      z.strictObject({ ...tokenBody, requestId: z.uuid() }),
      await read(c.req.raw, 1024),
    );
    const nonce = await verifyLink(token, secret);
    const { id, created } = await importCopy(
      c.get("db"),
      c.get("userId"),
      nonce,
      requestId.toLowerCase(),
    );
    return c.json({ id }, created ? 201 : 200);
  });
  app.get("/api/ownership-invitations", async (c) => {
    const invitations = await c.get("db").$queryRaw<OwnershipInvitation[]>`
      SELECT i.id, s.title, s.kind, u.email AS "ownerEmail" FROM "StudySetInvitation" i
      JOIN "StudySet" s ON s.id = i."studySetId" JOIN "user" u ON u.id = s."userId"
      WHERE i."userId" = ${c.get("userId")} ORDER BY i."createdAt" DESC, i.id
    `;
    return c.json(
      invitations.map((invitation) => ({
        ...invitation,
        title: decodeStorage(invitation.title),
      })),
    );
  });
  app.post("/api/sets/:id/sharing/invitations", async (c) => {
    const { email } = schema(
      z.strictObject({ email: z.string().trim().max(254).pipe(z.email()) }),
      await read(c.req.raw, 2048),
    );
    const setId = c.req.param("id");
    const userId = c.get("userId");
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        await lockPrimarySet(tx, setId, userId);
        const [recipient] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "user" WHERE email = ${email.toLowerCase()}
      `;
        if (!recipient)
          throw new HTTPException(404, {
            message: "No Exam Prep account uses that email.",
          });
        const [coOwner] = await tx.$queryRaw<{ userId: string }[]>`
        SELECT "userId" FROM "StudySetCoOwner" WHERE "studySetId" = ${setId} AND "userId" = ${recipient.id}
      `;
        if (recipient.id === userId || coOwner)
          throw new HTTPException(409, {
            message: "That account already owns this study set.",
          });
        await tx.$executeRaw`
        INSERT INTO "StudySetInvitation" (id, "studySetId", "userId")
        VALUES (${crypto.randomUUID()}, ${setId}, ${recipient.id})
        ON CONFLICT ("studySetId", "userId") DO NOTHING
      `;
        return readShareSettings(tx, setId, userId, secret);
      }),
    );
  });
  app.delete("/api/sets/:id/sharing/invitations/:invitationId", async (c) => {
    const setId = c.req.param("id");
    const userId = c.get("userId");
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        await lockPrimarySet(tx, setId, userId);
        await tx.$executeRaw`
        DELETE FROM "StudySetInvitation" WHERE id = ${c.req.param("invitationId")} AND "studySetId" = ${setId}
      `;
        return readShareSettings(tx, setId, userId, secret);
      }),
    );
  });
  app.post("/api/ownership-invitations/:id/respond", async (c) => {
    const { accept } = schema(
      z.strictObject({ accept: z.boolean() }),
      await read(c.req.raw, 1024),
    );
    const userId = c.get("userId");
    const id = c.req.param("id");
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        const [invitation] = await tx.$queryRaw<{ studySetId: string }[]>`
        SELECT "studySetId" FROM "StudySetInvitation" WHERE id = ${id} AND "userId" = ${userId}
      `;
        if (!invitation) throw invalidInvitation();
        const { studySetId } = invitation;
        if (!(await lockSet(tx, studySetId))) throw invalidInvitation();
        const consumed = await tx.$executeRaw`
        DELETE FROM "StudySetInvitation" WHERE id = ${id} AND "userId" = ${userId}
      `;
        if (!consumed) throw invalidInvitation();
        if (accept)
          await tx.$executeRaw`
          INSERT INTO "StudySetCoOwner" ("studySetId", "userId") VALUES (${studySetId}, ${userId})
          ON CONFLICT ("studySetId", "userId") DO NOTHING
        `;
        return { studySetId, accepted: accept };
      }),
    );
  });
  app.delete("/api/sets/:id/sharing/co-owners/:userId", async (c) => {
    const setId = c.req.param("id");
    const ownerId = c.get("userId");
    const userId = c.req.param("userId");
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        await lockPrimarySet(tx, setId, ownerId);
        const removed = await tx.$executeRaw`
        DELETE FROM "StudySetCoOwner" WHERE "studySetId" = ${setId} AND "userId" = ${userId}
      `;
        if (removed)
          await tx.$executeRaw`
          UPDATE "Attempt" SET "studySetId" = NULL WHERE "studySetId" = ${setId} AND "userId" = ${userId}
        `;
        return readShareSettings(tx, setId, ownerId, secret);
      }),
    );
  });
}
