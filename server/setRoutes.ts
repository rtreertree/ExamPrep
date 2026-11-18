import type { Hono } from "hono";
import { createHash } from "node:crypto";
import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { revisionSchema } from "../shared/attempts";
import { validateContent, serializeContent } from "../shared/content";
import { MAX_BYTES } from "../shared/json";
import {
  LIST_PAGE_SIZE,
  setSorts,
  sortOrders,
  type CourseSummary,
  type LibraryFolder,
  type ManualOrder,
} from "../shared/listing";
import type { Context } from "./app";
import type { Database } from "./db";
import {
  archiveFilter,
  folderIdSchema,
  listPage,
  lockLibrary,
  setOrderSummary,
  sortField,
} from "./libraryOrder";
import { read, schema } from "./request";
import { conflict, json, unavailable } from "./routeHelpers";
import {
  joinCoOwner,
  joinOwnerFolder,
  lockOwnedSet,
  organizeSets,
  ownedSetIds,
  ownerPreferences,
  ownerFolderId,
  ownerLastStudiedAt,
  ownerRank,
  ownershipRole,
  readOwnedSet,
  type OwnedSet,
} from "./setAccess";
import { encodeStorage, decodeStorage } from "./storage";

const courseSchema = z.string().trim().max(100);
const organizationFields = {
  course: courseSchema.optional(),
  folderId: folderIdSchema.nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
};
const oneFolderField = ({
  course,
  folderId,
}: {
  course?: string;
  folderId?: string | null;
}) => course === undefined || folderId === undefined;

function publicSet({
  manualRank: _rank,
  ...set
}: Awaited<ReturnType<Database["studySet"]["create"]>>) {
  return decodeStorage({
    ...set,
    folderName: set.course || null,
    ownershipRole: "primary" as const,
  });
}

