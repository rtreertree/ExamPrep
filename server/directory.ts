import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import type { Hono } from "hono";
import { z } from "zod";
import type {
  DirectoryPage,
  DirectorySet,
  SetReaderData,
} from "../shared/directory";
import { LIST_PAGE_SIZE } from "../shared/listing";
import type { Context } from "./app";
import type { Database } from "./db";
import { read, schema } from "./request";
import { entryRole, joinEntry, unavailableSet } from "./setAccess";
import { createStudySet } from "./setCreation";
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
    coOwners: sql`EXISTS (SELECT 1 FROM "LibraryEntry" o WHERE o."studySetId" = s.id AND o."coOwner")`,
  };
  const filters = sql`
    ${scope.type === "discover" ? sql`AND s.published` : sql``}
    ${sharing && scope.type !== "discover" ? sql`AND ${sharingFilters[sharing]}` : sql``}
    ${kind ? sql`AND s.kind = ${kind}` : sql``}
    ${q ? sql`AND s.title ILIKE ${searchPattern(encodeStorage(q))}` : sql``}
  `;
  const limit = LIST_PAGE_SIZE + 1;
  const candidates = libraryId
    ? sql`SELECT s.id, ${entryRole} AS role, e.archived FROM "StudySet" s ${joinEntry(libraryId)}
      WHERE e."studySetId" > ${after} ${filters} ORDER BY e."studySetId" LIMIT ${limit}`
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
    const { set, created } = await createStudySet(
      c.get("db"),
      c.get("userId"),
      {
        operation: "copy",
        scope: "discover",
        sourceId: c.req.param("id"),
        requestId,
      },
    );
    return c.json({ id: set.id }, created ? 201 : 200);
  });
}
