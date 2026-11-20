import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type {
  DirectoryPage,
  DirectorySet,
  SetReaderData,
} from "../shared/directory";
import { LIST_PAGE_SIZE } from "../shared/listing";
import type { Context } from "./app";
import type { Database } from "./db";
import { lockLibrary } from "./libraryOrder";
import { read, schema } from "./request";
import { lockSet, unavailableSet } from "./setAccess";
import { decodeStorage, encodeStorage } from "./storage";

export const pageInput = {
  after: z.string().max(200).default(""),
  q: z.string().trim().max(254).default(""),
};
export function page<T extends { id: string }>(rows: T[]): DirectoryPage<T> {
  const items = rows.slice(0, LIST_PAGE_SIZE);
  return {
    items,
    next: rows.length > items.length ? items[items.length - 1].id : null,
  };
}
export const searchPattern = (q: string) =>
  "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
const setQuery = z.strictObject({
  ...pageInput,
  kind: z.enum(["exam", "flashcards"]).optional(),
  sharing: z.enum(["published", "link", "invitations", "coOwners"]).optional(),
});
type Scope = { type: "discover" | "all" } | { type: "library"; userId: string };
async function listSets(
  db: Database,
  params: Record<string, string>,
  scope: Scope,
) {
  const { q, after, kind, sharing } = schema(setQuery, params);
  const libraryId = scope.type === "library" ? scope.userId : null;
  const sharingFilters = {
    published: sql`s.published`,
    link: sql`EXISTS (SELECT 1 FROM "StudySetCopyLink" l WHERE l."studySetId" = s.id)`,
    invitations: sql`EXISTS (SELECT 1 FROM "StudySetInvitation" i WHERE i."studySetId" = s.id)`,
    coOwners: sql`EXISTS (SELECT 1 FROM "StudySetCoOwner" o WHERE o."studySetId" = s.id)`,
  };
  const filters = sql`
    ${scope.type === "discover" ? sql`AND s.published` : sql``}
    ${sharing && scope.type !== "discover" ? sql`AND ${sharingFilters[sharing]}` : sql``}
    ${kind ? sql`AND s.kind = ${kind}` : sql``}
    ${q ? sql`AND s.title ILIKE ${searchPattern(encodeStorage(q))}` : sql``}
  `;
  const limit = LIST_PAGE_SIZE + 1;
  // Bound each indexed ownership scan before merging the two library lists.
  const candidates = libraryId
    ? sql`
    (SELECT s.id, 'primary' AS role, s.archived FROM "StudySet" s
      WHERE s."userId" = ${libraryId} AND s.id > ${after} ${filters} ORDER BY s.id LIMIT ${limit})
    UNION ALL
    (SELECT co."studySetId" AS id, 'co_owner' AS role, co.archived FROM "StudySetCoOwner" co
      JOIN "StudySet" s ON s.id = co."studySetId"
      WHERE co."userId" = ${libraryId} AND co."studySetId" > ${after} ${filters}
      ORDER BY co."studySetId" LIMIT ${limit})
    ORDER BY id LIMIT ${limit}
  `
    : sql`SELECT s.id FROM "StudySet" s WHERE s.id > ${after} ${filters} ORDER BY s.id LIMIT ${limit}`;
  const rows = await db.$queryRaw<DirectorySet[]>(sql`
    SELECT s.id, s.kind, s.title, u.name AS "ownerName",
      COALESCE(jsonb_array_length(s.content->'questions'), jsonb_array_length(s.content->'cards')) AS count
      ${scope.type !== "discover" ? sql`, s.published` : sql``}
      ${libraryId ? sql`, p.role AS "ownershipRole", p.archived` : sql``}
    FROM (${candidates}) p JOIN "StudySet" s ON s.id = p.id JOIN "user" u ON u.id = s."userId"
    ORDER BY s.id
  `);
  return page(rows.map((row) => ({ ...row, title: decodeStorage(row.title) })));
}

// Share links, Discover, and admin grants use distinct namespaces for import receipts.
export async function cloneSet(
  db: Database,
  userId: string,
  setId: string,
  requestId: string,
  scope: "discover" | "admin",
) {
  return db.$transaction(async (tx) => {
    await lockLibrary(tx, userId);
    if (!(await lockSet(tx, setId))) throw unavailableSet();
    const [source] = await tx.$queryRaw<
      { published: boolean }[]
    >`SELECT published FROM "StudySet" WHERE id = ${setId}`;
    if (scope === "discover" && !source.published) throw unavailableSet();
    const key = scope + ":" + setId;
    const [receipt] = await tx.$queryRaw<
      { copyId: string | null; linkNonce: string }[]
    >`
      SELECT "linkNonce", "copyId" FROM "StudySetCopyImport" WHERE "userId" = ${userId} AND "requestId" = ${requestId}
    `;
    if (receipt) {
      if (receipt.linkNonce !== key)
        throw new HTTPException(409, {
          message: "This request was used for another copy.",
        });
      if (!receipt.copyId) throw unavailableSet();
      return { id: receipt.copyId, created: false };
    }
    const id = crypto.randomUUID();
    await tx.$executeRaw`INSERT INTO "StudySet" (id, "userId", kind, title, content, "updatedAt")
      SELECT ${id}, ${userId}, kind, title, content, CURRENT_TIMESTAMP FROM "StudySet" WHERE id = ${setId}`;
    await tx.$executeRaw`INSERT INTO "StudySetCopyImport" ("userId", "requestId", "linkNonce", "copyId")
      VALUES (${userId}, ${requestId}, ${key}, ${id})`;
    return { id, created: true };
  });
}
export function registerDirectory(app: Hono<Context>) {
  app.get("/api/discover", async (c) =>
    c.json(await listSets(c.get("db"), c.req.query(), { type: "discover" })),
  );
  app.get("/api/admin/sets", async (c) =>
    c.json(await listSets(c.get("db"), c.req.query(), { type: "all" })),
  );
  app.get("/api/admin/users/:id/library", async (c) =>
    c.json(
      await listSets(c.get("db"), c.req.query(), {
        type: "library",
        userId: c.req.param("id"),
      }),
    ),
  );
  for (const path of [
    "/api/discover/:id",
    "/api/admin/sets/:id/preview",
  ] as const) {
    app.get(path, async (c) => {
      const [row] = await c.get("db").$queryRaw<SetReaderData[]>(sql`
        SELECT s.content, u.name AS "ownerName" FROM "StudySet" s JOIN "user" u ON u.id = s."userId"
        WHERE s.id = ${c.req.param("id")} ${path.startsWith("/api/discover") ? sql`AND s.published` : sql``}
      `);
      if (!row) throw unavailableSet();
      return c.json({
        ownerName: row.ownerName,
        content: decodeStorage(row.content),
      });
    });
  }
  app.post("/api/discover/:id/clone", async (c) => {
    const { requestId } = schema(
      z.strictObject({ requestId: z.uuid() }),
      await read(c.req.raw, 1024),
    );
    const copy = await cloneSet(
      c.get("db"),
      c.get("userId"),
      c.req.param("id"),
      requestId.toLowerCase(),
      "discover",
    );
    return c.json({ id: copy.id }, copy.created ? 201 : 200);
  });
}