export function registerSetRoutes(app: Hono<Context>) {
  app.get("/api/sets", async (c) => {
    const page = listPage(c.req.query("page"));
    const kind = c.req.query("kind");
    if (kind && kind !== "exam" && kind !== "flashcards")
      throw new HTTPException(400, { message: "Invalid kind." });
    const search = encodeStorage((c.req.query("search") ?? "").slice(0, 200));
    const course = c.req.query("course");
    const storedCourse =
      course === undefined ? null : encodeStorage(schema(courseSchema, course));
    const archived = archiveFilter(c.req.query("archived"));
    const folder = c.req.query("folderId");
    const folderId = folder ? schema(folderIdSchema, folder) : null;
    const sort = sortField(c.req.query("sort"), setSorts);
    const order = sortField(
      c.req.query("order") ?? (sort === "title" ? "asc" : "desc"),
      sortOrders,
    );
    const direction = order === "asc" ? sql`ASC` : sql`DESC`;
    const sortSql = {
      updated: sql`s."updatedAt" ${direction}`,
      studied: sql`${ownerLastStudiedAt} ${direction} NULLS LAST, s."updatedAt" DESC`,
      title: sql`lower(s.title) ${direction}, s.title ${direction}`,
      manual: sql`${ownerRank}`,
    }[sort];
    const db = c.get("db");
    const userId = c.get("userId");
    const canReorder =
      sort === "manual" &&
      folder !== undefined &&
      storedCourse === null &&
      !search &&
      !kind;
    const manual = canReorder
      ? sql`(SELECT row_to_json(summary) FROM (${setOrderSummary(userId, { folderId, archived })}) summary)`
      : sql`NULL`;
    // Project metadata in PostgreSQL: a page must not load thirty 2-MiB documents.
    const [sets, folders] = await Promise.all([
      db.$queryRaw<
        (Omit<OwnedSet, "content"> & {
          count: number;
          manual: ManualOrder | null;
        })[]
      >(sql`
        SELECT s.id, s."userId", s.title, s.kind, s.revision, s."createdAt",
          s."updatedAt", ${ownershipRole}, ${ownerPreferences},
          COALESCE(jsonb_array_length(s.content->'questions'), jsonb_array_length(s.content->'cards')) AS count,
          ${manual} AS manual,
          (SELECT jsonb_build_object(
            'id', a.id, 'status', a.status, 'position', a.position, 'result', a.result, 'kind', a.snapshot->>'kind',
            'total', COALESCE(jsonb_array_length(a.snapshot->'questions'), jsonb_array_length(a.snapshot->'cards')),
            'isOlderVersion', COALESCE(a."studySetRevision" <> s.revision, a."fullSet" AND a.snapshot <> s.content)
          )
          FROM "Attempt" a WHERE a."studySetId" = s.id AND a."userId" = ${userId}
          AND a.status IN ('in_progress', 'reviewing') ORDER BY a."updatedAt" DESC, a.id ASC LIMIT 1) AS continuation
        FROM "StudySet" s ${joinCoOwner(userId)} ${joinOwnerFolder}
        WHERE s.id IN ${ownedSetIds(userId)}
          AND COALESCE(co.archived, s.archived) = ${archived}
          AND (${kind ?? null}::text IS NULL OR s.kind = ${kind ?? null}::text)
          AND (${storedCourse}::text IS NULL OR COALESCE(f.name, '') = ${storedCourse}::text)
          AND (NOT ${folder !== undefined} OR (${ownerFolderId}) IS NOT DISTINCT FROM ${folderId}::text)
          AND strpos(lower(s.title), lower(${search})) > 0
        ORDER BY ${sort === "manual" ? sql`` : sql`pinned DESC,`} ${sortSql},
          s.id ASC LIMIT ${LIST_PAGE_SIZE + 1} OFFSET ${page * LIST_PAGE_SIZE}
      `),
      db.$queryRaw<LibraryFolder[]>(sql`
        SELECT id, name FROM "LibraryFolder" WHERE "userId" = ${userId} ORDER BY lower(name), name
      `),
    ]);
    return c.json(
      decodeStorage({
        items: sets
          .slice(0, LIST_PAGE_SIZE)
          .map(({ manual: _manual, ...set }) => set),
        ...(sets[0]?.manual ? { manual: sets[0].manual } : {}),
        hasMore: sets.length > LIST_PAGE_SIZE,
        page,
        folders,
        courses: folders.map(({ name }) => name),
      }),
    );
  });
  app.get("/api/sets/courses", async (c) => {
    const page = listPage(c.req.query("page"));
    const archived = archiveFilter(c.req.query("archived"));
    const userId = c.get("userId");
    const rows = await c.get("db").$queryRaw<CourseSummary[]>(sql`
      SELECT course, COUNT(*)::int AS count FROM (
        SELECT COALESCE(f.name, '') AS course
        FROM "StudySet" s ${joinCoOwner(userId)} ${joinOwnerFolder}
        WHERE s.id IN ${ownedSetIds(userId)} AND COALESCE(co.archived, s.archived) = ${archived}
      ) courses
      GROUP BY course ORDER BY (course = ''), lower(course), course
      LIMIT ${LIST_PAGE_SIZE + 1} OFFSET ${page * LIST_PAGE_SIZE}
    `);
    return c.json(
      decodeStorage({
        items: rows.slice(0, LIST_PAGE_SIZE),
        hasMore: rows.length > LIST_PAGE_SIZE,
      }),
    );
  });
  app.patch("/api/sets/organization", async (c) => {
    const { ids, course, folderId, pinned, archived } = schema(
      z
        .strictObject({
          ids: z
            .array(z.string().min(1).max(64))
            .min(1)
            .max(LIST_PAGE_SIZE)
            .refine(
              (ids) => new Set(ids).size === ids.length,
              "Select distinct study sets.",
            ),
          ...organizationFields,
        })
        .refine(
          ({ course, folderId, pinned, archived }) =>
            course !== undefined ||
            folderId !== undefined ||
            pinned !== undefined ||
            archived !== undefined,
          "Choose a field to update.",
        )
        .refine(oneFolderField, "Choose one folder."),
      await read(c.req.raw),
    );
    const updated = await organizeSets(
      c.get("db"),
      c.get("userId"),
      ids,
      { course, folderId, pinned, archived },
      true,
    );
    return c.json({ updated });
  });
  app.post("/api/sets", async (c) => {
    const content = validateContent(await read(c.req.raw, MAX_BYTES));
    const userId = c.get("userId");
    const requestId = c.req.query("requestId");
    let id: string | undefined;
    if (requestId !== undefined) {
      const key = JSON.stringify([
        "create-set",
        userId,
        schema(z.uuid(), requestId),
      ]);
      id = createHash("sha256").update(key).digest("hex");
    }
    const { set, created } = await c.get("db").$transaction(async (tx) => {
      await lockLibrary(tx, userId);
      if (id) {
        const existing = await tx.studySet.findFirst({ where: { id, userId } });
        if (existing) return { set: existing, created: false };
      }
      const set = await tx.studySet.create({
        data: {
          id,
          userId,
          title: encodeStorage(content.title),
          kind: content.kind,
          content: json(content),
        },
      });
      return { set, created: true };
    });
    return c.json(publicSet(set), created ? 201 : 200);
  });
  app.get("/api/sets/:id", async (c) => {
    const set = await readOwnedSet(
      c.get("db"),
      c.req.param("id"),
      c.get("userId"),
    );
    return c.json(decodeStorage(set));
  });
  app.put("/api/sets/:id", async (c) => {
    const input = schema(
      z.strictObject({ revision: revisionSchema, content: z.unknown() }),
      await read(c.req.raw),
    );
    const content = validateContent(input.content);
    const db = c.get("db");
    const userId = c.get("userId");
    const id = c.req.param("id");
    const storedContent = json(content);
    const set = await db.$transaction(async (tx) => {
      await lockOwnedSet(tx, id, userId);
      const changed = await tx.studySet.updateMany({
        where: {
          id,
          OR: [{ userId }, { coOwners: { some: { userId } } }],
          revision: input.revision,
          NOT: { content: { equals: storedContent } },
        },
        data: {
          content: storedContent,
          title: encodeStorage(content.title),
          kind: content.kind,
          revision: { increment: 1 },
        },
      });
      const saved = await readOwnedSet(tx, id, userId);
      if (!changed.count && saved.revision !== input.revision) throw conflict();
      return saved;
    });
    return c.json(decodeStorage(set));
  });
  app.patch("/api/sets/:id/organization", async (c) => {
    const changes = schema(
      z
        .strictObject(organizationFields)
        .refine(
          (fields) => Object.keys(fields).length > 0,
          "Choose a field to update.",
        )
        .refine(oneFolderField, "Choose one folder."),
      await read(c.req.raw),
    );
    await organizeSets(
      c.get("db"),
      c.get("userId"),
      [c.req.param("id")],
      changes,
      false,
    );
    return c.json({ updated: true });
  });
  app.post("/api/sets/:id/duplicate", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw));
    const db = c.get("db");
    const userId = c.get("userId");
    const duplicateId = c.req.param("id");
    const set = await db.$transaction(async (tx) => {
      await lockLibrary(tx, userId);
      const original = await readOwnedSet(tx, duplicateId, userId);
      const content = validateContent(decodeStorage(original.content));
      const titled = {
        ...content,
        title: [...`Copy of ${content.title}`].slice(0, 200).join(""),
      };
      const copy =
        new TextEncoder().encode(JSON.stringify(titled)).length <= MAX_BYTES
          ? titled
          : content;
      return tx.studySet.create({
        data: {
          userId,
          title: encodeStorage(copy.title),
          kind: copy.kind,
          course: original.course,
          folderId: original.folderId,
          content: json(copy),
        },
      });
    });
    return c.json(publicSet(set), 201);
  });
  app.delete("/api/sets/:id", async (c) => {
    const input = schema(
      z.strictObject({ revision: revisionSchema }),
      await read(c.req.raw),
    );
    const db = c.get("db");
    const where = { id: c.req.param("id"), userId: c.get("userId") };
    const deleted = await db.studySet.deleteMany({
      where: { ...where, revision: input.revision },
    });
    if (!deleted.count) {
      if (!(await db.studySet.findFirst({ where }))) throw unavailable();
      throw conflict();
    }
    return c.json({ deleted: true });
  });
  app.get("/api/sets/:id/export", async (c) => {
    const set = await readOwnedSet(
      c.get("db"),
      c.req.param("id"),
      c.get("userId"),
    );
    const content = serializeContent(decodeStorage(set.content));
    c.header(
      "Content-Disposition",
      `attachment; filename="study-set.examprep.json"`,
    );
    return c.body(content, 200, {
      "Content-Type": "application/json; charset=utf-8",
    });
  });
}
