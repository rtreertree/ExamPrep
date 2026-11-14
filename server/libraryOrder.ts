import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import {
  LIST_PAGE_SIZE,
  MAX_LIST_PAGE,
  folderSorts,
  sortOrders,
  type FolderList,
  type FolderSummary,
  type ManualOrder,
} from "../shared/listing";
import type { Context } from "./app";
import type { Database } from "./db";
import type { Hono } from "hono";
import { read, schema } from "./request";
import { decodeStorage, encodeStorage } from "./storage";

type QueryDb = Pick<Database, "$queryRaw" | "$executeRaw">;
type Location = { folderId: string | null; archived: boolean };
export const folderIdSchema = z.string().min(1).max(64);
const folderNameSchema = z.string().trim().min(1).max(100);
const unavailableFolder = () =>
  new HTTPException(404, { message: "This folder is unavailable." });

export function listPage(value?: string) {
  const page = Number(value ?? 0);
  if (!Number.isInteger(page) || page < 0 || page > MAX_LIST_PAGE)
    throw new HTTPException(400, { message: "Invalid page." });
  return page;
}

export function archiveFilter(value = "false") {
  if (value !== "true" && value !== "false")
    throw new HTTPException(400, { message: "Invalid archive filter." });
  return value === "true";
}

export function sortField<T extends string>(
  value: string | undefined,
  options: readonly T[],
): T {
  const match =
    value === undefined
      ? options[0]
      : options.find((option) => option === value);
  if (!match) throw new HTTPException(400, { message: "Invalid sort option." });
  return match;
}

export async function lockLibrary(tx: QueryDb, userId: string) {
  // Separate namespace from other account-level locks. Rank mutations within an
  // account serialize without locking another owner's preferences on shared sets.
  await tx.$queryRaw`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('exam-prep-library'), hashtext(${userId}))
  `;
}

export async function readFolder(db: QueryDb, userId: string, id: string) {
  const [folder] = await db.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM "LibraryFolder" WHERE "userId" = ${userId} AND id = ${id}
  `;
  if (!folder) throw unavailableFolder();
  return folder;
}

export async function folderForLegacyName(
  db: QueryDb,
  userId: string,
  name: string,
) {
  if (!name) return null;
  const [folder] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "LibraryFolder" (id, "userId", name)
    VALUES (${crypto.randomUUID()}, ${userId}, ${name})
    ON CONFLICT ("userId", name) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `;
  return folder.id;
}

const setLocations = (userId: string) => sql`
  SELECT id, "folderId", archived, "manualRank", false AS "coOwned"
  FROM "StudySet" WHERE "userId" = ${userId}
  UNION ALL
  SELECT "studySetId" AS id, "folderId", archived, "manualRank", true AS "coOwned"
  FROM "StudySetCoOwner" WHERE "userId" = ${userId}
`;

const folderRanks = (userId: string) => sql`
  SELECT id, "manualRank", false AS "coOwned" FROM "LibraryFolder" WHERE "userId" = ${userId}
`;
const setRanks = (userId: string, { folderId, archived }: Location) => sql`
  SELECT id, "manualRank", "coOwned" FROM (${setLocations(userId)}) locations
  WHERE "folderId" IS NOT DISTINCT FROM ${folderId}::text AND archived = ${archived}
`;
const orderSummary = (ranks: Prisma.Sql) => sql`
  SELECT COUNT(*)::int AS count,
    md5(COALESCE(string_agg(id, ',' ORDER BY "manualRank", id), '')) AS version
  FROM (${ranks}) ranks
`;

export const setOrderSummary = (userId: string, location: Location) =>
  orderSummary(setRanks(userId, location));

