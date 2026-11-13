import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Attempt } from "../generated/prisma/client";
import {
  attemptTypes,
  LIST_PAGE_SIZE,
  type AttemptGroup,
} from "../shared/listing";
import type { Database } from "./db";
import { decodeStorage, encodeStorage } from "./storage";
import { joinCoOwner, ownerAccess } from "./setAccess";

type HistoryQuery = Record<string, string | undefined>;
type AttemptSummary = Omit<Attempt, "snapshot" | "responses"> & {
  title: string;
  kind: string;
};

const statusFilter = z.enum([
  "all",
  "attention",
  "in_progress",
  "reviewing",
  "completed",
]);
const typeFilter = z.enum(attemptTypes);
const instant = z.iso.datetime().refine((value) => !value.startsWith("0000-"));

function historyConditions(userId: string, query: HistoryQuery) {
  const status = query.status ?? "all";
  if (!statusFilter.safeParse(status).success)
    throw new HTTPException(400, { message: "Invalid status filter." });
  const type = query.type ?? null;
  if (type !== null && !typeFilter.safeParse(type).success)
    throw new HTTPException(400, { message: "Invalid attempt type." });
  const { setId, unlinked, startedFrom, startedBefore } = query;
  if (unlinked !== undefined && !["true", "false"].includes(unlinked))
    throw new HTTPException(400, {
      message: "Invalid unlinked attempt filter.",
    });
  if (setId !== undefined && unlinked === "true")
    throw new HTTPException(400, { message: "Choose one study set filter." });
  if (
    (startedFrom !== undefined && !instant.safeParse(startedFrom).success) ||
    (startedBefore !== undefined &&
      !instant.safeParse(startedBefore).success) ||
    (startedFrom &&
      startedBefore &&
      Date.parse(startedFrom) >= Date.parse(startedBefore))
  )
    throw new HTTPException(400, { message: "Invalid attempt date range." });

  const search = encodeStorage((query.search ?? "").slice(0, 200));
  return sql`
    a."userId" = ${userId}
    AND (${status} = 'all' OR a.status = ${status} OR (${status} = 'attention' AND a.status <> 'completed'))
    AND (${setId ?? null}::text IS NULL OR a."studySetId" = ${setId ?? null}::text)
    AND (NOT ${unlinked === "true"} OR a."studySetId" IS NULL)
    AND (${type}::text IS NULL OR CASE
      WHEN a."reviewMode" THEN 'spaced' ELSE a.snapshot->>'kind' END = ${type}::text)
    AND (${startedFrom ?? null}::text IS NULL OR a."startedAt" >= (${startedFrom ?? null}::timestamptz AT TIME ZONE 'UTC'))
    AND (${startedBefore ?? null}::text IS NULL OR a."startedAt" < (${startedBefore ?? null}::timestamptz AT TIME ZONE 'UTC'))
    ${
      search
        ? sql`
      AND (strpos(lower(a.snapshot->>'title'), lower(${search})) > 0 OR EXISTS (
        SELECT 1 FROM "StudySet" s ${joinCoOwner(userId)} WHERE s.id = a."studySetId" AND ${ownerAccess(userId)}
        AND strpos(lower(s.title), lower(${search})) > 0
      ))
    `
        : sql``
    }
  `;
}

export async function readHistory(
  db: Database,
  userId: string,
  query: HistoryQuery,
  page: number,
  grouped: boolean,
) {
  const conditions = historyConditions(userId, query);
  const window = sql`LIMIT ${LIST_PAGE_SIZE + 1} OFFSET ${page * LIST_PAGE_SIZE}`;
  const rows = grouped
    ? await db.$queryRaw<AttemptGroup[]>(sql`
        SELECT grouped."setId", s.title, grouped.count, grouped."latestStartedAt"
        FROM (
          SELECT a."studySetId" AS "setId", COUNT(*)::int AS count,
            MAX(a."startedAt") AS "latestStartedAt"
          FROM "Attempt" a WHERE ${conditions}
          GROUP BY a."studySetId"
          ORDER BY "latestStartedAt" DESC, "setId" ASC NULLS LAST
          ${window}
        ) grouped
        LEFT JOIN LATERAL (
          SELECT s.title FROM "StudySet" s ${joinCoOwner(userId)}
          WHERE s.id = grouped."setId" AND ${ownerAccess(userId)}
        ) s ON true
        ORDER BY grouped."latestStartedAt" DESC, grouped."setId" ASC NULLS LAST
      `)
    : await db.$queryRaw<AttemptSummary[]>(sql`
        SELECT a.id, a."userId", a."studySetId", a."sourceAttemptId", a.status,
          a.position, a.result, a."reviewMode", a.revision, a."startedAt", a."updatedAt",
          a."completedAt", a.snapshot->>'title' AS title, a.snapshot->>'kind' AS kind
        FROM "Attempt" a WHERE ${conditions}
        ORDER BY a."startedAt" DESC, a.id ASC
        ${window}
      `);
  return decodeStorage({
    items: rows.slice(0, LIST_PAGE_SIZE),
    hasMore: rows.length > LIST_PAGE_SIZE,
  });
}
