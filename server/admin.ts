import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  DirectoryUser,
  SetAccessSummary,
  ShareRecipient,
} from "../shared/directory";
import { LIST_PAGE_SIZE } from "../shared/listing";
import type { Context } from "./app";
import type { Database } from "./db";
import { cloneSet, page, pageInput, searchPattern } from "./directory";
import { lockLibrary } from "./libraryOrder";
import { read, schema } from "./request";
import { lockSet, unavailableSet } from "./setAccess";
import { revokeCoOwner, setLink, signLink } from "./sharing";

type Reader = Pick<Database, "$queryRaw">;
const roles = z.enum(["admin", "user"]);
const accountFields = sql`id, name, email, role, suspended`;
async function account(db: Reader, id: string) {
  const [row] = await db.$queryRaw<DirectoryUser[]>(
    sql`SELECT ${accountFields} FROM "user" WHERE id = ${id}`,
  );
  if (!row) throw new HTTPException(404, { message: "Account unavailable." });
  return row;
}
async function access(
  db: Reader,
  id: string,
  secret: string,
): Promise<SetAccessSummary> {
  const [row] = await db.$queryRaw<
    (Omit<SetAccessSummary, "link"> & { nonce: string | null })[]
  >`
    SELECT s.revision, s.published, l.nonce,
      (SELECT count(*)::int FROM "StudySetViewer" WHERE "studySetId" = s.id) AS viewers,
      (SELECT count(*)::int FROM "StudySetCoOwner" WHERE "studySetId" = s.id) AS "coOwners",
      (SELECT count(*)::int FROM "StudySetInvitation" WHERE "studySetId" = s.id) AS invitations
    FROM "StudySet" s LEFT JOIN "StudySetCopyLink" l ON l."studySetId" = s.id WHERE s.id = ${id}
  `;
  if (!row) throw unavailableSet();
  const { nonce, ...summary } = row;
  return {
    ...summary,
    link: nonce ? "/share#" + (await signLink(nonce, secret)) : null,
  };
}
const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email());
const changes = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  email: emailField.optional(),
  role: roles.optional(),
  suspended: z.boolean().optional(),
});
const action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("publish"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("link"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("invite"), email: emailField }),
  z.strictObject({ action: z.literal("cancel"), userId: z.string().min(1) }),
  z.strictObject({ action: z.literal("grant"), userId: z.string().min(1) }),
  z.strictObject({ action: z.literal("revoke"), userId: z.string().min(1) }),
]);