async function listFolders(
  db: QueryDb,
  userId: string,
  query: Record<string, string>,
) {
  const page = listPage(query.page);
  const archived = archiveFilter(query.archived);
  const search = (query.search ?? "").slice(0, 200).trim();
  const sort = sortField(query.sort, folderSorts);
  const order = sortField(query.order, sortOrders);
  const includeUnfiled = !search || "unfiled".includes(search.toLowerCase());
  const nameOrder =
    order === "desc"
      ? sql`lower(f.name) DESC, f.name DESC`
      : sql`lower(f.name), f.name`;
  const [result] = await db.$queryRaw<
    {
      items: FolderSummary[];
      unfiledCount: number | null;
      manual: ManualOrder | null;
    }[]
  >(sql`
    WITH counts AS (
      SELECT "folderId", COUNT(*)::int AS count FROM (${setLocations(userId)}) locations
      WHERE archived = ${archived} GROUP BY "folderId"
    ), page AS (
      SELECT f.id, f.name, COALESCE(counts.count, 0) AS count,
        row_number() OVER (ORDER BY ${sort === "manual" ? sql`f."manualRank"` : nameOrder}, f.id) AS ordinal
      FROM "LibraryFolder" f LEFT JOIN counts ON counts."folderId" = f.id
      WHERE f."userId" = ${userId} AND strpos(lower(f.name), lower(${encodeStorage(search)})) > 0
      ORDER BY ordinal LIMIT ${LIST_PAGE_SIZE + 1} OFFSET ${page * LIST_PAGE_SIZE}
    )
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name, 'count', count) ORDER BY ordinal) FROM page), '[]'::jsonb) AS items,
      CASE WHEN ${includeUnfiled && page === 0} THEN COALESCE((SELECT count FROM counts WHERE "folderId" IS NULL), 0) END AS "unfiledCount",
      ${
        sort === "manual" && !search
          ? sql`(SELECT row_to_json(summary) FROM (${orderSummary(folderRanks(userId))}) summary)`
          : sql`NULL`
      } AS manual
  `);
  return decodeStorage<FolderList>({
    items: result.items.slice(0, LIST_PAGE_SIZE),
    hasMore: result.items.length > LIST_PAGE_SIZE,
    unfiledCount: result.unfiledCount,
    ...(result.manual ? { manual: result.manual } : {}),
  });
}

const reorderFields = {
  id: folderIdSchema,
  position: z.number().int().min(1).max(2_147_483_647),
  version: z.string().regex(/^[a-f0-9]{32}$/),
};
const reorderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("folder"), ...reorderFields }),
  z.strictObject({
    kind: z.literal("set"),
    folderId: folderIdSchema.nullable(),
    archived: z.boolean(),
    ...reorderFields,
  }),
]);

async function reorder(
  db: Database,
  userId: string,
  change: z.infer<typeof reorderSchema>,
) {
  return db.$transaction(async (tx) => {
    await lockLibrary(tx, userId);
    const ranks =
      change.kind === "folder" ? folderRanks(userId) : setRanks(userId, change);
    if (change.kind === "set") {
      // Deleting a shared set or revoking access can remove entries from this
      // account without taking its library lock.
      await tx.$queryRaw(sql`
        SELECT s.id FROM "StudySet" s JOIN (${ranks}) ranks ON ranks.id = s.id
        ORDER BY s.id FOR NO KEY UPDATE OF s
      `);
    }
    const [summary] = await tx.$queryRaw<ManualOrder[]>(orderSummary(ranks));
    if (summary.version !== change.version)
      throw new HTTPException(409, {
        message: "This list changed. Its order has been refreshed.",
      });
    // Rotate the ranks between the old and new positions in one statement.
    // Existing ranks remain unique within the list and new items can append.
    const changes = sql`
      WITH ranked AS MATERIALIZED (
        SELECT *, row_number() OVER (ORDER BY "manualRank", id) AS position
        FROM (${ranks}) ranks
      ), origin AS (
        SELECT position FROM ranked WHERE id = ${change.id}
      ), moves AS MATERIALIZED (
        SELECT item.id, item."coOwned", destination."manualRank"
        FROM ranked item CROSS JOIN origin
        JOIN ranked destination ON destination.position = CASE
          WHEN item.position = origin.position THEN ${change.position}::bigint
          WHEN origin.position < ${change.position} THEN item.position - 1
          ELSE item.position + 1 END
        WHERE item.position BETWEEN LEAST(origin.position, ${change.position})
          AND GREATEST(origin.position, ${change.position})
          AND origin.position <> ${change.position}
      )
    `;
    if (change.position > summary.count)
      throw new HTTPException(422, {
        message: "Choose a position in this list.",
      });
    const [target] = await tx.$queryRaw<{ id: string }[]>(sql`
      SELECT id FROM (${ranks}) ranks WHERE id = ${change.id}
    `);
    if (!target)
      throw new HTTPException(409, {
        message: "This item moved. Its list has been refreshed.",
      });
    if (change.kind === "folder") {
      await tx.$queryRaw(sql`
        ${changes}
        UPDATE "LibraryFolder" f SET "manualRank" = moves."manualRank"
        FROM moves WHERE f.id = moves.id AND f."userId" = ${userId} RETURNING f.id
      `);
    } else {
      await tx.$queryRaw(sql`
        ${changes}, primary_sets AS (
          UPDATE "StudySet" s SET "manualRank" = moves."manualRank"
          FROM moves WHERE NOT moves."coOwned" AND s.id = moves.id AND s."userId" = ${userId}
        )
        UPDATE "StudySetCoOwner" co SET "manualRank" = moves."manualRank"
        FROM moves WHERE moves."coOwned" AND co."studySetId" = moves.id AND co."userId" = ${userId}
        RETURNING co."studySetId"
      `);
    }
    return { position: change.position };
  });
}

