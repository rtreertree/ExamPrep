import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { SetReaderData } from "../shared/directory";
import type { OwnershipInvitation, ShareSettings } from "../shared/sharing";
import type { Context } from "./app";
import type { Database } from "./db";
import { read, schema } from "./request";
import { lockPrimarySet, lockSet, unavailableSet } from "./setAccess";
import { lockLibrary } from "./libraryOrder";
import { decodeStorage } from "./storage";

type QueryDb = Pick<Database, "$queryRaw">;
export async function readInvitations(db: QueryDb, userId: string) {
  const invitations = await db.$queryRaw<OwnershipInvitation[]>`
      SELECT i.id, s.title, s.kind, u.email AS "ownerEmail" FROM "StudySetInvitation" i
      JOIN "StudySet" s ON s.id = i."studySetId" JOIN "user" u ON u.id = s."userId"
      WHERE i."userId" = ${userId} ORDER BY i."createdAt" DESC, i.id
    `;
  return invitations.map((invitation) => ({
    ...invitation,
    title: decodeStorage(invitation.title),
  }));
}
const tokenPattern = /^([a-f0-9-]{36})\.([a-f0-9]{64})$/;
const text = new TextEncoder();
const invalidLink = () =>
  new HTTPException(404, { message: "This share link is unavailable." });
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