export function registerAdmin(app: Hono<Context>, secret: string) {
  app.get("/api/admin/users", async (c) => {
    const { q, after, role, status } = schema(
      z.strictObject({
        ...pageInput,
        role: roles.optional(),
        status: z.enum(["active", "suspended"]).optional(),
      }),
      c.req.query(),
    );
    const pattern = searchPattern(q);
    const rows = await c.get("db").$queryRaw<DirectoryUser[]>(sql`
      SELECT ${accountFields} FROM "user" WHERE id > ${after}
      ${q ? sql`AND (name ILIKE ${pattern} OR email ILIKE ${pattern} OR id = ${q})` : sql``}
      ${role ? sql`AND role = ${role}` : sql``}
      ${status ? sql`AND suspended = ${status === "suspended"}` : sql``}
      ORDER BY id LIMIT ${LIST_PAGE_SIZE + 1}
    `);
    return c.json(page(rows));
  });
  app.get("/api/admin/users/:id", async (c) =>
    c.json(await account(c.get("db"), c.req.param("id"))),
  );
  app.patch("/api/admin/users/:id", async (c) => {
    const id = c.req.param("id"),
      input = schema(changes, await read(c.req.raw, 4096));
    return c.json(
      await c.get("db").$transaction(async (tx) => {
        // Serialize role changes so two requests cannot each remove the last other admin.
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('exam-prep-admin-accounts'))`;
        const actor = await account(tx, c.get("userId"));
        if (actor.suspended || actor.role !== "admin")
          throw new HTTPException(403);
        const old = await account(tx, id);
        const email = input.email ?? old.email,
          role = input.role ?? old.role,
          suspended = input.suspended ?? old.suspended;
        if (
          old.role === "admin" &&
          !old.suspended &&
          (role !== "admin" || suspended)
        ) {
          const others = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM "user" WHERE role = 'admin' AND NOT suspended AND id <> ${id} LIMIT 1`;
          if (!others.length)
            throw new HTTPException(409, {
              message: "Keep at least one active administrator.",
            });
        }
        if (email !== old.email) {
          const taken = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM "user" WHERE email = ${email}`;
          if (taken.length)
            throw new HTTPException(409, {
              message: "That email is already in use.",
            });
          await tx.$executeRaw`DELETE FROM verification WHERE value = ${id} AND identifier LIKE 'reset-password:%'`;
        }
        await tx.$executeRaw`UPDATE "user" SET name = COALESCE(${input.name ?? null}, name),
        "emailVerified" = CASE WHEN email = ${email} THEN "emailVerified" ELSE false END,
        email = ${email}, role = ${role}, suspended = ${suspended}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ${id}`;
        if (suspended || email !== old.email)
          await tx.$executeRaw`DELETE FROM session WHERE "userId" = ${id}`;
        return account(tx, id);
      }),
    );
  });

  app.get("/api/admin/sets/:id/access", async (c) =>
    c.json(await access(c.get("db"), c.req.param("id"), secret)),
  );
  app.get("/api/admin/sets/:id/recipients", async (c) => {
    const { after, q } = schema(z.strictObject(pageInput), c.req.query());
    const id = c.req.param("id"),
      pattern = searchPattern(q);
    const rows = await c.get("db").$queryRaw<ShareRecipient[]>(sql`
      SELECT u.id, u.name, u.email, r.invited FROM (
        SELECT "userId", false AS invited FROM "StudySetCoOwner" WHERE "studySetId" = ${id} AND "userId" > ${after}
        UNION ALL SELECT "userId", true FROM "StudySetInvitation" WHERE "studySetId" = ${id} AND "userId" > ${after}
        ${q ? sql`` : sql`ORDER BY "userId" LIMIT ${LIST_PAGE_SIZE + 1}`}
      ) r JOIN "user" u ON u.id = r."userId"
      ${q ? sql`WHERE u.name ILIKE ${pattern} OR u.email ILIKE ${pattern}` : sql``}
      ORDER BY u.id LIMIT ${LIST_PAGE_SIZE + 1}
    `);
    return c.json(page(rows));
  });
  app.post("/api/admin/users/:id/copies", async (c) => {
    const { setId, requestId } = schema(
      z.strictObject({ setId: z.string().min(1), requestId: z.uuid() }),
      await read(c.req.raw, 1024),
    );
    await account(c.get("db"), c.req.param("id"));
    const copy = await cloneSet(
      c.get("db"),
      c.req.param("id"),
      setId,
      requestId.toLowerCase(),
      "admin",
    );
    return c.json({ id: copy.id }, copy.created ? 201 : 200);
  });
  app.post("/api/admin/sets/:id/access", async (c) => {
    const input = schema(action, await read(c.req.raw, 2048)),
      id = c.req.param("id");
    await c.get("db").$transaction(async (tx) => {
      if (input.action === "grant") await lockLibrary(tx, input.userId);
      if (!(await lockSet(tx, id))) throw unavailableSet();
      switch (input.action) {
        case "publish":
          await tx.$executeRaw`UPDATE "StudySet" SET published = ${input.enabled} WHERE id = ${id}`;
          break;
        case "link":
          await setLink(tx, id, input.enabled);
          break;
        case "revoke":
          await revokeCoOwner(tx, id, input.userId);
          break;
        case "cancel":
          await tx.$executeRaw`DELETE FROM "StudySetInvitation" WHERE "studySetId" = ${id} AND "userId" = ${input.userId}`;
          break;
        case "grant":
        case "invite": {
          const query =
            input.action === "grant"
              ? sql`u.id = ${input.userId}`
              : sql`u.email = ${input.email}`;
          const [user] = await tx.$queryRaw<
            { id: string; primaryOwner: boolean; coOwner: boolean }[]
          >(sql`
            SELECT u.id, s."userId" = u.id AS "primaryOwner",
              EXISTS (SELECT 1 FROM "StudySetCoOwner" co WHERE co."studySetId" = s.id AND co."userId" = u.id) AS "coOwner"
            FROM "user" u JOIN "StudySet" s ON s.id = ${id} WHERE ${query}
          `);
          if (!user)
            throw new HTTPException(404, { message: "Account unavailable." });
          if (user.primaryOwner || (user.coOwner && input.action === "invite"))
            throw new HTTPException(409, {
              message: "This account already owns the set.",
            });
          if (input.action === "invite")
            await tx.$executeRaw`INSERT INTO "StudySetInvitation" (id,"studySetId","userId") VALUES (${crypto.randomUUID()},${id},${user.id}) ON CONFLICT DO NOTHING`;
          else {
            await tx.$executeRaw`DELETE FROM "StudySetInvitation" WHERE "studySetId" = ${id} AND "userId" = ${user.id}`;
            await tx.$executeRaw`INSERT INTO "StudySetCoOwner" ("studySetId","userId") VALUES (${id},${user.id}) ON CONFLICT DO NOTHING`;
          }
          break;
        }
      }
    });
    return c.json({ ok: true });
  });
  app.delete("/api/admin/sets/:id", async (c) => {
    const id = c.req.param("id");
    const expected = schema(
      z.strictObject({
        revision: z.number().int(),
        coOwners: z.number().int(),
        viewers: z.number().int().default(0),
        invitations: z.number().int(),
        link: z.string().nullable(),
        published: z.boolean(),
      }),
      await read(c.req.raw, 1024),
    );
    await c.get("db").$transaction(async (tx) => {
      if (!(await lockSet(tx, id))) throw unavailableSet();
      const current = await access(tx, id, secret);
      if (
        Object.entries(expected).some(
          ([key, v]) => current[key as keyof SetAccessSummary] !== v,
        )
      )
        throw new HTTPException(409, {
          message:
            "The set or its sharing has changed. Review the current impact before deleting.",
        });
      await tx.$executeRaw`DELETE FROM "StudySet" WHERE id = ${id}`;
    });
    return c.json({ deleted: true });
  });
}