export function registerFolders(app: Hono<Context>) {
  app.get("/api/folders", async (c) =>
    c.json(await listFolders(c.get("db"), c.get("userId"), c.req.query())),
  );
  app.get("/api/folders/:id", async (c) =>
    c.json(
      decodeStorage(
        await readFolder(c.get("db"), c.get("userId"), c.req.param("id")),
      ),
    ),
  );
  const nameInput = z.strictObject({ name: folderNameSchema });
  app.post("/api/folders", async (c) => {
    const { name } = schema(nameInput, await read(c.req.raw));
    const folder = await c.get("db").$transaction(async (tx) => {
      await lockLibrary(tx, c.get("userId"));
      const [created] = await tx.$queryRaw<{ id: string; name: string }[]>`
        INSERT INTO "LibraryFolder" (id, "userId", name)
        VALUES (${crypto.randomUUID()}, ${c.get("userId")}, ${encodeStorage(name)})
        ON CONFLICT ("userId", name) DO NOTHING RETURNING id, name
      `;
      if (!created)
        throw new HTTPException(409, {
          message: "A folder with this name already exists.",
        });
      return decodeStorage(created);
    });
    return c.json(folder, 201);
  });
  app.patch("/api/folders/:id", async (c) => {
    const { name } = schema(nameInput, await read(c.req.raw));
    const userId = c.get("userId");
    const id = c.req.param("id");
    const folder = await c.get("db").$transaction(async (tx) => {
      await lockLibrary(tx, userId);
      await readFolder(tx, userId, id);
      const [updated] = await tx.$queryRaw<{ id: string; name: string }[]>`
        UPDATE "LibraryFolder" SET name = ${encodeStorage(name)}
        WHERE id = ${id} AND "userId" = ${userId} AND NOT EXISTS (
          SELECT 1 FROM "LibraryFolder" WHERE "userId" = ${userId} AND id <> ${id} AND name = ${encodeStorage(name)}
        ) RETURNING id, name
      `;
      if (!updated)
        throw new HTTPException(409, {
          message: "A folder with this name already exists.",
        });
      return decodeStorage(updated);
    });
    return c.json(folder);
  });
  app.delete("/api/folders/:id", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw, 1024));
    const userId = c.get("userId");
    const id = c.req.param("id");
    await c.get("db").$transaction(async (tx) => {
      await lockLibrary(tx, userId);
      await readFolder(tx, userId, id);
      await tx.$queryRaw(sql`
        SELECT s.id FROM "StudySet" s JOIN (${setLocations(userId)}) locations ON locations.id = s.id
        WHERE locations."folderId" = ${id} ORDER BY s.id FOR NO KEY UPDATE OF s
      `);
      await tx.$queryRaw(sql`
        WITH moved AS MATERIALIZED (
          SELECT id, "coOwned", nextval('library_manual_rank_seq'::regclass) AS rank
          FROM (${setLocations(userId)}) locations WHERE "folderId" = ${id} ORDER BY "manualRank", id
        ), primary_sets AS (
          UPDATE "StudySet" s SET "folderId" = NULL, course = '', "manualRank" = moved.rank
          FROM moved WHERE NOT moved."coOwned" AND s.id = moved.id AND s."userId" = ${userId}
        )
        UPDATE "StudySetCoOwner" co SET "folderId" = NULL, course = '', "manualRank" = moved.rank
        FROM moved WHERE moved."coOwned" AND co."studySetId" = moved.id AND co."userId" = ${userId}
        RETURNING co."studySetId"
      `);
      await tx.$executeRaw`DELETE FROM "LibraryFolder" WHERE id = ${id} AND "userId" = ${userId}`;
    });
    return c.body(null, 204);
  });
  app.patch("/api/library/order", async (c) =>
    c.json(
      await reorder(
        c.get("db"),
        c.get("userId"),
        schema(reorderSchema, await read(c.req.raw)),
      ),
    ),
  );
}