export async function signLink(nonce: string, secret: string) {
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

async function readShareSettings(
  db: QueryDb,
  studySetId: string,
  userId: string,
  secret: string,
): Promise<ShareSettings> {
  type SettingsRow = Omit<ShareSettings, "link"> & { nonce: string | null };
  const [row] = await db.$queryRaw<SettingsRow[]>`
    SELECT l.nonce, COALESCE(l."guestAccess", false) AS "guestAccess",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email) ORDER BY u.email, u.id)
        FROM "LibraryEntry" co JOIN "user" u ON u.id = co."userId"
        WHERE co."studySetId" = s.id AND co."coOwner"
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
    guestAccess: row.guestAccess,
    coOwners: row.coOwners,
    invitations: row.invitations,
  };
}

const tokenBody = { token: z.string().max(128) };

export function registerSharePreview(app: Hono<Context>, secret: string) {
  app.post("/api/shares/preview", async (c) => {
    const { token } = schema(
      z.strictObject(tokenBody),
      await read(c.req.raw, 1024),
    );
    const nonce = await verifyLink(token, secret);
    const session = await c
      .get("auth")
      .api.getSession({ headers: c.req.raw.headers });
    if (session?.user.suspended)
      throw new HTTPException(403, { message: "This account is suspended." });
    const [set] = await c.get("db").$queryRaw<
      (SetReaderData & { guestAccess: boolean })[]
    >`
      SELECT CASE WHEN l."guestAccess" OR ${!!session} THEN s.content END AS content, l."guestAccess", u.name AS "ownerName" FROM "StudySet" s
      JOIN "user" u ON u.id = s."userId"
      JOIN "StudySetCopyLink" l ON l."studySetId" = s.id WHERE l.nonce = ${nonce}
    `;
    if (!set) throw invalidLink();
    if (!set.guestAccess && !session) return c.json({ signInRequired: true });
    return c.json({
      content: decodeStorage(set.content),
      ownerName: set.ownerName,
    });
  });
}

async function saveLiveSet(
  db: Database,
  userId: string,
  source: { id: string } | { nonce: string },
) {
  return db.$transaction(async (tx) => {
    await lockLibrary(tx, userId);
    const nonce = "nonce" in source ? source.nonce : null;
    const id =
      "id" in source
        ? source.id
        : (
            await tx.$queryRaw<{ id: string }[]>`
      SELECT "studySetId" AS id FROM "StudySetCopyLink" WHERE nonce=${nonce}`
          )[0]?.id;
    if (!id || !(await lockSet(tx, id))) throw unavailableSet();
    const [set] = await tx.$queryRaw<{ primary: boolean }[]>`
      SELECT s."userId" = ${userId} AS "primary"
      FROM "StudySet" s WHERE s.id = ${id} AND
      ((${nonce}::text IS NULL AND s.published) OR EXISTS (
        SELECT 1 FROM "StudySetCopyLink" l WHERE l."studySetId" = s.id AND l.nonce = ${nonce}
      ))
    `;
    if (!set) throw unavailableSet();
    if (!set.primary)
      await tx.$executeRaw`
        INSERT INTO "LibraryEntry" ("studySetId", "userId", discovered, "linkNonce")
        VALUES (${id}, ${userId}, ${nonce === null}, ${nonce})
        ON CONFLICT ("userId", "studySetId") DO UPDATE
        SET discovered = "LibraryEntry".discovered OR EXCLUDED.discovered,
          "linkNonce" = COALESCE(EXCLUDED."linkNonce", "LibraryEntry"."linkNonce")
      `;
    return { id };
  });
}

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
    const { enabled, allowGuests } = schema(
      z.strictObject({
        enabled: z.boolean(),
        allowGuests: z.literal(true).optional(),
      }),
      await read(c.req.raw, 1024),
    );
    const setId = c.req.param("id");
    const userId = c.get("userId");
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        await lockPrimarySet(tx, setId, userId);
        await setLink(tx, setId, enabled);
        if (enabled && allowGuests)
          await tx.$executeRaw`UPDATE "StudySetCopyLink" SET "guestAccess"=true WHERE "studySetId"=${setId}`;
        return readShareSettings(tx, setId, userId, secret);
      }),
    );
  });
  app.post("/api/shares/save", async (c) => {
    const { token } = schema(
      z.strictObject(tokenBody),
      await read(c.req.raw, 1024),
    );
    const nonce = await verifyLink(token, secret);
    return c.json(await saveLiveSet(c.get("db"), c.get("userId"), { nonce }));
  });
  app.post("/api/discover/:id/save", async (c) =>
    c.json(
      await saveLiveSet(c.get("db"), c.get("userId"), {
        id: c.req.param("id"),
      }),
    ),
  );
  app.delete("/api/sets/:id/membership", async (c) => {
    const id = c.req.param("id"),
      userId = c.get("userId");
    await c.get("db").$transaction(async (tx) => {
      await lockLibrary(tx, userId);
      await lockSet(tx, id);
      await tx.$executeRaw`
        DELETE FROM "LibraryEntry" e USING "StudySet" s WHERE s.id = ${id}
          AND e."studySetId" = s.id AND e."userId" = ${userId}
          AND s."userId" <> e."userId" AND NOT e."coOwner"
      `;
    });
    return c.body(null, 204);
  });
  app.get("/api/ownership-invitations", async (c) => {
    return c.json(await readInvitations(c.get("db"), c.get("userId")));
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
        SELECT "userId" FROM "LibraryEntry" WHERE "studySetId" = ${setId} AND "userId" = ${recipient.id} AND "coOwner"
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
        if (accept) await lockLibrary(tx, userId);
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
        if (accept) await grantCoOwnership(tx, studySetId, userId);
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
        await revokeCoOwner(tx, setId, userId);
        return readShareSettings(tx, setId, ownerId, secret);
      }),
    );
  });
}

type WriteDb = Pick<Database, "$executeRaw">;
export async function setLink(tx: WriteDb, setId: string, enabled: boolean) {
  if (enabled)
    await tx.$executeRaw`
          INSERT INTO "StudySetCopyLink" ("studySetId", nonce, "guestAccess") VALUES (${setId}, ${crypto.randomUUID()}, true)
          ON CONFLICT ("studySetId") DO NOTHING
        `;
  else
    await tx.$executeRaw`DELETE FROM "StudySetCopyLink" WHERE "studySetId" = ${setId}`;
}

export async function grantCoOwnership(
  tx: WriteDb,
  setId: string,
  userId: string,
) {
  await tx.$executeRaw`
    INSERT INTO "LibraryEntry" ("studySetId", "userId", "coOwner")
    VALUES (${setId}, ${userId}, true)
    ON CONFLICT ("userId", "studySetId") DO UPDATE SET "coOwner" = true
  `;
}

export async function revokeCoOwner(
  tx: WriteDb,
  setId: string,
  userId: string,
) {
  await tx.$executeRaw`
    DELETE FROM "LibraryEntry" e USING "StudySet" s
    WHERE s.id = ${setId} AND e."studySetId" = s.id AND e."userId" = ${userId}
      AND s."userId" <> e."userId" AND e."coOwner" AND NOT e.discovered AND e."linkNonce" IS NULL
  `;
  await tx.$executeRaw`
    UPDATE "LibraryEntry" SET "coOwner" = false
    WHERE "studySetId" = ${setId} AND "userId" = ${userId} AND "coOwner"
  `;
}
