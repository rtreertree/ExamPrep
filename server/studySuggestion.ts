import { sqltag as sql } from "@prisma/client/runtime/wasm-compiler-edge";
import type { StudySuggestion } from "../shared/studySuggestion";
import type { Database } from "./db";
import { joinCoOwner, ownedSetIds, ownerLastStudiedAt } from "./setAccess";
import { decodeStorage } from "./storage";

export async function readStudySuggestion(
  db: Pick<Database, "$queryRaw">,
  userId: string,
) {
  const [row] = await db.$queryRaw<
    { suggestion: StudySuggestion | null }[]
  >(sql`
    WITH active_sets AS (
      SELECT s.id, s."updatedAt", ${ownerLastStudiedAt} AS studied,
        COALESCE(co.pinned, s.pinned) AS pinned
      FROM "StudySet" s ${joinCoOwner(userId)}
      WHERE s.id IN ${ownedSetIds(userId)} AND NOT COALESCE(co.archived, s.archived)
    ),
    unfinished AS (
      SELECT a.id FROM "Attempt" a JOIN active_sets s ON s.id = a."studySetId"
      WHERE a."userId" = ${userId} AND a.status IN ('in_progress', 'reviewing')
      ORDER BY a."updatedAt" DESC, a.id LIMIT 1
    )
    SELECT COALESCE(
      (
        SELECT jsonb_build_object(
          'type', 'resume', 'id', a.id, 'title', a.snapshot->>'title',
          'kind', a.snapshot->>'kind', 'status', a.status, 'position', a.position,
          'total', COALESCE(jsonb_array_length(a.snapshot->'questions'), jsonb_array_length(a.snapshot->'cards')),
          'pendingCount', a.result->'selfAssessed'->'pendingCount', 'reviewMode', a."reviewMode"
        )
        FROM unfinished JOIN "Attempt" a USING (id)
      ),
      (
        SELECT jsonb_build_object(
          'type', 'practice',
          'set', jsonb_build_object(
            'id', s.id, 'title', s.title, 'kind', s.kind,
            'count', COALESCE(jsonb_array_length(s.content->'questions'), jsonb_array_length(s.content->'cards'))
          )
        )
        FROM (
          SELECT id FROM active_sets
          ORDER BY studied DESC NULLS LAST, pinned DESC, "updatedAt" DESC, id LIMIT 1
        ) recommended JOIN "StudySet" s USING (id)
      )
    ) AS suggestion
  `);
  return decodeStorage(row?.suggestion ?? null);
}
